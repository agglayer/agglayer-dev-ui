// Builds a standalone, E2E-enabled static export of the dev-ui app for
// browser-mode load testing (DESIGN §8). The baked `agglayer-dev-ui-002`
// compose container is NOT E2E-enabled, so browser mode needs its own build:
// `NEXT_PUBLIC_E2E_ENABLED=true`, a throwaway default signer key (S03's
// window.__AGGLAYER_E2E_PRIVATE_KEY__ override supplies the REAL per-context
// key at runtime -- this build-time key is only ever the fallback), and
// `NEXT_PUBLIC_AGGKIT_PROXY` pinned to the loadtest config's own
// `aggkitProxyUrl`.
//
// Never touches the repo's committed root `config.json`: the generated
// devnet/testnet/mainnet app config is written to a throwaway temp file and
// fed to the existing `node ./scripts/syncPublicConfig.mjs` sync step via
// `DEV_UI_CONFIG_PATH` (docs/config.md's documented "sync from a config file
// outside the repo" mechanism) -- so only the gitignored `public/config.json`
// and `out/` are touched, exactly as an ordinary `pnpm run build` would.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { privateKeyToAccount } from 'viem/accounts';

import type { LoadtestConfig } from '../config/schema';

import { checkOperationalConstraints, parseLoadtestConfig } from '../config/schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../..');

// A fixed, well-known, unfunded throwaway key -- never used to sign
// anything of value. Fixed (not regenerated per build) so it never busts
// Next's persistent build cache across runs (S09 acceptance #4). S03's
// runtime override (window.__AGGLAYER_E2E_PRIVATE_KEY__, set per Playwright
// context) is what gives each browser-mode user its own real wallet; this
// value is only ever the build-time fallback for a page loaded with no
// override.
const THROWAWAY_E2E_PRIVATE_KEY =
  '0x5ceb091c43c8b38203106779d32e6350a0173394ea14ff2cb84c07460a635e07' as const;

// RFC 2606 reserved TLD -- guaranteed to never resolve, used as a syntactic
// (schema-satisfying) placeholder for the display-only fields
// (explorerUrl/iconUrl) the loadtest schema doesn't carry. Never rendered as
// anything but a broken link/image -- harmless for a load-test build, which
// exercises the bridging flow via `data-test-id` locators, not visuals.
const PLACEHOLDER_EXPLORER_URL = 'https://explorer.invalid/';
const PLACEHOLDER_ICON_URL = 'https://icon.invalid/token.svg';
const PLACEHOLDER_PROJECT_ID = 'LOADTEST-E2E-PLACEHOLDER';

// R22 (loadtest/REVIEW.md): the child `next build` process used to receive
// the ENTIRE parent environment (`{ ...process.env, ... }`) with
// `stdio: 'inherit'` — so any real secret an operator exported
// (`LOADTEST_MNEMONIC`, `LOADTEST_DEVNET_FUNDER_KEY`, any funder secretRef
// env var) was handed to a process that has no need for any of it, and
// `stdio: 'inherit'` means that child's own stdout/stderr bypass this
// tool's redaction entirely (`redactSecrets`/`redactError` only sit on the
// Node side). The residual risk is Next/Turbopack (or a transitive plugin)
// error-dumping `process.env` in a crash diagnostic — which bundlers do.
// This allowlists what the child actually needs (PATH/shell/Node/pnpm
// plumbing plus `NEXT_PUBLIC_*`, which is meant to be public by Next's own
// convention) instead of forwarding everything.
const ALLOWED_ENV_NAME_PATTERN = /^(NEXT_PUBLIC_|NODE_|NPM_|PNPM_|COREPACK_)/;
const ALLOWED_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CI',
  'PWD',
  'USER',
  'LOGNAME',
  // Read by `next build` / its telemetry, harmless to forward.
  'CI_JOB_ID',
  'GITHUB_ACTIONS'
];

/** Exported for tests. Never spread `process.env` wholesale into a child that doesn't need it (R22). */
export const allowlistedEnvForBuildChild = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV_NAME_PATTERN.test(key) || ALLOWED_ENV_NAMES.includes(key)) {
      out[key] = value;
    }
  }
  return out;
};

type RouteType = 'l1_to_l2' | 'l2_to_l1' | 'l2_to_l2';

// Mirrors app/utils/autoclaim.ts's getRouteType (and loadtest/config/
// deriveDevnet.ts's own copy of the same classification) -- keyed on the
// hop's source/destination network, not on chain key.
const getRouteType = (sourceNetworkId: number, destinationNetworkId: number): RouteType => {
  const sourceIsL1 = sourceNetworkId === 0;
  const destIsL1 = destinationNetworkId === 0;
  if (sourceIsL1 && !destIsL1) return 'l1_to_l2';
  if (!sourceIsL1 && destIsL1) return 'l2_to_l1';
  return 'l2_to_l2';
};

const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

interface AppAutoclaimEntry {
  expectedAutoclaim: boolean;
  waitForAutoclaimMs?: number;
}

// DESIGN §8: the generated config.json's `autoclaim` block must carry the
// SAME values as the loadtest config's own autoclaim map, or browser users'
// gate (useAutoclaimGate) and headless users' gate would use different
// waitMs and the two modes would not be comparable. The loadtest map is
// keyed per ring hop (chain-key pair); the app config is keyed per route
// TYPE (l1_to_l2/l2_to_l1/l2_to_l2) -- classify each hop and assert every
// hop that lands on the same route type agrees, rather than silently
// picking one.
const buildAppAutoclaim = (config: LoadtestConfig): Record<RouteType, AppAutoclaimEntry> => {
  const networkIdByKey = new Map(config.chains.map((chain) => [chain.key, chain.networkId]));
  const byRoute = new Map<RouteType, AppAutoclaimEntry>();

  for (let index = 0; index < config.ring.length - 1; index += 1) {
    const fromKey = config.ring[index];
    const toKey = config.ring[index + 1];
    const hopLabel = `${fromKey}->${toKey}`;
    const hopEntry = config.autoclaim[hopLabel];
    if (hopEntry === undefined) {
      throw new Error(`build-ui: ring hop "${hopLabel}" has no autoclaim entry`);
    }

    const routeType = getRouteType(networkIdByKey.get(fromKey)!, networkIdByKey.get(toKey)!);
    const appEntry: AppAutoclaimEntry = hopEntry.expected
      ? { expectedAutoclaim: true, waitForAutoclaimMs: hopEntry.waitMs }
      : { expectedAutoclaim: false };

    const existing = byRoute.get(routeType);
    if (existing !== undefined) {
      const matches =
        existing.expectedAutoclaim === appEntry.expectedAutoclaim &&
        existing.waitForAutoclaimMs === appEntry.waitForAutoclaimMs;
      if (!matches) {
        throw new Error(
          `build-ui: ring hop "${hopLabel}" classifies as route "${routeType}", which another ` +
            `ring hop already mapped to a different autoclaim entry ` +
            `(${JSON.stringify(existing)} vs ${JSON.stringify(appEntry)}) -- the app's autoclaim ` +
            'config is keyed per route type, not per hop, so this would silently pick one value.'
        );
      }
    } else {
      byRoute.set(routeType, appEntry);
    }
  }

  const ROUTE_TYPES: RouteType[] = ['l1_to_l2', 'l2_to_l1', 'l2_to_l2'];
  const result: Partial<Record<RouteType, AppAutoclaimEntry>> = {};
  for (const routeType of ROUTE_TYPES) {
    const entry = byRoute.get(routeType);
    if (entry !== undefined) result[routeType] = entry;
  }
  return result as Record<RouteType, AppAutoclaimEntry>;
};

interface AppChainConfig {
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  currency: { name: string; symbol: string; decimals: number };
  iconUrl: string;
  networkId: number;
  isTestnet: boolean;
  bridgeAddress?: string;
}

// Builds the app's config.json shape (config/configSchema.mjs's
// jsonConfigSchema) for exactly one mode -- the loadtest config's own `env`
// -- rather than trying to reconstruct mainnet/testnet/devnet placeholders
// for modes this run doesn't use. `configValidator.mjs`'s semantic check
// only requires ONE enabled mode with >=2 chainKeys and a config for
// `appModes.default`, so a single-mode config.json is a valid, minimal app
// config on its own.
const buildAppConfig = (config: LoadtestConfig): unknown => {
  // Ring order, deduped (the ring is closed: first === last).
  const chainKeysInOrder = Array.from(new Set(config.ring));
  const chainByKey = new Map(config.chains.map((chain) => [chain.key, chain]));

  const modeBridgeAddress = chainByKey.get(chainKeysInOrder[0])!.bridgeAddress;

  const chains: Record<string, AppChainConfig> = {};
  for (const key of chainKeysInOrder) {
    const chain = chainByKey.get(key)!;
    const entry: AppChainConfig = {
      id: chain.chainId,
      name: titleCase(chain.key),
      rpcUrl: chain.rpcUrl,
      explorerUrl: chain.explorerUrl || PLACEHOLDER_EXPLORER_URL,
      currency: {
        name: chain.nativeSymbol === 'ETH' ? 'Ether' : chain.nativeSymbol,
        symbol: chain.nativeSymbol,
        decimals: 18
      },
      iconUrl: PLACEHOLDER_ICON_URL,
      networkId: chain.networkId,
      isTestnet: config.env !== 'mainnet'
    };
    // Per-chain override only when this chain's bridge address genuinely
    // differs from the mode default -- keeps the common case (every chain
    // sharing one deterministic address, true of every ring the schema
    // accepts today) free of redundant per-chain fields.
    if (chain.bridgeAddress !== modeBridgeAddress) {
      entry.bridgeAddress = chain.bridgeAddress;
    }
    chains[key] = entry;
  }

  const etaMinutes = config.env === 'devnet' ? 1 : 180;

  return {
    walletConnect: { projectId: PLACEHOLDER_PROJECT_ID },
    externalLinks: { privacyPolicy: '', termsOfUse: '', contactSupport: '' },
    chains,
    appModes: {
      default: config.env,
      configs: {
        [config.env]: {
          label: titleCase(config.env),
          bridgeAddress: modeBridgeAddress,
          etaL1Minutes: etaMinutes,
          etaL2Minutes: etaMinutes,
          aggkitProxy: config.aggkitProxyUrl,
          chainKeys: chainKeysInOrder,
          defaultFromChainKey: chainKeysInOrder[0],
          defaultToChainKey: chainKeysInOrder[1]
        }
      }
    }
  };
};

export interface BuildUiOptions {
  // Path to loadtest.config.json, resolved against process.cwd() -- same
  // convention every other CLI command uses.
  configPath?: string;
  repoRoot?: string;
}

export interface BuildUiResult {
  outDir: string;
  generatedConfigPath: string;
  appConfig: unknown;
  aggkitProxyUrl: string;
  env: LoadtestConfig['env'];
  durationMs: number;
}

export const buildUi = async (options: BuildUiOptions = {}): Promise<BuildUiResult> => {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const configPath = path.resolve(process.cwd(), options.configPath ?? 'loadtest.config.json');

  const raw = fs.readFileSync(configPath, 'utf8');
  const config = parseLoadtestConfig(JSON.parse(raw) as unknown);

  // parseLoadtestConfig alone does not catch a placeholder aggkitProxyUrl --
  // checkOperationalConstraints must be called explicitly (DESIGN §2's
  // split between schema-level and operational checks; mirrors cli.ts's own
  // loadConfigForCommand).
  const operationalIssues = checkOperationalConstraints(config);
  if (operationalIssues.length > 0) {
    throw new Error(
      `build-ui: loadtest config validation failed:\n${operationalIssues.map((line) => `- ${line}`).join('\n')}`
    );
  }

  // `autoclaim` is a top-level config.json field, not per-mode (config/
  // configSchema.mjs's jsonConfigSchema).
  const appConfig = {
    ...(buildAppConfig(config) as Record<string, unknown>),
    autoclaim: buildAppAutoclaim(config)
  };

  // Validate against the app's own real schema+semantic checks before
  // writing anything to disk -- the same validator scripts/syncPublicConfig.mjs
  // runs, just invoked directly so a bad generated config fails loudly here
  // rather than surfacing as an obscure sync-step error.
  const configValidatorUrl = pathToFileURL(path.join(repoRoot, 'config/configValidator.mjs')).href;
  const { parseConfigOrThrow } = (await import(configValidatorUrl)) as {
    parseConfigOrThrow: (config: unknown, options?: { sourceName?: string }) => unknown;
  };
  parseConfigOrThrow(appConfig, { sourceName: 'generated E2E config.json (build-ui)' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agglayer-loadtest-ui-'));
  const generatedConfigPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(generatedConfigPath, `${JSON.stringify(appConfig, null, 2)}\n`);

  const throwawayAccount = privateKeyToAccount(THROWAWAY_E2E_PRIVATE_KEY);

  const buildEnv: NodeJS.ProcessEnv = {
    ...allowlistedEnvForBuildChild(process.env),
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    // Opts into next.config.ts's experimental Turbopack build cache -- see
    // that file's comment. Scoped to this command only via this env var, so
    // no other build path is affected.
    LOADTEST_UI_BUILD: 'true',
    DEV_UI_CONFIG_PATH: generatedConfigPath,
    NEXT_PUBLIC_E2E_ENABLED: 'true',
    NEXT_PUBLIC_E2E_PRIVATE_KEY: THROWAWAY_E2E_PRIVATE_KEY,
    NEXT_PUBLIC_E2E_WALLET_ADDRESS: throwawayAccount.address,
    NEXT_PUBLIC_AGGKIT_PROXY: config.aggkitProxyUrl
  };

  const startedAt = Date.now();
  try {
    // Reuses the repo's own `build` script (`node ./scripts/syncPublicConfig.mjs
    // && next build`) rather than reimplementing it -- `syncPublicConfig.mjs`
    // reads DEV_UI_CONFIG_PATH itself (see its own header comment) and copies
    // our generated file to the gitignored public/config.json, which `next
    // build`'s static-export step then carries into out/config.json
    // byte-identically. `build:production` is NOT used here: it clobbers
    // .env.local, which this checkout deliberately keeps aside as
    // .env.local.bak.
    execFileSync('pnpm', ['run', 'build'], {
      cwd: repoRoot,
      env: buildEnv,
      stdio: 'inherit'
    });
  } catch (error) {
    throw new Error(
      `build-ui: "pnpm run build" failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const durationMs = Date.now() - startedAt;

  const outDir = path.join(repoRoot, 'out');
  const outConfigPath = path.join(outDir, 'config.json');
  if (!fs.existsSync(outConfigPath)) {
    throw new Error(`build-ui: expected ${outConfigPath} to exist after "pnpm run build"`);
  }

  return {
    outDir,
    generatedConfigPath,
    appConfig,
    aggkitProxyUrl: config.aggkitProxyUrl,
    env: config.env,
    durationMs
  };
};

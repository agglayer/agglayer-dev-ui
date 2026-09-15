// Derives loadtest.config.json for the compose devnet from
// `tests/devnet/summary.json` (topology: chain ids, network ids, proxy URL,
// bridge address, ERC20 address, funded key) and
// `config/config.ci.devnet.json` (the `autoclaim` map, mapped onto each ring
// hop through the same `getRouteType` classification the app uses —
// app/utils/autoclaim.ts:11-17). Normative worked example: DESIGN §2.3;
// field provenance: DESIGN §2.3's table immediately below it.
//
// Never hardcodes a value that summary.json/config.ci.devnet.json can
// supply — the two exceptions are the ring shape itself (L1 -> L2A -> L2B ->
// L1, since summary.json only ever describes this fixed 3-chain devnet
// topology) and the loadtest-owned fields DESIGN §2.3 attributes to no
// upstream source (`uiBaseUrl`, `users.total`/`browser`, `load.*`,
// `browser.*`).
import fs from 'node:fs';
import path from 'node:path';

// RouteType classification mirrors app/utils/autoclaim.ts's getRouteType:
// keyed on the hop's recording (source) and destination network, not on
// asset origin.
type RouteType = 'l1_to_l2' | 'l2_to_l1' | 'l2_to_l2';

const getRouteType = (sourceNetworkId: number, destinationNetworkId: number): RouteType => {
  const sourceIsL1 = sourceNetworkId === 0;
  const destIsL1 = destinationNetworkId === 0;
  if (sourceIsL1 && !destIsL1) return 'l1_to_l2';
  if (!sourceIsL1 && destIsL1) return 'l2_to_l1';
  return 'l2_to_l2';
};

// app/config.ts:22-27's DEFAULT_AUTOCLAIM_CONFIG — the fallback used for any
// route config/config.ci.devnet.json's `autoclaim` block omits.
const DEFAULT_AUTOCLAIM_CONFIG: Record<
  RouteType,
  { expectedAutoclaim: boolean; waitForAutoclaimMs?: number }
> = {
  l1_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 60_000 },
  l2_to_l1: { expectedAutoclaim: false },
  l2_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 120_000 }
};

interface DevnetSummary {
  erc20_address: string;
  chain_ids: { l1: number; l2_001: number; l2_002: number };
  network_ids: { l1: number; l2_001: number; l2_002: number };
  proxy: { host_port: number };
  networks: {
    l1: { contracts: { bridge: string } };
  };
  accounts: {
    e2e_wallet: { private_key: string };
  };
}

interface RouteAutoclaimConfig {
  expectedAutoclaim: boolean;
  waitForAutoclaimMs?: number;
}

interface CiDevnetConfig {
  autoclaim?: Partial<Record<RouteType, RouteAutoclaimConfig>>;
}

export interface DeriveDevnetOptions {
  repoRoot: string;
  summaryPath?: string;
  ciConfigPath?: string;
  env?: Record<string, string | undefined>;
}

export interface DeriveDevnetResult {
  config: unknown;
  // A one-line reminder of where the funder's actual secret value lives —
  // derive-devnet writes only a secretRef, per DESIGN §2.2, and never the
  // key itself.
  hint: string;
}

const readJsonFile = (filePath: string): unknown => {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `could not read "${filePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return JSON.parse(raw);
};

export const deriveDevnetConfig = (options: DeriveDevnetOptions): DeriveDevnetResult => {
  const env = options.env ?? process.env;
  const summaryPath =
    options.summaryPath ?? path.join(options.repoRoot, 'tests/devnet/summary.json');
  const ciConfigPath =
    options.ciConfigPath ?? path.join(options.repoRoot, 'config/config.ci.devnet.json');

  const summary = readJsonFile(summaryPath) as DevnetSummary;
  const ciConfig = readJsonFile(ciConfigPath) as CiDevnetConfig;

  // DESIGN §2.3 provenance: aggkitProxyUrl's host port is overridden by
  // DEVNET_PROXY_PORT (via-proxy route, default from summary.json's
  // `.proxy.host_port`, itself defaulting to 8555); AGGKIT_PROXY_PORT
  // selects the direct alternative (no haproxy, no `/aggkitapi` prefix)
  // when DEVNET_PROXY_PORT is not also set.
  const devnetProxyPort = env.DEVNET_PROXY_PORT;
  const aggkitProxyPortEnv = env.AGGKIT_PROXY_PORT;
  const defaultProxyPort = String(summary.proxy.host_port);
  const resolvedProxyPort = devnetProxyPort ?? defaultProxyPort;

  const aggkitProxyUrl =
    aggkitProxyPortEnv !== undefined && devnetProxyPort === undefined
      ? `http://127.0.0.1:${aggkitProxyPortEnv}`
      : `http://127.0.0.1:${resolvedProxyPort}/aggkitapi`;

  const rpcBase = `http://127.0.0.1:${resolvedProxyPort}`;
  const bridgeAddress = summary.networks.l1.contracts.bridge;

  const chains = [
    {
      key: 'L1',
      chainId: summary.chain_ids.l1,
      networkId: summary.network_ids.l1,
      rpcUrl: `${rpcBase}/l1rpc`,
      bridgeAddress,
      explorerUrl: ''
    },
    {
      key: 'L2A',
      chainId: summary.chain_ids.l2_001,
      networkId: summary.network_ids.l2_001,
      rpcUrl: `${rpcBase}/l2rpc-001`,
      bridgeAddress,
      explorerUrl: ''
    },
    {
      key: 'L2B',
      chainId: summary.chain_ids.l2_002,
      networkId: summary.network_ids.l2_002,
      rpcUrl: `${rpcBase}/l2rpc-002`,
      bridgeAddress,
      explorerUrl: ''
    }
  ];

  const ring = ['L1', 'L2A', 'L2B', 'L1'];

  const networkIdByKey = new Map(chains.map((chain) => [chain.key, chain.networkId]));

  const autoclaimForRoute = (routeType: RouteType): { expected: boolean; waitMs?: number } => {
    const routeConfig = ciConfig.autoclaim?.[routeType] ?? DEFAULT_AUTOCLAIM_CONFIG[routeType];
    return routeConfig.expectedAutoclaim
      ? { expected: true, waitMs: routeConfig.waitForAutoclaimMs }
      : { expected: false };
  };

  const autoclaim: Record<string, { expected: boolean; waitMs?: number }> = {};
  for (let index = 0; index < ring.length - 1; index += 1) {
    const fromKey = ring[index];
    const toKey = ring[index + 1];
    const routeType = getRouteType(networkIdByKey.get(fromKey)!, networkIdByKey.get(toKey)!);
    autoclaim[`${fromKey}->${toKey}`] = autoclaimForRoute(routeType);
  }

  // A plain object matching the schema's PRE-parse (defaultable) shape, not
  // the fully-resolved `LoadtestConfig` type — the CLI re-parses this
  // through `parseLoadtestConfig` before writing it out, which is what
  // supplies `browser`/`timeouts`/`gas`/`output`'s defaults (notably
  // `output.dir`'s dynamic ISO-8601-basic timestamp, DESIGN §2.1) rather
  // than this function inventing its own.
  const config = {
    env: 'devnet',
    uiBaseUrl: 'http://127.0.0.1:3100',
    aggkitProxyUrl,
    chains,
    ring,
    autoclaim,
    assets: [
      { kind: 'eth', amount: '0.001', decimals: 18 },
      {
        kind: 'erc20',
        address: summary.erc20_address,
        originNetworkId: summary.network_ids.l1,
        amount: '0.01',
        decimals: 18
      }
    ],
    users: {
      total: 400,
      browser: 100,
      wallets: { mnemonicRef: { env: 'LOADTEST_MNEMONIC' }, startIndex: 0 },
      funder: {
        privateKeyRef: { env: 'LOADTEST_DEVNET_FUNDER_KEY' },
        gasPerChain: { L1: '0.05', L2A: '0.05', L2B: '0.05' },
        // No explicit assetTopUp: `wallets/fund.ts`'s `defaultAssetTopUp`
        // derives it from `load.bridgesPerMinutePerUser` /
        // `durationMinutes` below (S16/A1 — a flat `amount × 4` here sized
        // every user for exactly 4 erc20 bridges regardless of run length,
        // so the 5th+ lap underflowed on any run longer than that; see
        // VALIDATION-1.md A1).
        maxTotalSpend: { L1: '500', L2A: '500', L2B: '500' }
      },
      devnetFunding: 'anvil_setBalance'
    },
    load: {
      bridgesPerMinutePerUser: 2,
      durationMinutes: 30,
      rampUpSeconds: 60,
      maxInflightLapsPerUser: 3
    },
    // S16/A3: `contextsPerBrowser: 25` with `users.browser: 20` produced
    // `slotCount = ceil(20/25) = 1` — every browser user ran in ONE
    // Chromium, so one crash took out all of them (VALIDATION-1.md A3).
    // `config/schema.ts` now caps `contextsPerBrowser` at 8 for exactly
    // this reason.
    browser: { contextsPerBrowser: 8, headless: true, trace: false, recycleContextAfterLaps: 10 },
    // S10 attempt #1 (retry, DESIGN §3.3): measured L2A->L2B on this devnet
    // reached claimed=true at ~638s against a 600_000ms budget (both
    // surviving harness users timed out at ~607s, then the orchestrator
    // observed CLAIMED 31s later). Cause: MinimumNewCertificateInterval =
    // 5m, and an L2->L2 hop needs network 1 to certify *and settle* before
    // network 2 imports, so a bridge landing just after a certificate
    // window waits for the next one -- across two hops. Raised with ~40%
    // headroom over the measured 638s (worst case ~2 cert windows +
    // settlement ~= 720s). Invariant preserved: readyToClaimMs < hopMs <
    // lapMs (asserted in S12).
    timeouts: {
      txReceiptMs: 60_000,
      appearsInActivityMs: 60_000,
      readyToClaimMs: 900_000,
      claimedMs: 900_000,
      hopMs: 1_200_000,
      lapMs: 3_600_000,
      pageLoadMs: 30_000,
      walletConnectMs: 15_000
    },
    gas: { bridgeGasOffset: 300_000 }
  };

  // DESIGN §2.2: name the value to export, never print or copy the key
  // itself into the generated file (or into this hint).
  const hint =
    `hint: export LOADTEST_DEVNET_FUNDER_KEY=<value of "accounts.e2e_wallet.private_key" in ${path.relative(options.repoRoot, summaryPath)}> ` +
    '— the funder key is referenced by env var name only; it is never written into loadtest.config.json.';

  return { config, hint };
};

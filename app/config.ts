import type { AppChain, AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/appMode';
import type {
  AutoclaimConfig,
  AutoclaimRouteConfig,
  ChainEntry,
  JsonAggkitBridgeApis,
  JsonConfig,
  RouteType
} from '@/app/types/config';
import type { Chain } from 'wagmi/chains';

import { buildWagmiChain, createChainEntry, toNonEmptyChainArray } from '@/app/utils/config';
import { APP_MODES } from '@/config/appModes.mjs';
import { resolveAggkitBridgeApiUrl } from '@/config/configLoader.mjs';
import { aggkitBridgeApisSchema } from '@/config/configSchema.mjs';

// Per-route autoclaim UX defaults. config.json's optional `autoclaim` block
// overrides these per route; any omitted route (or omitted waitForAutoclaimMs)
// falls back here. Wait periods are measured from when a deposit first becomes
// READY_TO_CLAIM (see useAutoclaimGate). Config-independent, so this stays a
// module-scope constant.
export const DEFAULT_AUTOCLAIM_CONFIG: AutoclaimConfig = {
  l1_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 60_000 },
  l2_to_l1: { expectedAutoclaim: false, waitForAutoclaimMs: 0 },
  l2_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 120_000 }
};

// Add custom RPC URLs on a per-chain basis as needed. Config-independent, so
// this stays a module-scope constant.
export const customRpcUrls: Record<string, { url: string }[]> = {
  // Example:
  // 'eip155:1234': [{ url: 'https://rpc.example.org' }],
};

export type ResolvedAppConfig = {
  autoclaim: AutoclaimConfig;
  externalLinks: Readonly<{
    PRIVACY_POLICY: string;
    TERMS_OF_USE: string;
    CONTACT_SUPPORT: string;
  }>;
  chainRegistry: Record<string, ChainEntry>;
  defaultAppMode: AppMode;
  appModeConfig: Record<AppMode, AppModeConfig>;
  allWagmiChains: readonly [Chain, ...Chain[]];
  defaultWagmiChain: Chain;
};

// NEXT_PUBLIC_AGGKIT_BRIDGE_APIS is inlined by Next at build time, so it can
// only ever carry a build-environment value (dev / Cloudflare) -- it is
// structurally absent from a published image (design.md §6). window is only
// available once this runs in the browser (AppConfigGate's effect, or a
// Playwright-driven page); the Node bootstrap (tests/e2e/appConfig.ts) has no
// window, so a relative override value there resolves to `undefined` and
// resolveAggkitBridgeApiUrl throws loudly rather than silently misresolving.
const resolveEnvOrigin = (): string | undefined =>
  typeof window === 'undefined' ? undefined : window.location.origin;

// Devnet's aggkit REST port is ephemeral per enclave recreate (kurtosis assigns
// it at runtime); this env var lets a bring-up script inject the live proxy
// URL without editing config.json. Keyed by L2 networkId, same shape as
// config.json's per-mode `aggkitBridgeApis`.
const resolveAggkitBridgeApisOverride = (): JsonAggkitBridgeApis | undefined => {
  const envOverride = process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS?.trim();
  if (!envOverride) return undefined;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(envOverride);
  } catch {
    throw new Error('APP_CONFIG_INVALID: NEXT_PUBLIC_AGGKIT_BRIDGE_APIS must be valid JSON');
  }

  const parsed = aggkitBridgeApisSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      'APP_CONFIG_INVALID: NEXT_PUBLIC_AGGKIT_BRIDGE_APIS must be a JSON object of ' +
        'networkId -> url'
    );
  }

  const origin = resolveEnvOrigin();
  return Object.fromEntries(
    Object.entries(parsed.data).map(([networkId, url]) => [
      networkId,
      resolveAggkitBridgeApiUrl(url, origin, false)
    ])
  );
};

const resolveAggkitBridgeApis = (
  modeAggkitBridgeApis: JsonAggkitBridgeApis,
  aggkitBridgeApisOverride: JsonAggkitBridgeApis | undefined
): Record<number, string> => {
  const merged = { ...modeAggkitBridgeApis, ...aggkitBridgeApisOverride };
  return Object.fromEntries(
    Object.entries(merged).map(([networkId, url]) => [Number(networkId), url])
  );
};

const resolveAutoclaimConfig = (overrides: JsonConfig['autoclaim']): AutoclaimConfig => {
  const safeOverrides = overrides ?? {};
  const resolveRoute = (route: RouteType): AutoclaimRouteConfig => {
    const override = safeOverrides[route];
    if (!override) return DEFAULT_AUTOCLAIM_CONFIG[route];
    return {
      expectedAutoclaim: override.expectedAutoclaim,
      waitForAutoclaimMs:
        override.waitForAutoclaimMs ?? DEFAULT_AUTOCLAIM_CONFIG[route].waitForAutoclaimMs
    };
  };
  return {
    l1_to_l2: resolveRoute('l1_to_l2'),
    l2_to_l1: resolveRoute('l2_to_l1'),
    l2_to_l2: resolveRoute('l2_to_l2')
  };
};

const toEnabledChains = (chains: AppChain[]): EnabledAppModeConfig['chains'] | undefined => {
  const [first, second, ...rest] = chains;
  if (!first || !second) return undefined;
  return [first, second, ...rest];
};

const buildModeConfig = (
  modeKey: string,
  configJson: JsonConfig,
  chainRegistry: Record<string, ChainEntry>,
  aggkitBridgeApisOverride: JsonAggkitBridgeApis | undefined
): AppModeConfig => {
  const modeConfigJson = configJson.appModes.configs[modeKey];
  if (!modeConfigJson) {
    return { label: modeKey, bridgeAddress: '', aggkitBridgeApis: {}, chains: [] };
  }

  const chains = modeConfigJson.chainKeys.map((chainKey) => chainRegistry[chainKey].app);

  const base = {
    label: modeConfigJson.label,
    bridgeAddress: modeConfigJson.bridgeAddress,
    aggkitBridgeApis: resolveAggkitBridgeApis(
      modeConfigJson.aggkitBridgeApis,
      aggkitBridgeApisOverride
    )
  };

  const enabledChains = toEnabledChains(chains);
  if (!enabledChains) {
    return { ...base, chains: [] };
  }

  const [primaryChain, secondaryChain] = enabledChains;
  const defaultFromChainId = modeConfigJson.defaultFromChainKey
    ? chainRegistry[modeConfigJson.defaultFromChainKey].app.id
    : primaryChain.id;
  const defaultToChainId = modeConfigJson.defaultToChainKey
    ? chainRegistry[modeConfigJson.defaultToChainKey].app.id
    : secondaryChain.id;

  return {
    ...base,
    chains: enabledChains,
    defaultFromChainId,
    defaultToChainId
  };
};

const resolveDefaultWagmiChain = (
  defaultAppMode: AppMode,
  appModeConfig: Record<AppMode, AppModeConfig>,
  allWagmiChains: readonly [Chain, ...Chain[]]
): Chain => {
  const defaultModeConfig = appModeConfig[defaultAppMode];
  const defaultFromChainId =
    'defaultFromChainId' in defaultModeConfig ? defaultModeConfig.defaultFromChainId : undefined;
  const defaultChainId = defaultFromChainId ?? defaultModeConfig.chains[0]?.id;

  if (defaultChainId === undefined) {
    return allWagmiChains[0];
  }

  return allWagmiChains.find((chain) => chain.id === defaultChainId) ?? allWagmiChains[0];
};

/**
 * Pure function of a schema-valid, URL-normalized JsonConfig (see
 * config/configLoader.mjs) plus process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS
 * (unchanged precedence: build-time env shallow-merges over the served
 * config, per mode -- design.md §6.2). Exported separately from
 * `initAppConfig` so tests can exercise the derivations and the precedence
 * rule without touching the module store.
 */
export const buildAppConfig = (configJson: JsonConfig): ResolvedAppConfig => {
  const aggkitBridgeApisOverride = resolveAggkitBridgeApisOverride();

  const chainRegistry: Record<string, ChainEntry> = Object.fromEntries(
    Object.entries(configJson.chains).map(([chainKey, chainConfigJson]) => [
      chainKey,
      createChainEntry({
        wagmi: buildWagmiChain(chainConfigJson),
        icon: chainConfigJson.iconUrl,
        networkId: chainConfigJson.networkId,
        isTestnet: chainConfigJson.isTestnet,
        eta: chainConfigJson.eta
      })
    ])
  );

  const defaultAppMode: AppMode = configJson.appModes.default;

  const appModeConfig: Record<AppMode, AppModeConfig> = Object.fromEntries(
    APP_MODES.map((mode) => [
      mode,
      buildModeConfig(mode, configJson, chainRegistry, aggkitBridgeApisOverride)
    ])
  ) as Record<AppMode, AppModeConfig>;

  const allWagmiChains: readonly [Chain, ...Chain[]] = toNonEmptyChainArray(
    Object.values(chainRegistry).map((entry) => entry.wagmi)
  );

  const defaultWagmiChain = resolveDefaultWagmiChain(defaultAppMode, appModeConfig, allWagmiChains);

  return {
    autoclaim: resolveAutoclaimConfig(configJson.autoclaim),
    externalLinks: Object.freeze({
      PRIVACY_POLICY: configJson.externalLinks.privacyPolicy,
      TERMS_OF_USE: configJson.externalLinks.termsOfUse,
      CONTACT_SUPPORT: configJson.externalLinks.contactSupport
    }),
    chainRegistry,
    defaultAppMode,
    appModeConfig,
    allWagmiChains,
    defaultWagmiChain
  };
};

// ---- store ----
// Populated once by AppConfigGate (browser) or tests/e2e/appConfig.ts (Node),
// before any consumer render/call can observe it. See design.md §7.1: a
// module store, not a React context -- app/utils/appMode.ts is a non-React
// pure module, and the same accessors must serve Node callers too. Config is
// immutable for the lifetime of the page (design.md §8): no re-fetch, no live
// reconfiguration.
let appConfig: ResolvedAppConfig | undefined;

/** Builds, stores, and returns the resolved config. */
export const initAppConfig = (configJson: JsonConfig): ResolvedAppConfig => {
  appConfig = buildAppConfig(configJson);
  return appConfig;
};

/** Tests only: clears the store so a fresh initAppConfig call can be asserted. */
export const resetAppConfig = (): void => {
  appConfig = undefined;
};

export const isAppConfigReady = (): boolean => appConfig !== undefined;

export const getAppConfig = (): ResolvedAppConfig => {
  if (!appConfig) {
    throw new Error('APP_CONFIG_NOT_LOADED: app config was read before AppConfigGate resolved it');
  }
  return appConfig;
};

// ---- narrow accessors: one per pre-refactor export, so call sites are
// one-token edits (identifier -> accessor call) ----
export const getAutoclaimConfig = (): AutoclaimConfig => getAppConfig().autoclaim;
export const getExternalLinks = (): ResolvedAppConfig['externalLinks'] =>
  getAppConfig().externalLinks;
export const getAppModeConfig = (): Record<AppMode, AppModeConfig> => getAppConfig().appModeConfig;
export const getDefaultAppMode = (): AppMode => getAppConfig().defaultAppMode;
export const getAllWagmiChains = (): readonly [Chain, ...Chain[]] => getAppConfig().allWagmiChains;
export const getDefaultWagmiChain = (): Chain => getAppConfig().defaultWagmiChain;

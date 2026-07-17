import type { AppChain, AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/appMode';
import type {
  AutoclaimConfig,
  AutoclaimRouteConfig,
  ChainEntry,
  JsonAggkitBridgeApis,
  RouteType
} from '@/app/types/config';
import type { Chain } from 'wagmi/chains';

import { buildWagmiChain, createChainEntry, toNonEmptyChainArray } from '@/app/utils/config';
import rawJsonConfig from '@/config.json';
import { APP_MODES } from '@/config/appModes.mjs';
import { aggkitBridgeApisSchema } from '@/config/configSchema.mjs';
import { parseConfigOrThrow } from '@/config/configValidator.mjs';

const configJson = parseConfigOrThrow(rawJsonConfig, { sourceName: 'config.json' });

// Per-route autoclaim UX defaults. config.json's optional `autoclaim` block
// overrides these per route; any omitted route (or omitted waitForAutoclaimMs)
// falls back here. Wait periods are measured from when a deposit first becomes
// READY_TO_CLAIM (see useAutoclaimGate).
export const DEFAULT_AUTOCLAIM_CONFIG: AutoclaimConfig = {
  l1_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 60_000 },
  l2_to_l1: { expectedAutoclaim: false, waitForAutoclaimMs: 0 },
  l2_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 120_000 }
};

export const AUTOCLAIM_CONFIG: AutoclaimConfig = (() => {
  const overrides = configJson.autoclaim ?? {};
  const resolveRoute = (route: RouteType): AutoclaimRouteConfig => {
    const override = overrides[route];
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
})();

// Devnet's aggkit REST port is ephemeral per enclave recreate (kurtosis assigns
// it at runtime); this env var lets a bring-up script inject the live proxy
// URL without editing config.json. Keyed by L2 networkId, same shape as
// config.json's per-mode `aggkitBridgeApis` (design.md §6.2).
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

  return parsed.data;
};

const aggkitBridgeApisOverride = resolveAggkitBridgeApisOverride();

const resolveAggkitBridgeApis = (
  modeAggkitBridgeApis: JsonAggkitBridgeApis
): Record<number, string> => {
  const merged = { ...modeAggkitBridgeApis, ...aggkitBridgeApisOverride };
  return Object.fromEntries(
    Object.entries(merged).map(([networkId, url]) => [Number(networkId), url])
  );
};

// Add custom RPC URLs on a per-chain basis as needed.
export const customRpcUrls: Record<string, { url: string }[]> = {
  // Example:
  // 'eip155:1234': [{ url: 'https://rpc.example.org' }],
};

export const EXTERNAL_LINKS = Object.freeze({
  PRIVACY_POLICY: configJson.externalLinks.privacyPolicy,
  TERMS_OF_USE: configJson.externalLinks.termsOfUse,
  CONTACT_SUPPORT: configJson.externalLinks.contactSupport
});

const CHAIN_REGISTRY: Record<string, ChainEntry> = Object.fromEntries(
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

export const DEFAULT_APP_MODE: AppMode = configJson.appModes.default;

const toEnabledChains = (chains: AppChain[]): EnabledAppModeConfig['chains'] | undefined => {
  const [first, second, ...rest] = chains;
  if (!first || !second) return undefined;
  return [first, second, ...rest];
};

const buildModeConfig = (modeKey: string): AppModeConfig => {
  const modeConfigJson = configJson.appModes.configs[modeKey];
  if (!modeConfigJson) {
    return { label: modeKey, bridgeAddress: '', aggkitBridgeApis: {}, chains: [] };
  }

  const chains = modeConfigJson.chainKeys.map((chainKey) => CHAIN_REGISTRY[chainKey].app);

  const base = {
    label: modeConfigJson.label,
    bridgeAddress: modeConfigJson.bridgeAddress,
    aggkitBridgeApis: resolveAggkitBridgeApis(modeConfigJson.aggkitBridgeApis)
  };

  const enabledChains = toEnabledChains(chains);
  if (!enabledChains) {
    return { ...base, chains: [] };
  }

  const [primaryChain, secondaryChain] = enabledChains;
  const defaultFromChainId = modeConfigJson.defaultFromChainKey
    ? CHAIN_REGISTRY[modeConfigJson.defaultFromChainKey].app.id
    : primaryChain.id;
  const defaultToChainId = modeConfigJson.defaultToChainKey
    ? CHAIN_REGISTRY[modeConfigJson.defaultToChainKey].app.id
    : secondaryChain.id;

  return {
    ...base,
    chains: enabledChains,
    defaultFromChainId,
    defaultToChainId
  };
};

export const APP_MODE_CONFIG: Record<AppMode, AppModeConfig> = Object.fromEntries(
  APP_MODES.map((mode) => [mode, buildModeConfig(mode)])
) as Record<AppMode, AppModeConfig>;

export const ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]] = toNonEmptyChainArray(
  Object.values(CHAIN_REGISTRY).map((entry) => entry.wagmi)
);

const getDefaultWagmiChain = (): Chain => {
  const defaultModeConfig = APP_MODE_CONFIG[DEFAULT_APP_MODE];
  const defaultFromChainId =
    'defaultFromChainId' in defaultModeConfig ? defaultModeConfig.defaultFromChainId : undefined;
  const defaultChainId = defaultFromChainId ?? defaultModeConfig.chains[0]?.id;

  if (defaultChainId === undefined) {
    return ALL_WAGMI_CHAINS[0];
  }

  return ALL_WAGMI_CHAINS.find((chain) => chain.id === defaultChainId) ?? ALL_WAGMI_CHAINS[0];
};

export const DEFAULT_WAGMI_CHAIN: Chain = getDefaultWagmiChain();

import type { Chain } from 'wagmi/chains';
import { buildWagmiChain, createChainEntry, toNonEmptyChainArray, toProofApiUrl } from '@/app/utils/config';
import type { AppChain, AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/appMode';
import type { ChainEntry } from '@/app/types/config';
import rawJsonConfig from '@/config.json';
import { parseConfigOrThrow } from '@/config/configValidator.mjs';
import { APP_MODES } from '@/config/appModes.mjs';

const configJson = parseConfigOrThrow(rawJsonConfig, { sourceName: 'config.json' });

const resolveBridgeHubApiBaseUrl = (): string => {
  const envOverride = process.env.NEXT_PUBLIC_BRIDGE_HUB_API?.trim();
  const configuredBaseUrl = envOverride && envOverride.length > 0 ? envOverride : configJson.bridgeHubApiBaseUrl;

  try {
    return new URL(configuredBaseUrl).toString().replace(/\/+$/, '');
  } catch {
    throw new Error('APP_CONFIG_INVALID: NEXT_PUBLIC_BRIDGE_HUB_API must be a valid URL');
  }
};

const bridgeHubApiBaseUrl = resolveBridgeHubApiBaseUrl();

// Add custom RPC URLs on a per-chain basis as needed.
export const customRpcUrls: Record<string, { url: string }[]> = {
  // Example:
  // 'eip155:1234': [{ url: 'https://rpc.example.org' }],
};

export const EXTERNAL_LINKS = Object.freeze({
  PRIVACY_POLICY: configJson.externalLinks.privacyPolicy,
  TERMS_OF_USE: configJson.externalLinks.termsOfUse,
  CONTACT_SUPPORT: configJson.externalLinks.contactSupport,
});

const CHAIN_REGISTRY: Record<string, ChainEntry> = Object.fromEntries(
  Object.entries(configJson.chains).map(([chainKey, chainConfigJson]) => [
    chainKey,
    createChainEntry({
      wagmi: buildWagmiChain(chainConfigJson),
      icon: chainConfigJson.iconUrl,
      networkId: chainConfigJson.networkId,
      isTestnet: chainConfigJson.isTestnet,
      eta: chainConfigJson.eta,
    }),
  ]),
);

const defaultModeKey = configJson.appModes.default;
export const DEFAULT_APP_MODE: AppMode = defaultModeKey as AppMode;

const toEnabledChains = (chains: AppChain[]): EnabledAppModeConfig['chains'] | undefined => {
  const [first, second, ...rest] = chains;
  if (!first || !second) return undefined;
  return [first, second, ...rest];
};

type DefaultChainKeyField = 'defaultFromChainKey' | 'defaultToChainKey';

const toModeChainEntriesByKey = (modeKey: string, chainKeys: string[]): Map<string, ChainEntry> =>
  new Map(
    chainKeys.map((chainKey) => {
      const chainEntry = CHAIN_REGISTRY[chainKey];
      if (!chainEntry) {
        throw new Error(
          `APP_CONFIG_INVALID: appModes.configs.${modeKey}.chainKeys includes unknown chain key "${chainKey}"`,
        );
      }
      return [chainKey, chainEntry] as const;
    }),
  );

const toDefaultChainId = (params: {
  modeKey: string;
  fieldName: DefaultChainKeyField;
  configuredChainKey: string | undefined;
  fallbackChainId: number | undefined;
  modeChainEntriesByKey: Map<string, ChainEntry>;
}): number | undefined => {
  if (!params.configuredChainKey) return params.fallbackChainId;

  const chainEntry = params.modeChainEntriesByKey.get(params.configuredChainKey);
  if (!chainEntry) {
    throw new Error(
      `APP_CONFIG_INVALID: appModes.configs.${params.modeKey}.${params.fieldName} references unknown chain key "${params.configuredChainKey}"`,
    );
  }

  return chainEntry.app.id;
};

const buildModeConfig = (modeKey: string): AppModeConfig => {
  const modeConfigJson = configJson.appModes.configs[modeKey];
  if (!modeConfigJson) {
    return { label: modeKey, bridgeAddress: '', proofApiUrl: '', chains: [] };
  }

  const modeChainEntriesByKey = toModeChainEntriesByKey(modeKey, modeConfigJson.chainKeys);
  const chains = [...modeChainEntriesByKey.values()].map((entry) => entry.app);
  const [primaryChain, secondaryChain] = chains;

  const defaultFromChainId = toDefaultChainId({
    modeKey,
    fieldName: 'defaultFromChainKey',
    configuredChainKey: modeConfigJson.defaultFromChainKey,
    fallbackChainId: primaryChain?.id,
    modeChainEntriesByKey,
  });
  const defaultToChainId = toDefaultChainId({
    modeKey,
    fieldName: 'defaultToChainKey',
    configuredChainKey: modeConfigJson.defaultToChainKey,
    fallbackChainId: secondaryChain?.id,
    modeChainEntriesByKey,
  });

  const base = {
    label: modeConfigJson.label,
    bridgeAddress: modeConfigJson.bridgeAddress,
    proofApiUrl: toProofApiUrl(bridgeHubApiBaseUrl, modeConfigJson.proofApiSuffix),
  };

  const enabledChains = toEnabledChains(chains);
  if (!enabledChains) {
    return { ...base, chains: [] };
  }

  return {
    ...base,
    chains: enabledChains,
    defaultFromChainId,
    defaultToChainId,
  };
};

export const APP_MODE_CONFIG: Record<AppMode, AppModeConfig> = Object.fromEntries(
  APP_MODES.map((mode) => [mode, buildModeConfig(mode)]),
) as Record<AppMode, AppModeConfig>;

export const ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]] = toNonEmptyChainArray(
  Object.values(CHAIN_REGISTRY).map((entry) => entry.wagmi),
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

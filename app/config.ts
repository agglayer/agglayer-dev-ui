import { ICONS } from '@/app/constants/icons';
import { createChainEntry, toProofApiUrl, toNonEmptyChainArray } from '@/app/utils/config';
import type { Chain } from 'wagmi/chains';
import type { AppMode, AppModeConfig } from '@/app/types/appMode';

type AppConfig = {
  EXTERNAL_LINKS: any;
  DEFAULT_APP_MODE: AppMode;
  APP_MODE_CONFIG: Record<AppMode, AppModeConfig>;
  ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]];
  customRpcUrls: Record<string, any>;
};

let APP_CONFIG: AppConfig | null = null;

function getConfig(): AppConfig {
  if (!APP_CONFIG) {
    throw new Error('Config not loaded. Call loadRuntimeConfig first.');
  }
  return APP_CONFIG;
}

export const EXTERNAL_LINKS = new Proxy({} as any, {
  get(_, prop) {
    return getConfig().EXTERNAL_LINKS[prop];
  }
});

export function DEFAULT_APP_MODE(): AppMode {
  return getConfig().DEFAULT_APP_MODE;
}

export const APP_MODE_CONFIG = new Proxy({} as Record<AppMode, AppModeConfig>, {
  get(_, prop) {
    return getConfig().APP_MODE_CONFIG[prop as AppMode];
  }
});

export function ALL_WAGMI_CHAINS(): readonly [Chain, ...Chain[]] {
  return getConfig().ALL_WAGMI_CHAINS;
}

export const customRpcUrls = {};

function buildWagmiChain(chainConfig: any): Chain {
  return {
    id: chainConfig.id,
    name: chainConfig.name,
    nativeCurrency: chainConfig.currency,
    rpcUrls: {
      default: { http: [chainConfig.rpcUrl] },
      public: { http: [chainConfig.rpcUrl] },
    },
    blockExplorers: {
      default: { name: 'Explorer', url: chainConfig.explorerUrl },
    },
  };
}

function buildChainRegistry(chainsData: Record<string, any>) {
  const registry: Record<string, any> = {};

  Object.entries(chainsData).forEach(([key, chainConfig]: [string, any]) => {
    const wagmiChain = buildWagmiChain(chainConfig);

    registry[key] = createChainEntry({
      wagmi: wagmiChain,
      icon: ICONS[chainConfig.iconKey as keyof typeof ICONS],
      networkId: chainConfig.networkId,
      isTestnet: chainConfig.isTestnet,
      eta: chainConfig.eta,
    });
  });

  return registry;
}

function buildAppModeConfigs(appModesData: any, chainRegistry: Record<string, any>) {
  const modeConfigs: Record<string, AppModeConfig> = {};

  Object.entries(appModesData.configs).forEach(([mode, config]: [string, any]) => {
    const modeChains = config.chainKeys.map((key: string) => chainRegistry[key].app);

    modeConfigs[mode] = {
      label: mode.charAt(0).toUpperCase() + mode.slice(1),
      bridgeAddress: config.bridgeAddress,
      proofApiUrl: toProofApiUrl(config.proofApi),
      chains: modeChains,
      defaultFromChainId: modeChains[0]?.id,
      defaultToChainId: modeChains[1]?.id,
    };
  });

  return modeConfigs;
}

export async function loadRuntimeConfig() {
  const response = await fetch('/config.json');
  const configData = await response.json();

  const chainRegistry = buildChainRegistry(configData.chains);
  const appModeConfigs = buildAppModeConfigs(configData.appModes, chainRegistry);
  const allWagmiChains = Object.values(chainRegistry).map((entry: any) => entry.wagmi);

  APP_CONFIG = Object.freeze({
    EXTERNAL_LINKS: configData.externalLinks,
    DEFAULT_APP_MODE: configData.appModes.default,
    APP_MODE_CONFIG: appModeConfigs,
    ALL_WAGMI_CHAINS: toNonEmptyChainArray(allWagmiChains),
    customRpcUrls: {},
  });

  return APP_CONFIG;
}

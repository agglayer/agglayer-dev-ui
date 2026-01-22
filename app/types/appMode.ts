export const APP_MODES = ['mainnet', 'testnet', 'devnet'] as const;

export type AppMode = (typeof APP_MODES)[number];

export type AppChain = {
  id: number;
  name: string;
  icon: string;
  explorer: string;
  networkId: number;
  isTestnet: boolean;
  rpcUrl: string;
  eta: number;
  nativeCurrency: {
    address: string;
    decimals: number;
    name: string;
    symbol: string;
    logoURI: string;
  };
};

type BaseModeConfig = {
  label: string;
  bridgeAddress: string;
  proofApiUrl: string;
};

export type DisabledAppModeConfig = BaseModeConfig & {
  chains: [];
};

export type EnabledAppModeConfig = BaseModeConfig & {
  chains: [AppChain, AppChain, ...AppChain[]];
  defaultFromChainId?: number;
  defaultToChainId?: number;
};

export type AppModeConfig = DisabledAppModeConfig | EnabledAppModeConfig;

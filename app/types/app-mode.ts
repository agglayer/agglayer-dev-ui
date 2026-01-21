export type AppMode = 'mainnet' | 'testnet' | 'devnet';

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

export type AppModeConfig = {
  label: string;
  bridgeAddress: string;
  proofApiUrl: string;
  defaultFromChainId: number;
  defaultToChainId: number;
  chains: AppChain[];
};

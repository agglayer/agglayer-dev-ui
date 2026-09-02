export type ChainMetadata = {
  id: number;
  name: string;
  explorer: string;
  isTestnet?: boolean;
  icon?: string;
  networkId?: number;
  nativeCurrency?: {
    address: string;
    decimals: number;
    name: string;
    symbol: string;
    logoURI: string;
    wethToken: string;
  };
  nativeBridgeURL?: string;
};

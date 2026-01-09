export type ChainMetadata = {
  id: number;
  name: string;
  explorer: string;
  isTestnet?: boolean;
  icon?: string;
  networkId?: number;
  nativeCurrency?: {
    decimals: number;
    name: string;
    symbol: string;
    logoURI: string;
  };
};

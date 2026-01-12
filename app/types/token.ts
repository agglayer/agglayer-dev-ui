export interface Token {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  logoURI?: string;
  isNative?: boolean;
  isCustom?: boolean;
}

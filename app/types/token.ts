export interface Token {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  logoURI?: string;
  isNative?: boolean;
  originChainId?: number;
  originAddress?: string;
  isCustom?: boolean;
}

export interface BalanceTokenItem {
  address: string;
  chainId: number;
  originChainId?: string;
  originChainAddress?: string;
}

export interface BalanceEntry {
  chainId: number;
  address: string;
  originChainId: string;
  originChainAddress: string;
  balance: string | null;
  usd?: number | null;
}

export interface BalanceInfo {
  rawBalance: string;
  usdPrice?: number;
}

export type BalanceIndex = Record<string, BalanceInfo>;

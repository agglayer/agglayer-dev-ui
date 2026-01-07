import { normalize } from './format';
import type { Token, BalanceTokenItem, BalanceEntry, BalanceIndex } from '@/app/types/token';


const generateBalanceKey = (chainId: number, address: string): string => {
  return `${chainId}:${normalize(address)}`;
};


export const toBalanceQueryTokens = (tokens: Token[]): BalanceTokenItem[] => {
  return tokens.map((token) => ({
    address: token.address,
    chainId: token.chainId,
    originChainAddress: token.originAddress ?? token.address,
    originChainId: String(token.originChainId ?? token.chainId),
  }));
};


export const toBalanceIndex = (entries: BalanceEntry[]): BalanceIndex => {
  return Object.fromEntries(
    entries
      .filter((entry) => entry.balance !== null)
      .map((entry) => [
        generateBalanceKey(entry.chainId, entry.address),
        {
          rawBalance: entry.balance!,
          usdPrice: entry.usd ?? undefined,
        },
      ])
  );
};

import BigNumber from 'bignumber.js';
import { normalize } from '@/app/utils/format';
import type { Token, BalanceIndex } from '@/app/types/token';

const toDecimals = (raw: string, decimals: number): BigNumber => {
  const divisor = new BigNumber(10).pow(decimals);
  return new BigNumber(raw).dividedBy(divisor);
};

export const balanceKey = (token: Token) => `${token.chainId}:${normalize(token.address)}`;

export const getTokenBalance = (token: Token, balances?: BalanceIndex) => {
  if (!balances) return undefined;
  const entry = balances[balanceKey(token)];
  if (!entry?.rawBalance) return undefined;
  return toDecimals(entry.rawBalance, token.decimals);
};

export const formatTokenBalance = (token: Token, balances?: BalanceIndex) => {
  const value = getTokenBalance(token, balances);
  if (!value || value.isZero()) return '0';
  const decimalPlaces = value.gte(1) ? 4 : 6;
  return value.decimalPlaces(decimalPlaces, BigNumber.ROUND_FLOOR).toString();
};

export const portionOfBalance = (token: Token, balances: BalanceIndex | undefined, fraction: number) => {
  const value = getTokenBalance(token, balances);
  if (!value) return '';
  if (fraction === 1) return value.toString();
  return value.multipliedBy(fraction).decimalPlaces(token.decimals, BigNumber.ROUND_FLOOR).toString();
};

export const getTokenLogoBySymbol = (symbol?: string | null): string | undefined => {
  if (!symbol) return undefined;
  const normalizedSymbol = normalize(symbol);
  return `https://assets.polygon.technology/tokenAssets/${normalizedSymbol}.svg`;
};

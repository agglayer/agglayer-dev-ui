import type { Token } from '@/app/types/token';

import { fromWei } from '@/app/utils/bigNumber';
import { normalize } from '@/app/utils/format';
import BigNumber from 'bignumber.js';

export const getTokenBalance = (token: Token, rawBalance?: string | bigint | null) => {
  if (!rawBalance) return undefined;
  return fromWei(rawBalance, token.decimals);
};

export const formatTokenBalance = (token: Token, rawBalance?: string | bigint | null) => {
  const value = getTokenBalance(token, rawBalance);
  if (!value || value.isZero()) return '0';
  const decimalPlaces = value.gte(1) ? 4 : 6;
  return value.decimalPlaces(decimalPlaces, BigNumber.ROUND_FLOOR).toString();
};

export const portionOfBalance = (
  token: Token,
  rawBalance: string | bigint | null | undefined,
  fraction: number
) => {
  const value = getTokenBalance(token, rawBalance);
  if (!value) return '';
  if (fraction === 1) return value.toString();
  return value
    .multipliedBy(fraction)
    .decimalPlaces(token.decimals, BigNumber.ROUND_FLOOR)
    .toString();
};

export const getTokenLogoBySymbol = (symbol?: string | null): string | undefined => {
  if (!symbol) return undefined;
  const normalizedSymbol = normalize(symbol);
  return `https://assets.polygon.technology/tokenAssets/${normalizedSymbol}.svg`;
};

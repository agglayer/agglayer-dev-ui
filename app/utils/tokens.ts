import type { Token } from '@/app/types/token';

import { fromWei } from '@/app/utils/bigNumber';
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

// A symbol isn't a stable identity (two tokens can share one), so logos are resolved by
// chain + address instead. Sequence's token-logo CDN only accepts lowercase addresses and
// returns 403 for unknown tokens or checksummed casing — callers already fall back to a
// letter-avatar/placeholder on image load error, so a 403 degrades gracefully.
export const getTokenLogoUrl = (params: {
  chainId?: number;
  address?: string;
}): string | undefined => {
  const { chainId, address } = params;
  if (!chainId || !address) return undefined;
  return `https://assets.sequence.info/images/tokens/medium/${chainId}/${address.toLowerCase()}.webp`;
};

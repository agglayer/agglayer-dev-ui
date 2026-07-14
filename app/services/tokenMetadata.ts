import type { AggkitBridgeAggregator } from '@agglayer/sdk';

// Thin wrapper over AggkitBridgeAggregator.getTokenMetadata (design.md §5).
// aggkit has no token-metadata endpoint; the aggregator composes it from
// /token-mappings (address resolution) + on-chain ERC20 reads, or the native
// currency for the zero address. Output shape matches this pre-existing
// TokenMetadata contract, which useTokenMetadata.ts consumes unchanged.
export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  tokenAddress: string;
  network?: number | string;
  totalSupply?: string;
  logoURI?: string;
  originTokenAddress?: string;
  originTokenNetwork?: number | string;
  wrappedTokenAddressV1?: string;
  wrappedTokenAddressV2?: string;
}

export const fetchTokenMetadata = async (params: {
  aggregator: AggkitBridgeAggregator;
  networkId: number;
  tokenAddress: string;
}): Promise<TokenMetadata> => {
  const { aggregator, networkId, tokenAddress } = params;
  const metadata = await aggregator.getTokenMetadata(tokenAddress, networkId);

  return {
    ...metadata,
    decimals: Number(metadata.decimals)
  };
};

import type { TokenMetadata } from '@/app/services/tokenMetadata';
import type { AppChain } from '@/app/types/appMode';

import { fetchTokenMetadata } from '@/app/services/tokenMetadata';
import { getChainByNetworkId, getNetworkId } from '@/app/utils/chains';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

export interface OriginToken {
  chainId: number;
  metadata: TokenMetadata;
}

// Maps the token the user is adding (`tokenAddress` on `chainId`, metadata
// already fetched) to the token it must be stored as: if the bridge of that
// network registered it as a wrapped token, the stored token is its real
// origin (read on the origin network); otherwise it is the token itself.
// Throws when the origin network is not configured in this app mode, since
// the origin's metadata cannot be read.
export const resolveTokenToOrigin = async (params: {
  aggregator: AggkitBridgeAggregator;
  chains: AppChain[];
  chainId: number;
  tokenAddress: string;
  metadata: TokenMetadata;
}): Promise<OriginToken> => {
  const { aggregator, chains, chainId, tokenAddress, metadata } = params;

  const origin = await aggregator.getTokenOrigin(tokenAddress, getNetworkId(chains, chainId));
  if (!origin.isWrapped) return { chainId, metadata };

  const originChain = getChainByNetworkId(chains, origin.originNetwork);
  if (!originChain) {
    throw new Error(
      `This token is a wrapped version of a token on network ${origin.originNetwork}, which is not available in this app`
    );
  }

  const originMetadata = await fetchTokenMetadata({
    aggregator,
    networkId: origin.originNetwork,
    tokenAddress: origin.originTokenAddress
  });
  return { chainId: originChain.id, metadata: originMetadata };
};

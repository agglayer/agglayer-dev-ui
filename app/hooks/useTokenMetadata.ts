'use client';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { fetchTokenMetadata } from '@/app/services/tokenMetadata';
import { isValidEthereumAddress } from '@/app/utils/address';
import { getChainById } from '@/app/utils/chains';
import { useQuery } from '@tanstack/react-query';

export const useTokenMetadata = (params: {
  chainId?: number;
  tokenAddress?: string;
  enabled?: boolean;
}) => {
  const { chainId, tokenAddress, enabled = false } = params;
  const { mode, chains } = useAppMode();
  const aggregator = useAggkitAggregator();
  const normalizedAddress = tokenAddress?.trim() ?? '';
  const canFetch = isValidEthereumAddress(normalizedAddress);
  const networkId = chainId ? getChainById(chains, chainId)?.networkId : undefined;

  return useQuery({
    queryKey: ['token-metadata', mode, chainId, normalizedAddress],
    enabled: enabled && canFetch && networkId !== undefined,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      if (!normalizedAddress || networkId === undefined) throw new Error('MISSING_PARAMS');
      return fetchTokenMetadata({ aggregator, networkId, tokenAddress: normalizedAddress });
    }
  });
};

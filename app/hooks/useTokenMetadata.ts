'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchTokenMetadata } from '@/app/services/token-metadata';
import { isValidEthereumAddress } from '@/app/utils/address';

export const useTokenMetadata = (params: { chainId?: number; tokenAddress?: string; enabled?: boolean }) => {
  const { chainId, tokenAddress, enabled = false } = params;
  const normalizedAddress = tokenAddress?.trim() ?? '';
  const canFetch = Boolean(chainId) && isValidEthereumAddress(normalizedAddress);

  return useQuery({
    queryKey: ['token-metadata', chainId, normalizedAddress],
    enabled: enabled && canFetch,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      if (!chainId || !normalizedAddress) throw new Error('MISSING_PARAMS');
      return fetchTokenMetadata(chainId, normalizedAddress);
    },
  });
};

'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchTokenMetadata } from '@/app/services/token-metadata';
import { isValidEthereumAddress } from '@/app/utils/address';
import { useAppMode } from '@/app/context/app-mode';

export const useTokenMetadata = (params: { chainId?: number; tokenAddress?: string; enabled?: boolean }) => {
  const { chainId, tokenAddress, enabled = false } = params;
  const { mode } = useAppMode();
  const normalizedAddress = tokenAddress?.trim() ?? '';
  const canFetch = isValidEthereumAddress(normalizedAddress);

  return useQuery({
    queryKey: ['token-metadata', mode, chainId, normalizedAddress],
    enabled: enabled && canFetch,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      if (!normalizedAddress) throw new Error('MISSING_PARAMS');
      return fetchTokenMetadata(mode, normalizedAddress);
    },
  });
};

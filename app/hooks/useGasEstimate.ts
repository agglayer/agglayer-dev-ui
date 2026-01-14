'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';

const BRIDGE_GAS_LIMIT = BigInt(200000);

export const useGasEstimate = (params: { chainId: number; enabled?: boolean }) => {
  const { chainId, enabled = false } = params;
  const publicClient = usePublicClient({ chainId });

  const canFetch = Boolean(enabled && publicClient);

  const { data: gasPrice, isLoading } = useQuery<bigint>({
    queryKey: ['gas-price', chainId],
    enabled: canFetch,
    staleTime: 15_000,
    queryFn: async () => {
      if (!publicClient) throw new Error('MISSING_CLIENT');
      return publicClient.getGasPrice();
    },
  });

  const reserveWithBuffer = useMemo(() => {
    if (!gasPrice) return BigInt(0);
    const gasCost = BRIDGE_GAS_LIMIT * gasPrice;
    return (gasCost * BigInt(12)) / BigInt(10);
  }, [gasPrice]);

  return { reserveWithBuffer, isLoading, gasPrice };
};

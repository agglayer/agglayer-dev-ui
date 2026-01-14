'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchTransactions } from '@/app/services/transactions';
import type { TransactionStatus } from '@/app/types/transaction';
import { useAppMode } from '@/app/context/app-mode';

const READY_STATUS: TransactionStatus = 'READY_TO_CLAIM';

export const useReadyToClaimCount = (params: { chainId?: number; address?: string; enabled?: boolean }) => {
  const { chainId, address, enabled = true } = params;
  const { mode } = useAppMode();

  return useQuery({
    queryKey: ['ready-to-claim-count', mode, chainId, address],
    enabled: enabled && Boolean(chainId && address),
    queryFn: async () => {
      if (!chainId || !address) throw new Error('MISSING_PARAMS');
      const response = await fetchTransactions({
        mode,
        filters: {
          fromAddress: address,
          status: READY_STATUS,
          limit: 1,
        },
      });
      return response.pagination.total ?? 0;
    },
    staleTime: 30 * 1000,
  });
};

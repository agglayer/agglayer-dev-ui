'use client';

import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchTransactions } from '@/app/services/transactions';
import type { TransactionFilters } from '@/app/types/transaction';

export const useTransactions = (params: { chainId?: number; filters?: TransactionFilters; enabled?: boolean }) => {
  const { chainId, filters = {}, enabled = true } = params;
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  return useInfiniteQuery({
    queryKey: ['transactions', chainId, filtersKey],
    enabled: enabled && Boolean(chainId),
    queryFn: async ({ pageParam }) => {
      if (!chainId) throw new Error('MISSING_CHAIN_ID');
      return fetchTransactions(chainId, {
        ...filters,
        startAfter: pageParam,
      });
    },
    getNextPageParam: (lastPage) => lastPage.pagination.nextStartAfterCursor,
    initialPageParam: undefined as string | undefined,
    staleTime: 30 * 1000, // 30 seconds
  });
};

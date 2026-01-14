'use client';

import { useMemo } from 'react';
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { fetchTransactions } from '@/app/services/transactions';
import type { TransactionFilters, TransactionsResponse } from '@/app/types/transaction';
import { useAppMode } from '@/app/context/app-mode';

export const useTransactions = (params: { chainId?: number; filters?: TransactionFilters; enabled?: boolean }) => {
  const { chainId, filters = {}, enabled = true } = params;
  const { mode } = useAppMode();
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  return useInfiniteQuery<
    TransactionsResponse,
    Error,
    InfiniteData<TransactionsResponse>,
    (string | number | undefined)[],
    string | undefined
  >({
    queryKey: ['transactions', mode, chainId, filtersKey],
    enabled: enabled && Boolean(chainId),
    queryFn: async ({ pageParam }) => {
      if (!chainId) throw new Error('MISSING_CHAIN_ID');
      return fetchTransactions({
        mode,
        filters: {
          ...filters,
          startAfter: pageParam,
        },
      });
    },
    getNextPageParam: (lastPage) => lastPage.pagination.nextStartAfterCursor,
    initialPageParam: undefined,
    staleTime: 30 * 1000, // 30 seconds
  });
};

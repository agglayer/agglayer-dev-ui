'use client';

import type { TransactionFilters, TransactionsResponse } from '@/app/types/transaction';
import type { InfiniteData } from '@tanstack/react-query';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { fetchTransactions } from '@/app/services/transactions';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import type { AggkitFailedNetwork } from '@agglayer/sdk';

// Per-page `failedNetworks` (design.md §2.4) are NOT aggregated across pages
// by the aggregator — each page only reports failures from its own fan-out.
// Dedupe by networkId across every loaded page so the UI can name each
// currently-unhealthy network once, regardless of how many pages mention it.
const aggregateFailedNetworks = (
  pages: TransactionsResponse[] | undefined
): AggkitFailedNetwork[] => {
  const byNetworkId = new Map<number, AggkitFailedNetwork>();
  for (const page of pages ?? []) {
    for (const failure of page.failedNetworks ?? []) {
      byNetworkId.set(failure.networkId, failure);
    }
  }
  return Array.from(byNetworkId.values());
};

const REFETCH_INTERVALS = [500, 1000, 2000, 3000];
export const TOTAL_REFETCH_TIME = REFETCH_INTERVALS.reduce((acc, curr) => acc + curr, 0);

export const useTransactions = (params: {
  chainId?: number;
  filters?: TransactionFilters;
  enabled?: boolean;
  aggressiveRefetch?: boolean;
}) => {
  const { chainId, filters = {}, enabled = true, aggressiveRefetch = false } = params;
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  const fetchCountRef = useRef(0);
  const prevAggressiveRef = useRef(aggressiveRefetch);

  // Reset counter when aggressiveRefetch transitions from false -> true
  useEffect(() => {
    if (aggressiveRefetch && !prevAggressiveRef.current) {
      fetchCountRef.current = 0;
    }
    prevAggressiveRef.current = aggressiveRefetch;
  }, [aggressiveRefetch]);

  const query = useInfiniteQuery<
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
      const data = await fetchTransactions({
        aggregator,
        filters: {
          ...filters,
          startAfter: pageParam
        }
      });
      // only increment fetch count on initial load pages not on subsequent pages
      if (!pageParam && aggressiveRefetch) {
        fetchCountRef.current++;
      }
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.pagination.nextStartAfterCursor,
    initialPageParam: undefined,
    staleTime: 30 * 1000,
    refetchInterval: (query) => {
      if (!aggressiveRefetch) return false;
      if (query.state.status === 'error') return false;

      const count = fetchCountRef.current;
      if (count >= REFETCH_INTERVALS.length) return false;

      return REFETCH_INTERVALS[count];
    }
  });

  const failedNetworks = useMemo(() => aggregateFailedNetworks(query.data?.pages), [query.data]);

  return { ...query, failedNetworks };
};

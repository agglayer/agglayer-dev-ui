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

// Aggkit has no push/subscription and status is derived per fetch, so the
// activity view polls to stay live. Fast cadence while any loaded tx is still
// non-terminal (its spinner/status must advance); a slower idle cadence
// otherwise so newly-submitted/indexed deposits (e.g. an L2->L1 withdrawal that
// isn't indexed within the initial burst) still appear without a manual refresh
// or navigating away and back. Polling only runs while the page is mounted and
// the tab is focused (react-query default).
const PENDING_POLL_INTERVAL = 5000;
const IDLE_POLL_INTERVAL = 10000;

const hasNonTerminalTransaction = (
  pages: TransactionsResponse[] | undefined
): boolean => (pages ?? []).some((page) => page.data.some((tx) => tx.status !== 'CLAIMED'));

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
      if (query.state.status === 'error') return false;

      // Initial fast burst right after a user action (bridge submit) for snappy
      // feedback while the deposit first appears / starts progressing.
      const count = fetchCountRef.current;
      if (aggressiveRefetch && count < REFETCH_INTERVALS.length) {
        return REFETCH_INTERVALS[count];
      }

      // Then keep the view live: poll fast while any loaded tx is still
      // non-terminal so its status (BRIDGED -> LEAF_INCLUDED -> READY_TO_CLAIM
      // -> CLAIMED) advances, and poll at a slower idle cadence otherwise so a
      // newly-appearing deposit still shows up on its own.
      return hasNonTerminalTransaction(query.state.data?.pages)
        ? PENDING_POLL_INTERVAL
        : IDLE_POLL_INTERVAL;
    }
  });

  const failedNetworks = useMemo(() => aggregateFailedNetworks(query.data?.pages), [query.data]);

  return { ...query, failedNetworks };
};

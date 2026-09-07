'use client';

import type { ActivityResult } from '@/app/services/activity';
import type { Transaction, TransactionFilters } from '@/app/types/transaction';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { usePendingBridges } from '@/app/context/pendingBridges';
import { fetchActivity } from '@/app/services/activity';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

const REFETCH_INTERVALS = [500, 1000, 2000, 3000];
export const TOTAL_REFETCH_TIME = REFETCH_INTERVALS.reduce((acc, curr) => acc + curr, 0);

// Aggkit's activity endpoint has no push/subscription and status is derived
// per fetch, so the view polls to stay live. Fast cadence while any loaded
// tx is still non-terminal (its spinner/status must advance); a slower idle
// cadence otherwise so newly-submitted/indexed deposits still appear without
// a manual refresh or navigating away and back. Polling only runs while the
// page is mounted and the tab is focused (react-query default).
const PENDING_POLL_INTERVAL = 5000;
const IDLE_POLL_INTERVAL = 10000;

const hasNonTerminalTransaction = (transactions: Transaction[] | undefined): boolean =>
  (transactions ?? []).some((tx) => tx.status !== 'CLAIMED');

// GET /tracker/v1/activity/from/{address} has no server-side status/date
// filtering (nor pagination -- see fetchNextPage below), so both are applied
// here now that the whole address history is already in memory.
const applyFilters = (
  transactions: Transaction[],
  filters: Pick<TransactionFilters, 'status' | 'updatedSince' | 'order'>
): Transaction[] => {
  const filtered = transactions.filter((tx) => {
    if (filters.status && tx.status !== filters.status) return false;
    if (filters.updatedSince && tx.lastUpdatedAt < filters.updatedSince) return false;
    return true;
  });
  const direction = filters.order === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => direction * (a.timestamp - b.timestamp));
};

export const useTransactions = (params: {
  chainId?: number;
  filters?: TransactionFilters;
  enabled?: boolean;
  aggressiveRefetch?: boolean;
}) => {
  const { chainId, filters = {}, enabled = true, aggressiveRefetch = false } = params;
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();
  const fromAddress = filters.fromAddress;
  const { pendingBridges, removePendingBridge } = usePendingBridges();

  const fetchCountRef = useRef(0);
  const prevAggressiveRef = useRef(aggressiveRefetch);

  // Reset counter when aggressiveRefetch transitions from false -> true
  useEffect(() => {
    if (aggressiveRefetch && !prevAggressiveRef.current) {
      fetchCountRef.current = 0;
    }
    prevAggressiveRef.current = aggressiveRefetch;
  }, [aggressiveRefetch]);

  const query = useQuery<ActivityResult, Error>({
    // chainId is NOT part of the key: fetchActivity's response doesn't vary
    // by it (see queryFn below -- only the aggregator/fromAddress go into the
    // request), so including it would just fragment the cache. It's still
    // required below via `enabled` -- see useReadyToClaimCount, which reads
    // the exact same key so the two dedupe into a single request.
    queryKey: ['activity', mode, fromAddress],
    enabled: enabled && Boolean(chainId) && Boolean(fromAddress),
    queryFn: async () => {
      if (!fromAddress) throw new Error('MISSING_ACTIVITY_PARAMS');
      const data = await fetchActivity({ aggregator, fromAddress });
      if (aggressiveRefetch) fetchCountRef.current++;
      return data;
    },
    staleTime: 30 * 1000,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;

      // Initial fast burst right after a user action (bridge submit) for
      // snappy feedback while the deposit first appears / starts progressing.
      const count = fetchCountRef.current;
      if (aggressiveRefetch && count < REFETCH_INTERVALS.length) {
        return REFETCH_INTERVALS[count];
      }

      // Then keep the view live: poll fast while any loaded tx is still
      // non-terminal so its status advances, and poll at a slower idle
      // cadence otherwise so a newly-appearing deposit still shows up on
      // its own.
      return hasNonTerminalTransaction(query.state.data?.transactions)
        ? PENDING_POLL_INTERVAL
        : IDLE_POLL_INTERVAL;
    }
  });

  const transactions = query.data?.transactions;
  const warnings = query.data?.warnings ?? [];

  // Once the real activity feed reports a transactionHash, drop the matching
  // local placeholder (added by bridgeCard.tsx right after a bridge tx
  // confirms) -- the real row always wins, and it carries data (tracking,
  // deposit count, block info) the placeholder never had.
  useEffect(() => {
    if (!transactions || pendingBridges.length === 0) return;
    const realHashes = new Set(transactions.map((tx) => tx.transactionHash.toLowerCase()));
    pendingBridges.forEach((tx) => {
      if (realHashes.has(tx.transactionHash.toLowerCase())) {
        removePendingBridge(tx.transactionHash);
      }
    });
  }, [transactions, pendingBridges, removePendingBridge]);

  // Fills the gap between "bridge tx confirmed" and "the activity endpoint's
  // next poll picks it up" (RefetchContext's aggressive-refetch burst still
  // takes up to TOTAL_REFETCH_TIME) so a freshly-submitted bridge shows up
  // immediately instead of the list looking like it didn't register at all.
  // Scoped to this address (a placeholder from a different wallet than the
  // one currently filtered on shouldn't leak in) and to hashes the real feed
  // hasn't reported yet (see the dedup effect above, which is what clears
  // this out once the real row lands).
  const combined = useMemo(() => {
    const realHashes = new Set((transactions ?? []).map((tx) => tx.transactionHash.toLowerCase()));
    const relevantPending = pendingBridges.filter(
      (tx) =>
        !realHashes.has(tx.transactionHash.toLowerCase()) &&
        (!fromAddress || tx.fromAddress.toLowerCase() === fromAddress.toLowerCase())
    );
    return [...relevantPending, ...(transactions ?? [])];
  }, [transactions, pendingBridges, fromAddress]);

  // filters is a fresh object every render (transactionsView.tsx recreates
  // queryFilters via its own useMemo), so this depends on its primitive
  // fields directly rather than on `filters` itself.
  const filtered = useMemo(
    () => applyFilters(combined, filters),
    [combined, filters.status, filters.updatedSince, filters.order]
  );

  // Client-side pagination over the full, already-fetched list: the activity
  // endpoint has no cursor to page through, so "load more" just reveals more
  // of what's already in memory.
  const limit = filters.limit ?? 20;
  const [pageCount, setPageCount] = useState(1);
  useEffect(() => {
    setPageCount(1);
  }, [mode, fromAddress, filters.status, filters.updatedSince]);

  const visibleTransactions = useMemo(
    () => filtered.slice(0, pageCount * limit),
    [filtered, pageCount, limit]
  );
  const totalCount = filtered.length;
  const hasNextPage = visibleTransactions.length < totalCount;
  const fetchNextPage = () => setPageCount((count) => count + 1);

  return {
    transactions: visibleTransactions,
    totalCount,
    warnings,
    isLoading: query.isLoading,
    // No real "next page" request anymore (it's an in-memory slice), kept so
    // TransactionList's loading-more affordance still has a prop to read.
    isFetchingNextPage: false,
    hasNextPage,
    fetchNextPage,
    error: query.error,
    refetch: query.refetch,
    isRefetching: query.isFetching && !query.isLoading
  };
};

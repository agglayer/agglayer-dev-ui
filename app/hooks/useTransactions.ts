'use client';

import type { Transaction, TransactionFilters } from '@/app/types/transaction';
import type { ActivityPages } from '@/app/utils/activityPages';

import { DEFAULT_ACTIVITY_PAGE_SIZE } from '@/app/constants/activity';
import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { usePendingBridges } from '@/app/context/pendingBridges';
import { fetchActivity, toActivityFilter } from '@/app/services/activity';
import { hasMorePages, loadActivityPages } from '@/app/utils/activityPages';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { READY_TO_CLAIM_COUNT_KEY } from './useReadyToClaimCount';

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

// Status filtering and ordering are server-side now (`filterBridges`, newest
// first), so this only has to cover what the endpoint can't: the date range
// (applied to the pages loaded so far) and the local pending placeholders,
// which the server has never heard of.
const applyFilters = (
  transactions: Transaction[],
  filters: Pick<TransactionFilters, 'status' | 'updatedSince'>
): Transaction[] =>
  transactions.filter((tx) => {
    if (filters.status && tx.status !== filters.status) return false;
    if (filters.updatedSince && tx.lastUpdatedAt < filters.updatedSince) return false;
    return true;
  });

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

  const queryClient = useQueryClient();
  const pageSize = filters.limit ?? DEFAULT_ACTIVITY_PAGE_SIZE;
  const filterBridges = toActivityFilter(filters.status);
  // The server filters by status, so each status is its own cached list.
  // chainId is NOT part of the key: the response doesn't vary by it (see
  // queryFn below -- only the aggregator/fromAddress go into the request),
  // so including it would just fragment the cache. It's still required below
  // via `enabled`.
  const queryKey = useMemo(
    () => ['activity', mode, fromAddress, filterBridges, pageSize],
    [mode, fromAddress, filterBridges, pageSize]
  );

  const fetchPage = useCallback(
    (pageNumber: number) => {
      if (!fromAddress) throw new Error('MISSING_ACTIVITY_PARAMS');
      return fetchActivity({ aggregator, fromAddress, filterBridges, pageNumber, pageSize });
    },
    [aggregator, fromAddress, filterBridges, pageSize]
  );

  // Set while "load more" is in flight so a poll can't land in between and
  // overwrite the pages it is about to append (see fetchNextPage).
  const loadingMoreRef = useRef(false);
  // Makes the next queryFn run request every loaded page again instead of
  // trusting the cached ones (see refetch below).
  const forceReloadRef = useRef(false);

  const query = useQuery<ActivityPages, Error>({
    queryKey,
    enabled: enabled && Boolean(chainId) && Boolean(fromAddress),
    queryFn: async () => {
      if (!fromAddress) throw new Error('MISSING_ACTIVITY_PARAMS');
      const previous = queryClient.getQueryData<ActivityPages>(queryKey);
      // Polls only re-check page 1 against what's loaded (a changed page 1
      // reloads every loaded page): rows on later pages keep the status they
      // were loaded with until then. Fast bursts after a user action and
      // explicit refreshes reload everything instead, so a claim made on
      // page 3 shows its new status.
      const reuseLoaded = !forceReloadRef.current && !aggressiveRefetch;
      forceReloadRef.current = false;
      const data = await loadActivityPages({
        previous: reuseLoaded ? previous : undefined,
        targetPageCount: previous?.pages.length ?? 1,
        pageSize,
        fetchPage
      });
      if (aggressiveRefetch) fetchCountRef.current++;
      return data;
    },
    staleTime: 30 * 1000,
    refetchInterval: (query) => {
      if (query.state.status === 'error' || loadingMoreRef.current) return false;

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
      return hasNonTerminalTransaction(query.state.data?.pages.flat())
        ? PENDING_POLL_INTERVAL
        : IDLE_POLL_INTERVAL;
    }
  });

  const transactions = useMemo(() => query.data?.pages.flat(), [query.data]);
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
  const placeholders = useMemo(() => {
    const realHashes = new Set((transactions ?? []).map((tx) => tx.transactionHash.toLowerCase()));
    return pendingBridges.filter(
      (tx) =>
        !realHashes.has(tx.transactionHash.toLowerCase()) &&
        (!fromAddress || tx.fromAddress.toLowerCase() === fromAddress.toLowerCase())
    );
  }, [transactions, pendingBridges, fromAddress]);
  const combined = useMemo(
    () => [...placeholders, ...(transactions ?? [])],
    [placeholders, transactions]
  );

  // filters is a fresh object every render (transactionsView.tsx recreates
  // queryFilters via its own useMemo), so this depends on its primitive
  // fields directly rather than on `filters` itself.
  const filtered = useMemo(
    () => applyFilters(combined, filters),
    [combined, filters.status, filters.updatedSince]
  );

  // Server-side pagination: `count` is the total matching the status filter
  // across every page. Local placeholders aren't part of it, so they're
  // added on top (they're always the newest rows, shown first).
  const loadedPages = query.data?.pages.length ?? 0;
  const placeholderCount = useMemo(
    () => applyFilters(placeholders, filters).length,
    [placeholders, filters.status, filters.updatedSince]
  );
  const totalCount = (query.data?.count ?? 0) + placeholderCount;
  const hasNextPage = query.data
    ? hasMorePages({ loadedPages, pageSize, count: query.data.count })
    : false;

  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [fetchNextPageError, setFetchNextPageError] = useState<Error | null>(null);

  // Clear a stale "load more" error when the list it belonged to changes.
  useEffect(() => {
    setFetchNextPageError(null);
  }, [queryKey]);

  // Page 1 is always requested first: new bridges can land on it while the
  // user reads, shifting every older row down. If it still reads exactly the
  // same, only the next page is requested; otherwise every loaded page (and
  // the next one) is requested again -- see loadActivityPages.
  const fetchNextPage = useCallback(async () => {
    const previous = queryClient.getQueryData<ActivityPages>(queryKey);
    if (!previous || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsFetchingNextPage(true);
    setFetchNextPageError(null);
    try {
      // A poll already in flight would resolve after us with the old page
      // count and wipe the appended page.
      await queryClient.cancelQueries({ queryKey });
      const data = await loadActivityPages({
        previous,
        targetPageCount: previous.pages.length + 1,
        pageSize,
        fetchPage
      });
      queryClient.setQueryData(queryKey, data);
    } catch (err) {
      setFetchNextPageError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      loadingMoreRef.current = false;
      setIsFetchingNextPage(false);
    }
  }, [queryClient, queryKey, pageSize, fetchPage]);

  // An explicit refresh (button, after a claim) reloads every loaded page,
  // and the header's ready-to-claim badge with it -- it's its own query now.
  const refetch = useCallback(() => {
    forceReloadRef.current = true;
    void queryClient.invalidateQueries({ queryKey: READY_TO_CLAIM_COUNT_KEY });
    return query.refetch();
  }, [queryClient, query]);

  return {
    transactions: filtered,
    totalCount,
    warnings,
    isLoading: query.isLoading,
    isFetchingNextPage,
    fetchNextPageError,
    hasNextPage,
    fetchNextPage,
    error: query.error,
    refetch,
    isRefetching: query.isFetching && !query.isLoading && !isFetchingNextPage
  };
};

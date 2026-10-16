'use client';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useQuery } from '@tanstack/react-query';

export const READY_TO_CLAIM_COUNT_KEY = ['readyToClaimCount'];

// Asks the tracker for just the bridges that are ready to claim
// (filterBridges: 'readyToClaim') and reads the total off `count`, a page of
// size 1 being all it takes -- the old version loaded the address's whole
// history to count it client-side. includeTracking stays off: the count
// needs no step detail, and tracking registers every unclaimed bridge it
// returns with the tracker.
//
// Its own query rather than a slice of useTransactions' list (which is now a
// per-status, paginated cache): useTransactions.refetch invalidates this key
// so a refresh on the Transactions page refreshes the header badge too.
export const useReadyToClaimCount = (params: {
  chainId?: number;
  address?: string;
  enabled?: boolean;
}) => {
  const { chainId, address, enabled = true } = params;
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();

  return useQuery({
    queryKey: [...READY_TO_CLAIM_COUNT_KEY, mode, address],
    enabled: enabled && Boolean(chainId && address),
    queryFn: async () => {
      if (!address) throw new Error('MISSING_PARAMS');
      const result = await aggregator.getActivity({
        fromAddress: address,
        filterBridges: 'readyToClaim',
        pageNumber: 1,
        pageSize: 1
      });
      return result.count;
    },
    staleTime: 30 * 1000,
    // Poll steadily so the badge reflects deposits becoming claimable even
    // when the Transactions page (and its own, faster poll) isn't mounted.
    refetchInterval: 15 * 1000
  });
};

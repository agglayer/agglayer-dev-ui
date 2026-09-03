'use client';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { fetchActivity } from '@/app/services/activity';
import { useQuery } from '@tanstack/react-query';

// Same GET /tracker/v1/activity/from/{address} call useTransactions makes,
// selected down to a count -- deliberately the SAME queryKey (mode, address;
// chainId is deliberately excluded, see useTransactions) so that when the
// header badge and the Transactions page are both mounted, react-query
// dedupes them into a single request instead of two.
export const useReadyToClaimCount = (params: {
  chainId?: number;
  address?: string;
  enabled?: boolean;
}) => {
  const { chainId, address, enabled = true } = params;
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();

  return useQuery({
    queryKey: ['activity', mode, address],
    enabled: enabled && Boolean(chainId && address),
    queryFn: async () => {
      if (!address) throw new Error('MISSING_PARAMS');
      return fetchActivity({ aggregator, fromAddress: address });
    },
    select: (data) => data.transactions.filter((tx) => tx.status === 'READY_TO_CLAIM').length,
    staleTime: 30 * 1000,
    // Poll steadily so the badge reflects deposits becoming claimable even
    // when the Transactions page (and its own, faster poll) isn't mounted.
    refetchInterval: 15 * 1000
  });
};

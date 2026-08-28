'use client';

import { useAppMode } from '@/app/context/appMode';
import { fetchActivity, resolveAggkitProxyBaseUrl } from '@/app/services/activity';
import { useQuery } from '@tanstack/react-query';

// Same GET /tracker/v1/activity/from/{address} call useTransactions makes,
// selected down to a count -- deliberately the SAME queryKey (mode, chainId,
// address) so that when the header badge and the Transactions page are both
// mounted, react-query dedupes them into a single request instead of two.
export const useReadyToClaimCount = (params: {
  chainId?: number;
  address?: string;
  enabled?: boolean;
}) => {
  const { chainId, address, enabled = true } = params;
  const { mode, config } = useAppMode();
  const baseUrl = resolveAggkitProxyBaseUrl(config.aggkitBridgeApis);

  return useQuery({
    queryKey: ['activity', mode, chainId, address],
    enabled: enabled && Boolean(chainId && address && baseUrl),
    queryFn: async () => {
      if (!address || !baseUrl) throw new Error('MISSING_PARAMS');
      return fetchActivity({ baseUrl, fromAddress: address });
    },
    select: (transactions) => transactions.filter((tx) => tx.status === 'READY_TO_CLAIM').length,
    staleTime: 30 * 1000,
    // Poll steadily so the badge reflects deposits becoming claimable even
    // when the Transactions page (and its own, faster poll) isn't mounted.
    refetchInterval: 15 * 1000
  });
};

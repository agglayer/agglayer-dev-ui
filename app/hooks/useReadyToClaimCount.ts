'use client';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useQuery } from '@tanstack/react-query';

// design.md §3.7: a cheap, bounded count — one bridges+claims page per
// configured network (Tier 1) to build the unclaimed set, then
// `/l1-info-tree-index` probes bounded to that unclaimed set only (Tier 2).
// Never a full activity scan, and never rejects on a partial per-network
// failure (AggkitBridgeAggregator.getReadyToClaimCount silently excludes
// failed networks from the count rather than surfacing them — there is no
// per-network breakdown here, unlike getActivity's `failedNetworks`).
export const useReadyToClaimCount = (params: {
  chainId?: number;
  address?: string;
  enabled?: boolean;
}) => {
  const { chainId, address, enabled = true } = params;
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();

  return useQuery({
    queryKey: ['ready-to-claim-count', mode, chainId, address],
    enabled: enabled && Boolean(chainId && address),
    queryFn: async () => {
      if (!chainId || !address) throw new Error('MISSING_PARAMS');
      return aggregator.getReadyToClaimCount({ fromAddress: address });
    },
    staleTime: 30 * 1000,
    // Poll steadily so the badge reflects deposits becoming claimable (aggkit
    // has no push and status is derived per fetch). The count is bounded per
    // design §3.7; 15s keeps it fresh without hammering the fan-out.
    refetchInterval: 15 * 1000
  });
};

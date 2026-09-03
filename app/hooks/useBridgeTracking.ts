'use client';

import type { Transaction } from '@/app/types/transaction';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useQuery } from '@tanstack/react-query';

import type { AggkitTrackingData } from '@agglayer/sdk';

// Poll cadence for the on-demand path below -- same cadence the old per-row
// poller used before tracking data started arriving embedded on the
// Transaction (see this file's git history, pre S-review 2026-08-28).
const TRACKING_POLL_INTERVAL = 5000;

// Mirrors AggkitBridgeClient.getBridgeTracking's documented terminal
// conditions -- stop polling once EITHER is true: the bridge reached its
// last step (`finished`), or the tracker gave up ever resolving it at all
// (`error` with `bridge_status` still null). A per-step error alone leaves
// `bridge_status` populated and is NOT terminal -- the tracker retries those
// on its own, so this keeps polling through them.
export const isTrackingTerminal = (data: AggkitTrackingData | undefined): boolean => {
  if (!data) return false;
  if (data.tracking_status === 'finished') return true;
  if (data.tracking_status === 'error' && data.bridge_status === null) return true;
  return false;
};

// TrackerDetail's on-demand loading gate -- distinct from isTrackingTerminal
// above, which drives the poll's stop condition and must stay narrow
// (finished, or the giving-up error) so polling keeps running through
// `running`. This one only cares whether the tracker has resolved the route
// at all: once tracking_status leaves `registered` there is a current step
// worth rendering (even mid-resolution, `all_steps` populated with pending/
// inProgress entries), so this flips to true earlier than isTrackingTerminal
// while the hook keeps polling underneath until the terminal condition above
// is met.
export const hasTrackingStarted = (data: AggkitTrackingData | undefined): boolean => {
  if (!data) return false;
  return data.tracking_status !== 'registered';
};

// The activity endpoint (GET /tracker/v1/activity/from/{address}, called
// with includeTracking=true by app/services/activity.ts's fetchActivity)
// embeds each unclaimed bridge's tracker state directly on the Transaction
// -- see toTransaction there. For those rows this hook is a plain
// passthrough (no request of its own): TrackerProgressBar/TrackerDetail
// mount it unconditionally and get live data straight from useTransactions'
// own poll.
//
// The activity endpoint never embeds tracking for an already-CLAIMED bridge
// (attached "only when unclaimed" -- see the SDK's AggkitActivityItem doc),
// so once a bridge finishes there is nothing left to pass through.
// `options.enabled` opts into an ON-DEMAND fetch instead, straight from the
// aggkit tracker (AggkitBridgeAggregator.getBridgeTracking) -- the same
// per-row poll this hook used before the embedded-tracking refactor. Callers
// must only set this from an explicit user action (e.g. TrackerDetail's
// on-demand mode, wired to transactionDetailsModal.tsx's "Show bridge steps"
// button for a completed row), never unconditionally: unlike the embedded
// path this is a real HTTP request, and it keeps polling on its own cadence
// -- a single call can land before the tracker has finished resolving the
// bridge (`tracking_status` still `registered`/`running`) -- until the
// terminal condition above is met.
export const useBridgeTracking = (
  transaction: Transaction,
  options: { enabled?: boolean } = {}
): {
  data: AggkitTrackingData | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
} => {
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();
  const { sourceNetwork, transactionHash, tracking } = transaction;
  // Embedded tracking always wins, even if a caller passes enabled: true --
  // only a CLAIMED (or otherwise not-yet-resolved) row with no embedded data
  // ever actually reaches the network.
  const onDemand = Boolean(options.enabled) && !tracking;

  const query = useQuery<AggkitTrackingData>({
    queryKey: ['bridge-tracking-detail', mode, sourceNetwork, transactionHash],
    enabled: onDemand,
    queryFn: () => aggregator.getBridgeTracking(sourceNetwork, transactionHash),
    staleTime: TRACKING_POLL_INTERVAL,
    refetchInterval: (query) =>
      isTrackingTerminal(query.state.data) ? false : TRACKING_POLL_INTERVAL
  });

  if (tracking) {
    return { data: tracking, isLoading: false, isFetching: false, error: null };
  }

  return {
    data: onDemand ? query.data : undefined,
    isLoading: onDemand && query.isLoading,
    isFetching: onDemand && query.isFetching,
    error: onDemand ? (query.error ?? null) : null
  };
};

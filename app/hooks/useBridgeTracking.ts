'use client';

import type { Transaction } from '@/app/types/transaction';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useQuery } from '@tanstack/react-query';

import type { AggkitTrackingData } from '@agglayer/sdk';

// Same cadence as useTransactions' PENDING_POLL_INTERVAL -- aggkit's tracker
// has no push/subscription, so this hook polls too.
const TRACKING_POLL_INTERVAL = 5000;

// Load note: aggkit enforces no in-process rate limit
// (MaxRequestsPerIPAndSecond is unenforced in RESTConfig-backed sections --
// aggkit #1783; the kurtosis template pins it to the upstream default 0).
// The load math below is therefore a capacity/courtesy note for the proxy
// and any fronting infra limit an operator adds, not a hard budget: this
// hook is only ever mounted per RENDERED, non-completed row (no background
// subscription list independent of what's in the list), so N such rows
// cost N requests / TRACKING_POLL_INTERVAL = N/5 req/s -- e.g. the initial
// 20-row page costs 4 req/s. CAVEAT: transactionList.tsx is not virtualized
// and its infinite scroll keeps every loaded page's rows mounted, so N
// accumulates by 20 per "load more"; together with the activity poll
// (which refetches EVERY loaded page each cycle), a list scrolled to ~8-9
// pages of all-pending rows (~170+) is an unrealistically pending-heavy
// devnet history, so it is accepted rather than mitigated (virtualizing
// the list or capping polled rows would be the fix if it ever bites at
// scale); react-query's natural staggering (each row's query mounts at a
// slightly different time) also spreads the load within a second.
const isTrackingTerminal = (data: AggkitTrackingData | undefined): boolean => {
  if (!data) return false;
  if (data.tracking_status === 'finished') return true;
  // The giving-up terminal: the tracker could not resolve the bridge at all
  // (tx not found / not a bridge tx), reported as tracking_status 'error'
  // with bridge_status still null. A step-level error inside an all_steps[i]
  // entry ALSO reports tracking_status 'error' (aggkit derives it from the
  // step at step_index -- bridgetracker/domain/tracking_data.go), but with
  // bridge_status populated; the tracker retries those on its own, so the
  // bridge_status null check below is what keeps polling through them.
  if (data.tracking_status === 'error' && data.bridge_status === null) return true;
  return false;
};

// Polls AggkitBridgeAggregator.getBridgeTracking for a
// single transaction row, keyed by its RECORDING network (sourceNetwork,
// routed correctly by the aggregator even for L1/networkId 0) and hash.
// Only terminal tracking states (finished, or gave up with bridge_status
// still null) stop polling -- plus CLAIMED, gated via `enabled` above.
// Transient/hard query errors (e.g. react-query exhausting its default
// retries on a proxy blip or rate-limit burst) do NOT stop polling: when
// status is 'error', query.state.data is the last successful data (or
// undefined pre-first-success), so refetchInterval falls through to
// isTrackingTerminal on that and keeps polling at the normal cadence,
// letting the row self-heal without a remount. Also keeps polling through
// step-level errors and through a tracker-side regression back to
// 'registered' (e.g. retention re-registration) -- this hook never throws
// on null/missing fields, it just returns whatever the API reports and
// lets consumers render accordingly (e.g. nothing while all_steps is still
// null). Accepted trade-off: a permanently-failing request (e.g. a
// hypothetical 400) would poll harmlessly every 5s rather than stop.
export const useBridgeTracking = (transaction: Transaction) => {
  const { mode } = useAppMode();
  const aggregator = useAggkitAggregator();
  const { sourceNetwork, transactionHash, status } = transaction;

  return useQuery<AggkitTrackingData>({
    queryKey: ['bridge-tracking', mode, sourceNetwork, transactionHash],
    enabled: status !== 'CLAIMED',
    queryFn: () => aggregator.getBridgeTracking(sourceNetwork, transactionHash),
    staleTime: TRACKING_POLL_INTERVAL,
    refetchInterval: (query) => {
      return isTrackingTerminal(query.state.data) ? false : TRACKING_POLL_INTERVAL;
    }
  });
};

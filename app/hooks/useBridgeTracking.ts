'use client';

import type { Transaction } from '@/app/types/transaction';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useQuery } from '@tanstack/react-query';

import type { AggkitTrackingData } from '@agglayer/sdk';

// Same cadence as useTransactions' PENDING_POLL_INTERVAL -- aggkit's tracker
// has no push/subscription (design.md), so this hook polls too.
const TRACKING_POLL_INTERVAL = 5000;

// Rate-limit budget (enclave-notes.md / design.md §Tracker): the aggkit
// proxy's haproxy allows 50 req/IP/s, and ALL of a tab's traffic (activity
// polling + this hook, across every rendered row) funnels through that one
// proxy IP. This hook is only ever mounted per CURRENTLY RENDERED, non-
// completed row (no background subscription list independent of what's on
// screen), so a page of N such rows costs N requests / TRACKING_POLL_INTERVAL
// = N/5 req/s -- e.g. a 20-row page costs 4 req/s, a 50-row page costs
// 10 req/s, both comfortably under the 50 req/s budget even before counting
// react-query's natural staggering (each row's query mounts at a slightly
// different time, so the N requests are not sent in lockstep).
const isTrackingTerminal = (data: AggkitTrackingData | undefined): boolean => {
  if (!data) return false;
  if (data.tracking_status === 'finished') return true;
  // The giving-up terminal: the tracker could not resolve the bridge at all
  // (tx not found / not a bridge tx), reported as tracking_status 'error'
  // with bridge_status still null. A step-level error inside an all_steps[i]
  // entry is NOT this -- the tracker retries those on its own, so
  // tracking_status stays 'running' there and polling must continue.
  if (data.tracking_status === 'error' && data.bridge_status === null) return true;
  return false;
};

// design.md §Tracker: polls AggkitBridgeAggregator.getBridgeTracking for a
// single transaction row, keyed by its RECORDING network (sourceNetwork,
// routed correctly by the aggregator even for L1/networkId 0) and hash.
// Stops polling once tracking is terminal (finished, or gave up with
// bridge_status still null); keeps polling through step-level errors and
// through a tracker-side regression back to 'registered' (e.g. retention
// re-registration) -- this hook never throws on null/missing fields, it
// just returns whatever the API reports and lets consumers render
// accordingly (e.g. nothing while all_steps is still null).
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
      if (query.state.status === 'error') return false;
      return isTrackingTerminal(query.state.data) ? false : TRACKING_POLL_INTERVAL;
    }
  });
};

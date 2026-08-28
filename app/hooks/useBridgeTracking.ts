'use client';

import type { Transaction } from '@/app/types/transaction';

import type { AggkitTrackingData } from '@agglayer/sdk';

// The activity endpoint (GET /tracker/v1/activity/from/{address}, called
// with includeTracking=true by app/services/activity.ts's fetchActivity)
// now embeds each unclaimed bridge's tracker state directly on the
// Transaction object -- see toTransaction there. This hook used to poll
// AggkitBridgeAggregator.getBridgeTracking per row (one HTTP request per
// rendered non-terminal row every 5s, see the removed load-note here); it's
// now a plain passthrough so TrackerProgressBar/TrackerDetail don't need to
// change at all -- tracking data now arrives, and refreshes, as part of
// useTransactions' single poll instead of a query of its own.
export const useBridgeTracking = (
  transaction: Transaction
): { data: AggkitTrackingData | undefined } => ({
  data: transaction.tracking
});

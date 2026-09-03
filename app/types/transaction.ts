import type { Hex } from 'viem';

import type { AggkitTrackingData } from '@agglayer/sdk';

// PENDING replaces the old BRIDGED/LEAF_INCLUDED pair, and ERROR is new --
// see app/services/activity.ts's deriveStatus doc comment for why: the
// bridgetracker activity endpoint's claimed tri-state ("true"/"false"/
// "error") plus its embedded per-bridge tracking data don't support the old
// 4-state model, only this one.
export type TransactionStatus = 'PENDING' | 'READY_TO_CLAIM' | 'CLAIMED' | 'ERROR';

export interface Transaction {
  hubUID: string;
  txSender: string;
  fromAddress: string;
  receiverAddress: string;
  sourceNetwork: number;
  destinationNetwork: number;
  amount: string;
  status: TransactionStatus;
  // Set only when status is ERROR: the destination bridge contract's
  // isClaimed() check itself failed (e.g. no bridge address configured for
  // that network) -- see app/services/activity.ts's deriveStatus.
  statusError?: string;
  lastUpdatedAt: number;
  bridgeHash: string;
  metadata: string;
  leafType: string;
  depositCount: number;
  transactionIndex: number;
  transactionHash: string;
  claimTransactionHash?: string;
  claimTimestamp?: number;
  claimBlockNumber?: number;
  blockNumber: number;
  // aggkit's authoritative per-bridge index, as its exact decimal digits --
  // a string, never a number: L1-origin deposits are 2^64 + deposit_count,
  // past what a double can represent (see app/services/activity.ts's
  // parseActivityResponse). Optional only for the synthetic pending rows the
  // app builds itself; every row from the wire carries it, and
  // buildClaimAssetParams refuses to build a claim without it.
  globalIndex?: string;
  originTokenAddress: string;
  originTokenNetwork: number;
  timestamp: number;
  leafIndex: number;
  // The bridgetracker's current step-by-step status for this bridge, embedded
  // directly by the activity endpoint (includeTracking=true) when unclaimed.
  // useBridgeTracking now just reads this back instead of polling its own
  // per-row endpoint -- see that hook's doc comment.
  tracking?: AggkitTrackingData;
}

export interface TransactionFilters {
  fromAddress?: string;
  updatedSince?: number;
  status?: TransactionStatus;
  order?: 'asc' | 'desc';
  limit?: number;
}

export type ClaimStep = 'idle' | 'claiming' | 'success' | 'error';

// The sub-step useClaimExecution was attempting when a claim failed. Kept
// separate from ClaimStep (which only tracks the coarse UI state) so the
// error UI/logs can say *where* in the flow things broke, e.g. distinguishing
// "the RPC send was rejected" from "the proof fetch from the aggregator
// failed" -- both surface as currentStep: 'error' otherwise.
export type ClaimFailedStep =
  | 'validating-wallet'
  | 'validating-configuration'
  | 'checking-claim-status'
  | 'fetching-claim-proof'
  | 'building-claim-transaction'
  | 'sending-transaction'
  | 'confirming-transaction';

export interface ClaimExecutionState {
  isExecuting: boolean;
  currentStep: ClaimStep;
  claimTxHash?: Hex;
  error?: { message: string; txHash?: Hex; step?: ClaimFailedStep };
  transactionId?: string;
  destinationChainId?: number;
}

export type ClaimExecutionResult = {
  status: 'success' | 'error';
  transactionId: string;
  destinationChainId: number;
  claimTxHash?: Hex;
  error?: { message: string; txHash?: Hex; step?: ClaimFailedStep };
};

import type { Hex } from 'viem';

import type { AggkitFailedNetwork } from '@agglayer/sdk';

export type TransactionStatus = 'BRIDGED' | 'LEAF_INCLUDED' | 'READY_TO_CLAIM' | 'CLAIMED';

export interface Transaction {
  hubUID: string;
  txSender: string;
  fromAddress: string;
  receiverAddress: string;
  sourceNetwork: number;
  destinationNetwork: number;
  amount: string;
  status: TransactionStatus;
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
  globalIndex?: string;
  originTokenAddress: string;
  originTokenNetwork: number;
  timestamp: number;
  leafIndex: number;
}

export interface TransactionsResponse {
  status: string;
  data: Transaction[];
  pagination: {
    total: number;
    limit: number;
    nextStartAfterCursor?: string;
  };
  error?: string;
  // Per-network fan-out failures from AggkitBridgeAggregator.getActivity.
  // A network failing does not fail the whole page — its rows are simply
  // absent. Consumed by the partial-failure notice in transactionsView.tsx.
  failedNetworks?: AggkitFailedNetwork[];
}

export interface TransactionFilters {
  fromAddress?: string;
  sourceNetworkIds?: number[];
  destinationNetworkIds?: number[];
  updatedSince?: number;
  status?: TransactionStatus;
  order?: 'asc' | 'desc';
  limit?: number;
  startAfter?: string;
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

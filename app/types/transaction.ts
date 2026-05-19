import type { Hex } from 'viem';

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
  leafIndexForProof?: number;
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

export interface ClaimExecutionState {
  isExecuting: boolean;
  currentStep: ClaimStep;
  claimTxHash?: Hex;
  error?: { message: string; txHash?: Hex };
  transactionId?: string;
  destinationChainId?: number;
}

export type ClaimExecutionResult = {
  status: 'success' | 'error';
  transactionId: string;
  destinationChainId: number;
  claimTxHash?: Hex;
  error?: { message: string; txHash?: Hex };
};

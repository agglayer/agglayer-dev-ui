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
  blockNumber: number;
  originTokenAddress: string;
  originTokenNetwork: number;
  timestamp: number;
  leafIndex: number;
  leafIndexForProof: number;
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
  sourceNetworkIds?: string;
  destinationNetworkIds?: string;
  updatedSince?: number;
  status?: TransactionStatus;
  order?: 'asc' | 'desc';
  limit?: number;
  startAfter?: string;
}

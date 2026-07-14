import type { TransactionFilters, TransactionsResponse } from '@/app/types/transaction';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

// Thin wrapper over AggkitBridgeAggregator.getActivity (design.md §1 row 1, §2).
// The old bridge-hub `/transactions` endpoint supported server-side
// sourceNetworkIds/destinationNetworkIds/updatedSince/status filtering; aggkit
// has no equivalents (design.md §9 risks #1, #2). sourceNetworkIds/
// destinationNetworkIds/updatedSince are dropped (the aggregator always fans
// out across every configured network, and block_timestamp DESC sort already
// surfaces newest first); `status` is applied client-side below since it's
// still exposed as a UI filter (e.g. useReadyToClaimCount, transactionsView's
// status tabs).
export const fetchTransactions = async (params: {
  aggregator: AggkitBridgeAggregator;
  filters?: TransactionFilters;
}): Promise<TransactionsResponse> => {
  const { aggregator, filters = {} } = params;

  if (!filters.fromAddress) {
    throw new Error('TRANSACTIONS_MISSING_FROM_ADDRESS');
  }

  const page = await aggregator.getActivity({
    fromAddress: filters.fromAddress,
    ...(filters.limit !== undefined ? { pageSize: filters.limit } : {}),
    ...(filters.startAfter !== undefined ? { cursor: filters.startAfter } : {}),
    ...(filters.order !== undefined ? { order: filters.order } : {})
  });

  const data = filters.status
    ? page.data.filter((transaction) => transaction.status === filters.status)
    : page.data;

  return {
    status: 'success',
    data,
    pagination: page.pagination,
    failedNetworks: page.failedNetworks
  };
};

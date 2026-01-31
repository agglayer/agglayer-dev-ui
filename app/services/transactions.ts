import { APP_MODE_CONFIG } from '@/app/config';
import { AppMode } from '@/app/types/appMode';
import type { TransactionsResponse, TransactionFilters } from '@/app/types/transaction';
import { getBridgeHubApiBaseUrl } from '@/app/utils/appMode';

const getEnvironmentNetworkIds = (mode: AppMode): number[] => APP_MODE_CONFIG[mode].chains.map((chain) => chain.networkId);

const formatAllowedNetworkIds = (requestedIds: number[] | undefined, allowedIds: number[]): string | undefined => {
  if (!requestedIds?.length) return undefined;

  const allowed = new Set(allowedIds);
  const filtered = requestedIds.filter((id) => allowed.has(id));
  if (!filtered.length) return undefined;

  return [...new Set(filtered)].join(',');
};

const buildTransactionsUrl = (params: { mode: AppMode; filters?: TransactionFilters }): string => {
  const url = new URL(`${getBridgeHubApiBaseUrl(params.mode)}/transactions`);
  const allowedNetworkIds = getEnvironmentNetworkIds(params.mode);
  const fallbackNetworkIds = allowedNetworkIds.length > 0 ? [...new Set(allowedNetworkIds)].join(',') : undefined;

  const sourceNetworkIds =
    formatAllowedNetworkIds(params.filters?.sourceNetworkIds, allowedNetworkIds) ?? fallbackNetworkIds;
  const destinationNetworkIds =
    formatAllowedNetworkIds(params.filters?.destinationNetworkIds, allowedNetworkIds) ?? fallbackNetworkIds;

  if (params.filters?.fromAddress) url.searchParams.set('fromAddress', params.filters.fromAddress);
  if (sourceNetworkIds) url.searchParams.set('sourceNetworkIds', sourceNetworkIds);
  if (destinationNetworkIds) url.searchParams.set('destinationNetworkIds', destinationNetworkIds);
  if (params.filters?.updatedSince !== undefined)
    url.searchParams.set('updatedSince', params.filters.updatedSince.toString());
  if (params.filters?.status) url.searchParams.set('status', params.filters.status);
  if (params.filters?.order) url.searchParams.set('order', params.filters.order);
  if (params.filters?.limit) url.searchParams.set('limit', params.filters.limit.toString());
  if (params.filters?.startAfter) url.searchParams.set('startAfter', params.filters.startAfter);

  return url.toString();
};

export const fetchTransactions = async (params: {
  mode: AppMode;
  filters?: TransactionFilters;
}): Promise<TransactionsResponse> => {
  const url = buildTransactionsUrl({ mode: params.mode, filters: params.filters });
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`TRANSACTIONS_${res.status}: ${msg || 'Request failed'}`);
  }

  const json: TransactionsResponse = await res.json();

  const isSuccess = json.status === 'success';
  if (!isSuccess || !json.data) {
    throw new Error(json.error || 'TRANSACTIONS_INVALID_RESPONSE');
  }

  return json;
};

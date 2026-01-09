import { appConfig } from '@/app/config';
import { SUPPORTED_CHAINS } from '@/app/constants/chains';
import { isTestnetChain } from '@/app/utils/network';
import type { TransactionsResponse, TransactionFilters } from '@/app/types/transaction';

const getEnvironmentNetworkIds = (chainId: number): number[] => {
  const isTestnet = isTestnetChain(chainId);
  return SUPPORTED_CHAINS.filter((chain) => (isTestnet ? chain.isTestnet : !chain.isTestnet))
    .map((chain) => chain.networkId)
    .filter((id): id is number => typeof id === 'number');
};

const coerceNetworkIds = (networkIds: string | undefined, allowedIds: number[]): string | undefined => {
  const requestedIds = networkIds
    ?.split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));

  const base = requestedIds?.length ? requestedIds : allowedIds;
  const filtered = base.filter((id) => allowedIds.includes(id));
  if (filtered.length === 0) return allowedIds.length ? allowedIds.join(',') : undefined;
  return Array.from(new Set(filtered)).join(',');
};

const buildTransactionsUrl = (chainId: number, filters: TransactionFilters = {}): string => {
  const origin = appConfig.BRIDGE_HUB_API;
  if (!origin) {
    throw new Error('BRIDGE_HUB_API missing');
  }

  const network = isTestnetChain(chainId) ? 'testnet' : 'mainnet';
  const url = new URL(`${origin}/${network}/transactions`);
  const allowedNetworkIds = getEnvironmentNetworkIds(chainId);

  const sourceNetworkIds = coerceNetworkIds(filters.sourceNetworkIds, allowedNetworkIds);
  const destinationNetworkIds = coerceNetworkIds(filters.destinationNetworkIds, allowedNetworkIds);

  if (filters.fromAddress) url.searchParams.set('fromAddress', filters.fromAddress);
  if (sourceNetworkIds) url.searchParams.set('sourceNetworkIds', sourceNetworkIds);
  if (destinationNetworkIds) url.searchParams.set('destinationNetworkIds', destinationNetworkIds);
  if (filters.updatedSince !== undefined) url.searchParams.set('updatedSince', filters.updatedSince.toString())
  if (filters.status) url.searchParams.set('status', filters.status);
  if (filters.order) url.searchParams.set('order', filters.order);
  if (filters.limit) url.searchParams.set('limit', filters.limit.toString());
  if (filters.startAfter) url.searchParams.set('startAfter', filters.startAfter);

  return url.toString();
};

export const fetchTransactions = async (
  chainId: number,
  filters: TransactionFilters = {},
): Promise<TransactionsResponse> => {
  const url = buildTransactionsUrl(chainId, filters);
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

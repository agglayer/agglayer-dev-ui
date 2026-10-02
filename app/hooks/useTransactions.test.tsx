import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

// Mirrors useReadyToClaimCount.test.tsx's setup: mocks appMode + the SDK
// aggregator context directly (fetchActivity now goes through
// AggkitBridgeAggregator.getActivity -- see app/services/activity.ts --
// rather than calling fetch() itself, agglayer/sdk#30/#31).
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggkitAggregator: vi.fn()
}));

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { PendingBridgesProvider, usePendingBridges } from '@/app/context/pendingBridges';

import { useTransactions } from './useTransactions';

const wrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <PendingBridgesProvider>{children}</PendingBridgesProvider>
    </QueryClientProvider>
  );
};

const rawBridge = (overrides: Partial<Record<string, unknown>> = {}) => ({
  tx_hash: '0xreal',
  amount: '1',
  block_num: 1,
  block_pos: 0,
  block_timestamp: 0,
  bridge_hash: 'bridge-1',
  deposit_count: 1,
  destination_address: '0xabc',
  destination_network: 1,
  global_index: '1',
  leaf_type: 0,
  metadata: '0x',
  origin_address: '0x0',
  origin_network: 0,
  to_address: '0xabc',
  txn_sender: '0xabc',
  ...overrides
});

// A SINGLE mocked `getActivity` backs every render of the hook under test
// (see `beforeEach` below) -- reassigning `useAggkitAggregator`'s return
// value per call would only take effect on the NEXT render, since
// `aggregator` is captured in `useTransactions`'s closure at render time,
// unlike a stubbed global `fetch` which every call reads fresh regardless
// of when it was last stubbed.
const mockGetActivity = vi.fn();

const mockFetchOk = (bridges: unknown[]) =>
  mockGetActivity.mockResolvedValue({
    bridges: bridges.map((bridge) => ({
      bridge,
      bridge_network_id: 0,
      claim_status: 'pending',
      creation_timestamp: 0,
      last_updated_timestamp: 0
    })),
    count: bridges.length,
    warnings: []
  });

// Same synthetic shape bridgeCard.tsx builds right after a bridge tx confirms
// (see that file's addPendingBridge call).
const makePendingBridge = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    hubUID: 'pending-0xjust-sent',
    txSender: '0xabc',
    fromAddress: '0xabc',
    receiverAddress: '0xabc',
    sourceNetwork: 0,
    destinationNetwork: 1,
    amount: '1',
    status: 'PENDING',
    lastUpdatedAt: 0,
    bridgeHash: 'pending-0xjust-sent',
    metadata: '0x',
    leafType: 'asset',
    depositCount: 0,
    transactionIndex: 0,
    transactionHash: '0xjust-sent',
    blockNumber: 0,
    originTokenAddress: '0x0',
    originTokenNetwork: 0,
    timestamp: 0,
    leafIndex: 0,
    ...overrides
  }) as Transaction;

const renderTransactions = (fromAddress = '0xabc') =>
  renderHook(
    () => ({
      pending: usePendingBridges(),
      transactions: useTransactions({
        chainId: 1,
        filters: { fromAddress },
        enabled: true
      })
    }),
    { wrapper }
  );

describe('useTransactions -- pending bridge placeholders', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({
      mode: 'mainnet',
      config: { aggkitBridgeApis: { 1: 'https://proxy.example' } }
    } as unknown as ReturnType<typeof useAppMode>);
    vi.mocked(useAggkitAggregator).mockReturnValue({
      getActivity: mockGetActivity
    } as unknown as AggkitBridgeAggregator);
  });

  afterEach(() => {
    mockGetActivity.mockReset();
  });

  it('shows a locally-added placeholder immediately, before the activity feed reports it', async () => {
    mockFetchOk([]);
    const { result } = renderTransactions();

    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));
    expect(result.current.transactions.transactions).toHaveLength(0);

    act(() => {
      result.current.pending.addPendingBridge(makePendingBridge());
    });

    expect(result.current.transactions.transactions).toHaveLength(1);
    expect(result.current.transactions.transactions[0].transactionHash).toBe('0xjust-sent');
    expect(result.current.transactions.transactions[0].status).toBe('PENDING');
  });

  it('drops the placeholder once the real activity feed reports the same transactionHash', async () => {
    mockFetchOk([]);
    const { result } = renderTransactions();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));

    act(() => {
      result.current.pending.addPendingBridge(makePendingBridge());
    });
    expect(result.current.transactions.transactions).toHaveLength(1);

    // The activity endpoint has now indexed it -- same tx_hash, real data.
    mockFetchOk([rawBridge({ tx_hash: '0xjust-sent', bridge_hash: 'bridge-real' })]);
    await act(() => result.current.transactions.refetch());

    await waitFor(() => expect(result.current.pending.pendingBridges).toHaveLength(0));
    expect(result.current.transactions.transactions).toHaveLength(1);
    // The surviving row is the real activity one (it carries the wire's
    // bridge_hash), not the local placeholder -- whose hubUID/bridgeHash are
    // both `pending-0xjust-sent`.
    expect(result.current.transactions.transactions[0].bridgeHash).toBe('bridge-real');
    expect(result.current.transactions.transactions[0].hubUID).toBe('0xjust-sent:1');
  });

  it('does not surface a placeholder added for a different address', async () => {
    mockFetchOk([]);
    const { result } = renderTransactions('0xabc');
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));

    act(() => {
      result.current.pending.addPendingBridge(makePendingBridge({ fromAddress: '0xsomeone-else' }));
    });

    expect(result.current.transactions.transactions).toHaveLength(0);
  });
});

// A fake tracker: serves `bridges` (newest first) the way getActivity pages
// them, so the tests can change what it holds between requests.
const PAGE_SIZE = 2;
let trackerBridges: number[] = [];
const bridgeItem = (id: number) => ({
  bridge: rawBridge({ tx_hash: `0xtx${id}`, deposit_count: id }),
  bridge_network_id: 0,
  claim_status: 'pending',
  creation_timestamp: id,
  last_updated_timestamp: id
});
const serveFromTracker = ({ pageNumber, pageSize }: { pageNumber: number; pageSize: number }) =>
  Promise.resolve({
    bridges: trackerBridges
      .slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
      .map(bridgeItem),
    count: trackerBridges.length,
    warnings: []
  });
const requestedPages = () =>
  mockGetActivity.mock.calls.map(([params]) => (params as { pageNumber: number }).pageNumber);
const hubUIDs = (result: { current: { transactions: { transactions: Transaction[] } } }) =>
  result.current.transactions.transactions.map((tx) => tx.hubUID);

describe('useTransactions -- server-side filter and pagination', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({
      mode: 'mainnet',
      config: { aggkitBridgeApis: { 1: 'https://proxy.example' } }
    } as unknown as ReturnType<typeof useAppMode>);
    vi.mocked(useAggkitAggregator).mockReturnValue({
      getActivity: mockGetActivity
    } as unknown as AggkitBridgeAggregator);
    trackerBridges = [5, 4, 3, 2, 1];
    mockGetActivity.mockImplementation(serveFromTracker);
  });

  afterEach(() => {
    mockGetActivity.mockReset();
  });

  const renderPaged = (status?: Transaction['status']) =>
    renderHook(
      () => ({
        transactions: useTransactions({
          chainId: 1,
          filters: { fromAddress: '0xabc', status, limit: PAGE_SIZE },
          enabled: true
        })
      }),
      { wrapper }
    );

  it('sends the status as filterBridges and requests the first page', async () => {
    const { result } = renderPaged('READY_TO_CLAIM');
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));

    expect(mockGetActivity).toHaveBeenCalledWith({
      fromAddress: '0xabc',
      includeTracking: true,
      filterBridges: 'readyToClaim',
      pageNumber: 1,
      pageSize: PAGE_SIZE
    });
  });

  it('shows the first page, with the server-side count as the total', async () => {
    const { result } = renderPaged();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));

    expect(hubUIDs(result)).toEqual(['0xtx5:5', '0xtx4:4']);
    expect(result.current.transactions.totalCount).toBe(5);
    expect(result.current.transactions.hasNextPage).toBe(true);
  });

  it('re-requests page 1 and then only the next page when page 1 is unchanged', async () => {
    const { result } = renderPaged();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));
    mockGetActivity.mockClear();

    await act(() => result.current.transactions.fetchNextPage());

    expect(requestedPages()).toEqual([1, 2]);
    expect(hubUIDs(result)).toEqual(['0xtx5:5', '0xtx4:4', '0xtx3:3', '0xtx2:2']);
    expect(result.current.transactions.hasNextPage).toBe(true);
  });

  it('stops offering "load more" once the last page is loaded', async () => {
    const { result } = renderPaged();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));

    await act(() => result.current.transactions.fetchNextPage());
    await act(() => result.current.transactions.fetchNextPage());

    expect(hubUIDs(result)).toHaveLength(5);
    expect(result.current.transactions.hasNextPage).toBe(false);
  });

  it('reloads every loaded page, plus the next, when a new bridge landed on page 1', async () => {
    const { result } = renderPaged();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));
    await act(() => result.current.transactions.fetchNextPage());
    expect(hubUIDs(result)).toHaveLength(4);
    mockGetActivity.mockClear();

    // A bridge arrives: every older one shifts down a slot.
    trackerBridges = [6, 5, 4, 3, 2, 1];
    await act(() => result.current.transactions.fetchNextPage());

    expect(requestedPages()).toEqual([1, 2, 3]);
    // No row twice, none missing, newest first.
    expect(hubUIDs(result)).toEqual([
      '0xtx6:6',
      '0xtx5:5',
      '0xtx4:4',
      '0xtx3:3',
      '0xtx2:2',
      '0xtx1:1'
    ]);
    expect(result.current.transactions.totalCount).toBe(6);
  });

  it('treats a page 1 with the same total but a different bridge as changed', async () => {
    const { result } = renderPaged();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));
    await act(() => result.current.transactions.fetchNextPage());
    mockGetActivity.mockClear();

    // One bridge arrives while another leaves the set: same count, same
    // page size, different page 1.
    trackerBridges = [6, 5, 3, 2, 1];
    await act(() => result.current.transactions.fetchNextPage());

    expect(requestedPages()).toEqual([1, 2, 3]);
    expect(hubUIDs(result)).toEqual(['0xtx6:6', '0xtx5:5', '0xtx3:3', '0xtx2:2', '0xtx1:1']);
  });

  it('keeps the loaded pages and surfaces an error when loading more fails', async () => {
    const { result } = renderPaged();
    await waitFor(() => expect(result.current.transactions.isLoading).toBe(false));

    mockGetActivity.mockRejectedValueOnce(new Error('boom'));
    await act(() => result.current.transactions.fetchNextPage());

    expect(hubUIDs(result)).toEqual(['0xtx5:5', '0xtx4:4']);
    expect(result.current.transactions.fetchNextPageError?.message).toBe('boom');
    expect(result.current.transactions.error).toBeNull();
  });
});

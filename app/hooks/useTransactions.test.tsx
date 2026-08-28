import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors useReadyToClaimCount.test.tsx's setup: mocks appMode and stubs
// `fetch` directly rather than the SDK, since fetchActivity is a plain fetch
// call (see app/services/activity.ts).
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

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

const mockFetchOk = (bridges: unknown[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          from_address: [],
          bridges: bridges.map((bridge) => ({
            bridge,
            bridge_network_id: 0,
            claimed: 'false',
            creation_timestamp: 0,
            last_updated_timestamp: 0
          }))
        })
    })
  );

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
        filters: { fromAddress, order: 'desc' as const },
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(result.current.transactions.transactions[0].hubUID).toBe('bridge-real');
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

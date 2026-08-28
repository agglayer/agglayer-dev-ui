import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Since S-review 2026-08-28, useReadyToClaimCount reads from the same
// GET /tracker/v1/activity/from/{address} call useTransactions makes (see
// app/services/activity.ts) instead of AggkitBridgeAggregator's fan-out, so
// this suite mocks `fetch` directly rather than useAggkitAggregator.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

import { useAppMode } from '@/app/context/appMode';

import { useReadyToClaimCount } from './useReadyToClaimCount';

const wrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};

const rawBridge = (bridgeHash: string) => ({
  tx_hash: '0x1',
  amount: '1',
  block_num: 1,
  block_pos: 0,
  block_timestamp: 0,
  bridge_hash: bridgeHash,
  deposit_count: 1,
  destination_address: '0xabc',
  destination_network: 1,
  global_index: '1',
  leaf_type: 0,
  metadata: '0x',
  origin_address: '0x0',
  origin_network: 0,
  to_address: '0xabc',
  txn_sender: '0xabc'
});

const mockFetchOk = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body)
    })
  );

describe('useReadyToClaimCount', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({
      mode: 'mainnet',
      config: { aggkitBridgeApis: { 1: 'https://proxy.example' } }
    } as unknown as ReturnType<typeof useAppMode>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('counts only bridges that are unclaimed and waiting on just the claim step', async () => {
    mockFetchOk({
      from_address: [],
      bridges: [
        // claimed -- not counted
        {
          bridge: rawBridge('0x1'),
          bridge_network_id: 0,
          claimed: 'true',
          creation_timestamp: 0,
          last_updated_timestamp: 0
        },
        // unclaimed, current step is WaitingClaim/inProgress -- counted
        {
          bridge: rawBridge('0x2'),
          bridge_network_id: 0,
          claimed: 'false',
          creation_timestamp: 0,
          last_updated_timestamp: 0,
          tracking: {
            tracking_status: 'running',
            network_id: 0,
            tx_hash: '0x2',
            bridge_status: null,
            step_index: 0,
            all_steps: [{ step_index: 0, step_name: 'WaitingClaim', status: 'inProgress' }],
            error: null
          }
        },
        // unclaimed, no tracking yet -- not counted (PENDING, not READY_TO_CLAIM)
        {
          bridge: rawBridge('0x3'),
          bridge_network_id: 0,
          claimed: 'false',
          creation_timestamp: 0,
          last_updated_timestamp: 0
        }
      ]
    });

    const { result } = renderHook(() => useReadyToClaimCount({ chainId: 1, address: '0xabc' }), {
      wrapper
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(1);
    expect(result.current.isError).toBe(false);
  });
});

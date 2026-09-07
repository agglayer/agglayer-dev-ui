import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

// Since S-review 2026-08-28, useReadyToClaimCount reads from the same
// GET /tracker/v1/activity/from/{address} call useTransactions makes (see
// app/services/activity.ts) -- since agglayer/sdk#30/#31, that call goes
// through AggkitBridgeAggregator.getActivity rather than a raw fetch(), so
// this suite mocks useAggkitAggregator directly.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggkitAggregator: vi.fn()
}));

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
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

const mockGetActivity = vi.fn();

const mockFetchOk = (body: { bridges: unknown[]; warnings?: unknown[] }) =>
  mockGetActivity.mockResolvedValue({ warnings: [], ...body });

describe('useReadyToClaimCount', () => {
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

  it('counts only bridges that are unclaimed and waiting on just the claim step', async () => {
    // BREAKING (agglayer/aggkit#1830, SDK PR #1831): the old `claimed`
    // tri-state + hand-inspected `tracking` is gone -- `claim_status` already
    // gives this signal directly (see activity.ts's deriveStatus).
    mockFetchOk({
      bridges: [
        // claimed -- not counted
        {
          bridge: rawBridge('0x1'),
          bridge_network_id: 0,
          claim_status: 'claimed',
          creation_timestamp: 0,
          last_updated_timestamp: 0
        },
        // unclaimed, ready to claim -- counted
        {
          bridge: rawBridge('0x2'),
          bridge_network_id: 0,
          claim_status: 'readyToClaim',
          creation_timestamp: 0,
          last_updated_timestamp: 0
        },
        // unclaimed, not yet ready -- not counted (PENDING, not READY_TO_CLAIM)
        {
          bridge: rawBridge('0x3'),
          bridge_network_id: 0,
          claim_status: 'pending',
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

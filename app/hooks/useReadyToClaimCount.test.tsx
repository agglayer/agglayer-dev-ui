import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

// useReadyToClaimCount calls AggkitBridgeAggregator.getActivity with
// filterBridges: 'readyToClaim' and reads the total off `count`, so this suite
// mocks useAggkitAggregator directly.
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

const mockGetActivity = vi.fn();

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

  it('asks the tracker for the ready-to-claim total instead of loading the whole history', async () => {
    // The badge needs only the total: a page of size 1 filtered server-side
    // to readyToClaim, with the answer read off `count`.
    mockGetActivity.mockResolvedValue({ bridges: [], count: 7, warnings: [] });

    const { result } = renderHook(() => useReadyToClaimCount({ chainId: 1, address: '0xabc' }), {
      wrapper
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(7);
    expect(result.current.isError).toBe(false);
    expect(mockGetActivity).toHaveBeenCalledTimes(1);
    expect(mockGetActivity).toHaveBeenCalledWith({
      fromAddress: '0xabc',
      filterBridges: 'readyToClaim',
      pageNumber: 1,
      pageSize: 1
    });
  });
});

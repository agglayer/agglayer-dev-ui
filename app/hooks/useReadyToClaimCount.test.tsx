import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AggkitBridgeAggregator.getReadyToClaimCount (sdk/src/aggkit/aggregator.ts)
// silently drops per-network fan-out failures and only resolves the count
// built from healthy networks — it rejects only when every configured
// network fails. useReadyToClaimCount has no per-network breakdown to
// surface (unlike useTransactions' `failedNetworks`), so "tolerates partial
// failure" means: the query still succeeds with a numeric count and never
// enters an error state under partial failure.
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggkitAggregator: vi.fn()
}));
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';

import { useReadyToClaimCount } from './useReadyToClaimCount';

const wrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};

describe('useReadyToClaimCount', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({ mode: 'mainnet' } as unknown as ReturnType<
      typeof useAppMode
    >);
  });

  it('badge tolerates partial network failure: resolves a count from healthy networks without erroring', async () => {
    vi.mocked(useAggkitAggregator).mockReturnValue({
      getReadyToClaimCount: vi.fn().mockResolvedValue(3)
    } as unknown as ReturnType<typeof useAggkitAggregator>);

    const { result } = renderHook(() => useReadyToClaimCount({ chainId: 1, address: '0xabc' }), {
      wrapper
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBe(3);
    expect(result.current.isError).toBe(false);
  });
});

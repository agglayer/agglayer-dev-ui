import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useBridgeTracking's whole job (design.md §Tracker) is deciding WHEN to
// stop polling -- this suite drives its `refetchInterval` end to end through
// real react-query, faking time to assert no further `getBridgeTracking`
// calls happen once terminal, and that calls keep coming for every
// non-terminal shape (including a step-level error, which the hook
// explicitly does not treat as terminal).
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggkitAggregator: vi.fn()
}));
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

import {
  errorGiveupFixture,
  l1l2FinishedFixture,
  l2l2RunningStepErrorFixture
} from '@/app/__fixtures__/tracker';
import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';

import { useBridgeTracking } from './useBridgeTracking';

const makeTransaction = (status: Transaction['status'] = 'READY_TO_CLAIM'): Transaction =>
  ({
    hubUID: 'tx-1',
    txSender: '0x1',
    fromAddress: '0x1',
    receiverAddress: '0x1',
    sourceNetwork: 1,
    destinationNetwork: 0,
    amount: '1',
    status,
    lastUpdatedAt: 0,
    bridgeHash: '0x1',
    metadata: '0x',
    leafType: 'asset',
    depositCount: 1,
    transactionIndex: 0,
    transactionHash: '0xabc',
    blockNumber: 1,
    originTokenAddress: '0x0',
    originTokenNetwork: 0,
    timestamp: 0,
    leafIndex: 1
  }) as Transaction;

const renderTracking = (transaction: Transaction) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useBridgeTracking(transaction), { wrapper });
};

const mockAggregator = (getBridgeTracking: ReturnType<typeof vi.fn>) =>
  vi
    .mocked(useAggkitAggregator)
    .mockReturnValue({ getBridgeTracking } as unknown as ReturnType<typeof useAggkitAggregator>);

// Advances fake time and flushes the resulting react-query state update
// inside `act`, so React doesn't warn about an update outside of it.
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('useBridgeTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(useAppMode).mockReturnValue({ mode: 'devnet' } as unknown as ReturnType<
      typeof useAppMode
    >);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling once tracking_status is finished', async () => {
    const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
    mockAggregator(getBridgeTracking);

    renderTracking(makeTransaction());
    await advance(0);
    expect(getBridgeTracking).toHaveBeenCalledTimes(1);

    // Well past several poll intervals -- a terminal query must never
    // refetch again.
    await advance(20000);
    expect(getBridgeTracking).toHaveBeenCalledTimes(1);
  });

  it('stops polling on the giving-up terminal (error + null bridge_status)', async () => {
    const getBridgeTracking = vi.fn().mockResolvedValue(errorGiveupFixture);
    mockAggregator(getBridgeTracking);

    renderTracking(makeTransaction());
    await advance(0);
    expect(getBridgeTracking).toHaveBeenCalledTimes(1);

    await advance(20000);
    expect(getBridgeTracking).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a step-level error (tracking_status 'error' but bridge_status populated)", async () => {
    const getBridgeTracking = vi.fn().mockResolvedValue(l2l2RunningStepErrorFixture);
    mockAggregator(getBridgeTracking);

    renderTracking(makeTransaction());
    await advance(0);
    expect(getBridgeTracking).toHaveBeenCalledTimes(1);

    await advance(5000);
    expect(getBridgeTracking).toHaveBeenCalledTimes(2);

    await advance(5000);
    expect(getBridgeTracking).toHaveBeenCalledTimes(3);
  });

  it('never queries a CLAIMED row (query disabled)', async () => {
    const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
    mockAggregator(getBridgeTracking);

    renderTracking(makeTransaction('CLAIMED'));
    await advance(20000);
    expect(getBridgeTracking).not.toHaveBeenCalled();
  });
});

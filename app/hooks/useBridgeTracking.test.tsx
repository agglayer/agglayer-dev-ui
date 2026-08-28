import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Since S-review 2026-08-28, tracking data arrives embedded on each unclaimed
// Transaction (the activity endpoint is always called with
// includeTracking=true, see app/services/activity.ts) instead of via its own
// per-row poll, so this hook is mostly a plain passthrough. The exception is
// the on-demand path (`options.enabled`): a CLAIMED row has no embedded
// tracking at all, so opting in there drives a real per-tx poll of
// AggkitBridgeAggregator.getBridgeTracking end to end through real
// react-query, faking time to assert it stops once terminal and keeps going
// otherwise (including through a step-level error, which is NOT terminal).
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggkitAggregator: vi.fn()
}));
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

import {
  errorGiveupFixture,
  l1l2FinishedFixture,
  l1l2RunningFixture,
  l2l2RunningStepErrorFixture
} from '@/app/__fixtures__/tracker';
import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';

import { useBridgeTracking } from './useBridgeTracking';

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    hubUID: 'tx-1',
    txSender: '0x1',
    fromAddress: '0x1',
    receiverAddress: '0x1',
    sourceNetwork: 1,
    destinationNetwork: 0,
    amount: '1',
    status: 'READY_TO_CLAIM',
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
    leafIndex: 1,
    ...overrides
  }) as Transaction;

const renderTracking = (transaction: Transaction, options?: { enabled?: boolean }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useBridgeTracking(transaction, options), { wrapper });
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

  describe('embedded tracking (the default, live path)', () => {
    it('returns the tracking data already embedded on the transaction, without fetching', async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
      mockAggregator(getBridgeTracking);

      const { result } = renderTracking(makeTransaction({ tracking: l1l2RunningFixture }));
      expect(result.current.data).toBe(l1l2RunningFixture);

      await advance(20000);
      expect(getBridgeTracking).not.toHaveBeenCalled();
    });

    it('embedded tracking wins even when the caller passes enabled: true', async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
      mockAggregator(getBridgeTracking);

      const { result } = renderTracking(makeTransaction({ tracking: l1l2RunningFixture }), {
        enabled: true
      });
      expect(result.current.data).toBe(l1l2RunningFixture);
      expect(getBridgeTracking).not.toHaveBeenCalled();
    });

    it('returns undefined and never fetches when there is no embedded tracking and on-demand is not enabled', async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
      mockAggregator(getBridgeTracking);

      const { result } = renderTracking(
        makeTransaction({ status: 'CLAIMED', tracking: undefined })
      );
      expect(result.current.data).toBeUndefined();

      await advance(20000);
      expect(getBridgeTracking).not.toHaveBeenCalled();
    });
  });

  describe('on-demand tracking (CLAIMED rows, opted in via options.enabled)', () => {
    it('fetches from the aggkit tracker, keyed by source network + tx hash', async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
      mockAggregator(getBridgeTracking);

      renderTracking(makeTransaction({ status: 'CLAIMED' }), { enabled: true });
      await advance(0);

      expect(getBridgeTracking).toHaveBeenCalledWith(1, '0xabc');
    });

    it('stops polling once tracking_status is finished', async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(l1l2FinishedFixture);
      mockAggregator(getBridgeTracking);

      const { result } = renderTracking(makeTransaction({ status: 'CLAIMED' }), { enabled: true });
      await advance(0);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);
      expect(result.current.data).toEqual(l1l2FinishedFixture);

      // Well past several poll intervals -- a terminal query must never
      // refetch again.
      await advance(20000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);
    });

    it('stops polling on the giving-up terminal (error + null bridge_status)', async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(errorGiveupFixture);
      mockAggregator(getBridgeTracking);

      renderTracking(makeTransaction({ status: 'CLAIMED' }), { enabled: true });
      await advance(0);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);

      await advance(20000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);
    });

    it("keeps polling through a step-level error (tracking_status 'error' but bridge_status populated)", async () => {
      const getBridgeTracking = vi.fn().mockResolvedValue(l2l2RunningStepErrorFixture);
      mockAggregator(getBridgeTracking);

      renderTracking(makeTransaction({ status: 'CLAIMED' }), { enabled: true });
      await advance(0);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);

      await advance(5000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(2);

      await advance(5000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(3);
    });

    it('keeps polling while the response is not yet complete, and surfaces the final data once it is', async () => {
      // First call lands mid-resolution (registered/running); every call
      // after that reports finished -- exactly the "retry until
      // tracking_status is finished" case this on-demand path exists for.
      const getBridgeTracking = vi
        .fn()
        .mockResolvedValueOnce(l1l2RunningFixture)
        .mockResolvedValue(l1l2FinishedFixture);
      mockAggregator(getBridgeTracking);

      const { result } = renderTracking(makeTransaction({ status: 'CLAIMED' }), { enabled: true });
      await advance(0);
      expect(result.current.data).toEqual(l1l2RunningFixture);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);

      // One poll interval later, the retry has fired again but the update
      // may not have committed within the same tick yet.
      await advance(5000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(2);

      // By the next interval boundary the finished result is visible, and
      // polling has stopped (still only 2 calls -- terminal).
      await advance(5000);
      expect(result.current.data).toEqual(l1l2FinishedFixture);
      expect(getBridgeTracking).toHaveBeenCalledTimes(2);

      await advance(20000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(2);
    });

    it('keeps polling after the query hard-errors (react-query exhausts retries)', async () => {
      const getBridgeTracking = vi.fn().mockRejectedValue(new Error('boom'));
      mockAggregator(getBridgeTracking);

      renderTracking(makeTransaction({ status: 'CLAIMED' }), { enabled: true });
      await advance(0);
      expect(getBridgeTracking).toHaveBeenCalledTimes(1);

      // A hard query error (e.g. a transient proxy blip) must not
      // permanently freeze this row's tracker -- polling should self-heal at
      // the normal cadence rather than stop until remount.
      await advance(5000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(2);

      await advance(5000);
      expect(getBridgeTracking).toHaveBeenCalledTimes(3);
    });
  });
});

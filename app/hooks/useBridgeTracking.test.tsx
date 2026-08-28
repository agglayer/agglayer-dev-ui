import type { Transaction } from '@/app/types/transaction';

import { l1l2RunningFixture } from '@/app/__fixtures__/tracker';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useBridgeTracking } from './useBridgeTracking';

// Since S-review 2026-08-28, tracking data arrives embedded on each unclaimed
// Transaction (the activity endpoint is always called with
// includeTracking=true, see app/services/activity.ts) instead of via its own
// per-row poll -- useBridgeTracking is now a plain passthrough, so this
// suite only needs to prove it reads that field back, not any
// polling/terminal-state behavior (that lived here before, now moot).
const makeTransaction = (tracking?: Transaction['tracking']): Transaction =>
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
    tracking
  }) as Transaction;

describe('useBridgeTracking', () => {
  it('returns the tracking data already embedded on the transaction', () => {
    const { result } = renderHook(() => useBridgeTracking(makeTransaction(l1l2RunningFixture)));
    expect(result.current.data).toBe(l1l2RunningFixture);
  });

  it('returns undefined when the transaction has no embedded tracking (e.g. CLAIMED, or not yet resolved)', () => {
    const { result } = renderHook(() => useBridgeTracking(makeTransaction(undefined)));
    expect(result.current.data).toBeUndefined();
  });
});

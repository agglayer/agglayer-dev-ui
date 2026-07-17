import type { AutoclaimRouteConfig } from '@/app/types/config';

import { computeAutoclaimGate, getRouteType } from '@/app/utils/autoclaim';
import { describe, expect, it } from 'vitest';

describe('getRouteType', () => {
  it('classifies L1 -> L2 (source is L1, destination is an L2)', () => {
    expect(getRouteType(0, 1)).toBe('l1_to_l2');
  });

  it('classifies L2 -> L1 (source is an L2, destination is L1)', () => {
    // Includes the native-gas-token withdrawal case: recording network is the
    // L2 even though origin_network would be 0.
    expect(getRouteType(1, 0)).toBe('l2_to_l1');
  });

  it('classifies L2 -> L2 (neither side is L1)', () => {
    expect(getRouteType(1, 2)).toBe('l2_to_l2');
  });
});

describe('computeAutoclaimGate', () => {
  const withAutoclaim: AutoclaimRouteConfig = {
    expectedAutoclaim: true,
    waitForAutoclaimMs: 60_000
  };
  const noAutoclaim: AutoclaimRouteConfig = {
    expectedAutoclaim: false,
    waitForAutoclaimMs: 0
  };

  it('is no-autoclaim when the route does not expect autoclaim', () => {
    expect(
      computeAutoclaimGate({ config: noAutoclaim, isReadyToClaim: true, readyAt: 1000, now: 1000 })
    ).toBe('no-autoclaim');
  });

  it('is no-autoclaim when the deposit is not ready to claim', () => {
    expect(
      computeAutoclaimGate({ config: withAutoclaim, isReadyToClaim: false, readyAt: null, now: 0 })
    ).toBe('no-autoclaim');
  });

  it('waits before the grace period has elapsed', () => {
    expect(
      computeAutoclaimGate({
        config: withAutoclaim,
        isReadyToClaim: true,
        readyAt: 1_000,
        now: 1_000 + 59_999
      })
    ).toBe('waiting');
  });

  it('waits when the ready timestamp is not yet recorded', () => {
    expect(
      computeAutoclaimGate({ config: withAutoclaim, isReadyToClaim: true, readyAt: null, now: 0 })
    ).toBe('waiting');
  });

  it('is overdue once the grace period has elapsed', () => {
    expect(
      computeAutoclaimGate({
        config: withAutoclaim,
        isReadyToClaim: true,
        readyAt: 1_000,
        now: 1_000 + 60_000
      })
    ).toBe('overdue');
  });
});

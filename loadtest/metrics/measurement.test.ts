// S45 C3/C4: min / true-median stats, claim-kind derivation, the
// `measurements` block builder and the `## Claim gas and stage latency`
// section renderer.
import { describe, expect, it } from 'vitest';

import type { HopMeasurementRecord } from './measurement';

import {
  buildMeasurements,
  deriveClaimKind,
  minMedMax,
  minMedMaxWei,
  renderMeasurementsSection,
  stageDeltas
} from './measurement';

describe('minMedMax — true median (the global p50 rounds down for even n)', () => {
  it('returns null for no samples', () => {
    expect(minMedMax([])).toBeNull();
    expect(minMedMaxWei([])).toBeNull();
  });

  it('odd n: the middle value', () => {
    expect(minMedMax([30, 10, 20])).toStrictEqual({ n: 3, min: 10, median: 20, max: 30 });
  });

  it('even n: the mean of the two middle values', () => {
    expect(minMedMax([10, 20, 30, 40])).toStrictEqual({ n: 4, min: 10, median: 25, max: 40 });
    expect(minMedMax([7])).toStrictEqual({ n: 1, min: 7, median: 7, max: 7 });
  });

  it('wei variant is bigint-safe and floors the even-n mean', () => {
    const big = BigInt('9007199254740993'); // > 2^53
    expect(minMedMaxWei([big + BigInt(10), big, big + BigInt(3), big + BigInt(4)])).toStrictEqual({
      n: 4,
      min: '9007199254740993',
      median: '9007199254740996',
      max: '9007199254741003'
    });
  });
});

describe('deriveClaimKind', () => {
  const base = { toNetworkId: 85, claimStatus: 'success' as const, alreadyClaimed: false };

  it('eth', () => {
    expect(deriveClaimKind({ ...base, assetKind: 'eth' })).toBe('eth');
  });

  it('erc20: wrapper deploy / wrapped mint / origin unlock', () => {
    const erc20 = { ...base, assetKind: 'erc20' as const, tokenOriginNetworkId: 82 };
    expect(deriveClaimKind({ ...erc20, wrapperDeployed: true })).toBe('erc20_wrapper_deploy');
    expect(deriveClaimKind({ ...erc20, wrapperDeployed: false })).toBe('erc20_wrapped_mint');
    expect(deriveClaimKind({ ...erc20, toNetworkId: 82, wrapperDeployed: false })).toBe(
      'erc20_origin_unlock'
    );
  });

  it('raced when someone else claimed, none otherwise', () => {
    expect(deriveClaimKind({ ...base, assetKind: 'eth', claimStatus: null, alreadyClaimed: true })).toBe('raced');
    expect(deriveClaimKind({ ...base, assetKind: 'eth', claimStatus: 'reverted', alreadyClaimed: false })).toBe('none');
  });
});

const hop = (over: Partial<HopMeasurementRecord> & { gas?: Record<string, string> } = {}): HopMeasurementRecord => {
  const { gas, ...rest } = over;
  return {
    hopId: 'h',
    lapId: 'l',
    userId: 'u',
    mode: 'headless',
    hopRoute: 'BALI_82->BALI_85',
    fromNetworkId: 82,
    toNetworkId: 85,
    assetKind: 'eth',
    assetIndex: 0,
    outcome: 'hop_completed_manual',
    depositCount: 1,
    bridge: { txHash: '0xb', blockNumber: '10', minedObservedAt: 1000, gas: null },
    stages: {
      l1InfoTreeIndexAt: 11_000,
      l1InfoTreeIndex: 5,
      injectedLeafAt: 21_000,
      injectedLeafIndex: 6,
      claimProofAt: 21_000,
      polls: 9
    },
    readyObservedAt: 26_000,
    claim: {
      txHash: '0xc',
      blockNumber: '20',
      sentAt: 27_000,
      minedObservedAt: 29_000,
      gas: { blockNumber: '20', gasUsed: '100000', effectiveGasPrice: '1000', l1Fee: '120', ...gas },
      claimKind: 'eth'
    },
    ...rest
  };
};

describe('stageDeltas', () => {
  it('computes T1-T0, T2-T0, T3-T0, T3b-T3, T5-T4 and T5-T0 from the record', () => {
    expect(stageDeltas(hop())).toStrictEqual({
      l1InfoTreeIndex: 10_000,
      injectedLeaf: 20_000,
      claimProof: 20_000,
      trackerLag: 5_000,
      claimTx: 2_000,
      endToEnd: 28_000
    });
  });

  it('is null where the probe was off', () => {
    const d = stageDeltas(hop({ stages: null }));
    expect(d.l1InfoTreeIndex).toBeNull();
    expect(d.trackerLag).toBeNull();
    expect(d.claimTx).toBe(2_000);
  });
});

describe('buildMeasurements', () => {
  it('groups claim gas by destination x claimKind and sums L1 fee into the total', () => {
    const block = buildMeasurements(
      [
        hop(),
        hop({ hopId: 'h2' }),
        hop({
          hopId: 'h3',
          claim: { ...hop().claim, gas: { blockNumber: '1', gasUsed: '300000', effectiveGasPrice: '1000' }, claimKind: 'erc20_wrapper_deploy' }
        })
      ],
      5000
    );
    expect(block.probeIntervalMs).toBe(5000);
    expect(block.claimGas).toHaveLength(2);
    const eth = block.claimGas.find((r) => r.claimKind === 'eth');
    expect(eth).toMatchObject({
      toNetworkId: 85,
      n: 2,
      gasUsed: { n: 2, min: '100000', median: '100000', max: '100000' },
      l1Fee: { n: 2, min: '120', median: '120', max: '120' },
      totalFeeWei: { median: String(100000 * 1000 + 120) }
    });
    const wrapper = block.claimGas.find((r) => r.claimKind === 'erc20_wrapper_deploy');
    expect(wrapper?.l1Fee).toBeNull();
    expect(wrapper?.totalFeeWei.median).toBe('300000000');
  });

  it('counts only DONE hops; failed hops are excluded and counted', () => {
    const block = buildMeasurements([hop(), hop({ hopId: 'f', outcome: 'revert_claim' })], null);
    expect(block.hops).toHaveLength(2);
    expect(block.excludedHops).toBe(1);
    expect(block.stageLatency).toHaveLength(1);
    expect(block.stageLatency[0].hops).toBe(1);
    expect(block.stageLatency[0].deltas.endToEnd).toStrictEqual({ n: 1, min: 28_000, median: 28_000, max: 28_000 });
  });
});

describe('renderMeasurementsSection', () => {
  it('says "No measurements recorded." for an absent block (older results.json)', () => {
    expect(renderMeasurementsSection(undefined)).toBe('No measurements recorded.');
  });

  it('renders both tables, the probe resolution and the excluded count', () => {
    const md = renderMeasurementsSection(buildMeasurements([hop(), hop({ hopId: 'f', outcome: 'revert_claim' })], 5000));
    expect(md).toContain('**Claim gas**');
    expect(md).toContain('| 85 | eth | 1 |');
    expect(md).toContain('**Stage latency**');
    expect(md).toContain('Stage probe interval 5000 ms');
    expect(md).toContain('1 hop(s) with a failed, timed-out or aborted outcome are excluded');
    expect(md).toContain('T3-T0 claim-proof available | 1 / 20000 / 20000 / 20000');
  });

  it('states the probe was off when no interval is recorded', () => {
    const md = renderMeasurementsSection(buildMeasurements([hop({ stages: null })], null));
    expect(md).toContain('Stage probe was off');
    expect(md).toContain('T1-T0 l1-info-tree-index available | n/a');
  });
});

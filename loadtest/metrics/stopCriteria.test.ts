import { describe, expect, it } from 'vitest';

import type { CriterionResult } from './stopCriteria';

import { digestFromText, emptyDigest } from './html/ndjsonDigest';
import { evaluateStopCriteria, routeOfHop, SC } from './stopCriteria';

const RING = ['BALI_82', 'BALI_85', 'BALI_82'];
const R_8285 = 'BALI_82->BALI_85';
const BASE = Date.UTC(2026, 9, 14, 9, 0, 0);
const at = (min: number): string => new Date(BASE + min * 60_000).toISOString();

const rec = (min: number, kind: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: at(min), kind, userId: 'u0', mode: 'headless', ...extra });

const hopStart = (min: number, id: string): string =>
  rec(min, 'hop_state', {
    hopId: id,
    lapId: id.replace(/:h\d+$/, ''),
    from: 'PLANNED',
    to: 'BRIDGE_BUILD',
    transition: 'T2'
  });
const hopEnd = (min: number, id: string, route: string, outcome: string): string =>
  rec(min, 'hop_end', { hopId: id, lapId: id.replace(/:h\d+$/, ''), hopRoute: route, outcome });

const evaluate = (
  lines: string[],
  extra: Partial<Parameters<typeof evaluateStopCriteria>[0]> = {}
): Record<string, CriterionResult> => {
  const digest = digestFromText(`${lines.join('\n')}\n`);
  const out = evaluateStopCriteria({ digest, ring: RING, ...extra });
  return Object.fromEntries(out.map((c) => [c.id, c]));
};

describe('evaluateStopCriteria', () => {
  it('returns SC1..SC13 and the gate in order', () => {
    const ids = evaluateStopCriteria({ digest: emptyDigest(true), ring: RING }).map((c) => c.id);
    expect(ids).toStrictEqual([
      'SC1',
      'SC2',
      'SC3',
      'SC4',
      'SC5',
      'SC6',
      'SC7',
      'SC8',
      'SC9',
      'SC10',
      'SC11',
      'SC12',
      'SC13',
      'Gate'
    ]);
  });

  it('marks every ndjson-based criterion not evaluable when the file is missing', () => {
    const out = evaluateStopCriteria({ digest: emptyDigest(false), ring: RING });
    for (const id of ['SC1', 'SC2', 'SC4', 'SC5', 'SC6', 'SC7', 'SC8', 'SC9', 'SC13']) {
      const c = out.find((x) => x.id === id);
      expect(c?.fired, id).toBeNull();
      expect(c?.note).toContain('not found');
    }
  });

  it('SC10 and SC12 are outside the tool', () => {
    const out = evaluateStopCriteria({ digest: emptyDigest(true), ring: RING });
    expect(out.find((c) => c.id === 'SC10')).toMatchObject({ kind: 'outside', fired: null });
    expect(out.find((c) => c.id === 'SC12')).toMatchObject({ kind: 'outside', fired: null });
  });

  describe('SC1', () => {
    it('fires at 5 hard failures and records when', () => {
      const lines = Array.from({ length: 5 }, (_, i) =>
        hopEnd(i + 1, `u0:a0:l${i}:h0`, R_8285, 'proxy_5xx')
      );
      const sc1 = evaluate(lines).SC1;
      expect(sc1.fired).toBe(true);
      expect(sc1.firstFiredAt).toBe(BASE + 5 * 60_000);
    });

    it('does not fire on timeouts (they are watched by SC2/SC3)', () => {
      const lines = Array.from({ length: 6 }, (_, i) =>
        hopEnd(i + 1, `u0:a0:l${i}:h0`, R_8285, 'timeout_ready_to_claim')
      );
      expect(evaluate(lines).SC1.fired).toBe(false);
    });

    it('fires at 2 percent once 50 hops have ended', () => {
      const lines = Array.from({ length: 60 }, (_, i) =>
        hopEnd(i + 1, `u0:a0:l${i}:h0`, R_8285, i < 2 ? 'rpc_error' : 'hop_completed_manual')
      );
      const sc1 = evaluate(lines).SC1;
      expect(sc1.fired).toBe(true);
      expect(sc1.firstFiredAt).toBe(BASE + 50 * 60_000);
    });
  });

  describe('SC2 / SC3 stalls', () => {
    it('SC2 fires after 30 minutes in flight with no success on 82>85', () => {
      const lines = [hopStart(0, 'u0:a0:l0:h0'), rec(31, 'tick')];
      const sc2 = evaluate(lines).SC2;
      expect(sc2.fired).toBe(true);
      expect(sc2.firstFiredAt).toBe(BASE + 30 * 60_000);
    });

    it('SC2 does not fire when a success lands inside the window', () => {
      const lines = [
        hopStart(0, 'u0:a0:l0:h0'),
        hopStart(10, 'u1:a0:l0:h0'),
        hopEnd(25, 'u0:a0:l0:h0', R_8285, 'hop_completed_manual'),
        rec(50, 'tick')
      ];
      expect(evaluate(lines).SC2.fired).toBe(false);
    });

    it('SC3 uses its own 120 minute limit on 85>82', () => {
      const lines = [hopStart(0, 'u0:a0:l0:h1'), rec(119, 'tick')];
      expect(evaluate(lines).SC3.fired).toBe(false);
      expect(evaluate([...lines, rec(121, 'tick')]).SC3.fired).toBe(true);
    });

    it('nothing in flight is not a stall', () => {
      const lines = [
        hopStart(0, 'u0:a0:l0:h0'),
        hopEnd(1, 'u0:a0:l0:h0', R_8285, 'hop_completed_manual'),
        rec(200, 'tick')
      ];
      expect(evaluate(lines).SC2.fired).toBe(false);
    });

    it('is not evaluable when the route is not in the ring', () => {
      const sc2 = evaluate([rec(1, 'tick')], { ring: ['SEPOLIA', 'BALI_82', 'SEPOLIA'] }).SC2;
      expect(sc2.fired).toBeNull();
      expect(sc2.note).toContain('not in this ring');
    });
  });

  describe('SC4 / SC5 error windows', () => {
    const err = (min: number, cls: string): string =>
      rec(min, 'error', { errorClass: cls, message: 'x' });

    it('SC4 fires at 30 proxy errors within 10 minutes', () => {
      const lines = Array.from({ length: 30 }, (_, i) =>
        err(Math.floor(i / 5), i % 2 === 0 ? 'proxy_5xx' : 'proxy_4xx')
      );
      expect(evaluate(lines).SC4.fired).toBe(true);
    });

    it('SC4 ignores the same count spread wider than the window and the excluded classes', () => {
      const spread = Array.from({ length: 30 }, (_, i) => err(i * 2, 'proxy_5xx'));
      expect(evaluate(spread).SC4.fired).toBe(false);
      const excluded = Array.from({ length: 40 }, () => err(1, 'tracker_not_ready'));
      expect(evaluate(excluded).SC4.fired).toBe(false);
    });

    it('SC5 fires at 20 nonce conflicts and reports the rate when tx_sent records exist', () => {
      const lines = [
        ...Array.from({ length: 20 }, (_, i) => err(i, 'nonce_conflict')),
        ...Array.from({ length: 80 }, () =>
          rec(1, 'tx_sent', { hopId: 'h', step: 'claim', txHash: '0xfake' })
        )
      ];
      const sc5 = evaluate(lines).SC5;
      expect(sc5.fired).toBe(true);
      expect(sc5.value).toContain('25.00% of 80');
    });
  });

  describe('SC6 / SC7 / SC8 resource streaks', () => {
    const sample = (min: number, rss: number, cpu: number, elp: number): string =>
      rec(min, 'resource_sample', {
        userId: null,
        mode: null,
        toolRssMb: rss,
        toolCpuPct: cpu,
        browserProcesses: [],
        eventLoopDelayP99Ms: elp
      });

    it('SC6 needs 3 consecutive samples over the limit', () => {
      const two = [sample(1, 5000, 1, 1), sample(2, 5000, 1, 1), sample(3, 100, 1, 1)];
      expect(evaluate(two).SC6.fired).toBe(false);
      const three = [sample(1, 5000, 1, 1), sample(2, 5000, 1, 1), sample(3, 5000, 1, 1)];
      const sc6 = evaluate(three).SC6;
      expect(sc6.fired).toBe(true);
      expect(sc6.firstFiredAt).toBe(BASE + 3 * 60_000);
    });

    it('SC7 needs 12 consecutive and SC8 needs 60', () => {
      const run = (n: number, elp: number, cpu: number): string[] =>
        Array.from({ length: n }, (_, i) => sample(i + 1, 100, cpu, elp));
      expect(evaluate(run(11, 600, 1)).SC7.fired).toBe(false);
      expect(evaluate(run(12, 600, 1)).SC7.fired).toBe(true);
      expect(evaluate(run(59, 1, 95)).SC8.fired).toBe(false);
      expect(evaluate(run(60, 1, 95)).SC8.fired).toBe(true);
    });

    it('a break in the streak resets it', () => {
      const lines = [
        ...Array.from({ length: 11 }, (_, i) => sample(i + 1, 100, 1, 600)),
        sample(12, 100, 1, 1),
        sample(13, 100, 1, 600)
      ];
      expect(evaluate(lines).SC7.fired).toBe(false);
    });
  });

  describe('SC9 wallet floor', () => {
    const bal = (min: number, wei: string): string =>
      rec(min, 'wallet_balance', {
        userId: null,
        mode: null,
        chainKey: 'BALI_82',
        n: 3,
        minWei: wei,
        medianWei: wei,
        maxWei: wei,
        lowest: []
      });

    it('is not evaluable without M1 samples', () => {
      const sc9 = evaluate([rec(1, 'tick')], { gasPerChain: { BALI_82: '0.005' } }).SC9;
      expect(sc9.fired).toBeNull();
      expect(sc9.note).toContain('M1');
    });

    it('fires below 0.2 x gasPerChain', () => {
      const floor = BigInt('1000000000000000'); // 0.001 ETH = 0.2 x 0.005
      const lines = [
        bal(1, (floor + BigInt(1)).toString()),
        bal(2, (floor - BigInt(1)).toString())
      ];
      const sc9 = evaluate(lines, { gasPerChain: { BALI_82: '0.005' } }).SC9;
      expect(sc9.fired).toBe(true);
      expect(sc9.firstFiredAt).toBe(BASE + 2 * 60_000);
    });
  });

  it('SC11 reports spend against the cap when the pump ran', () => {
    const lines = [rec(0, 'pump_state', { userId: 'harness:pump', state: 'started' })];
    const sc11 = evaluate(lines, { pump: { maxTotalSpendWei: '100', totalSpendWei: '40' } }).SC11;
    expect(sc11.fired).toBe(false);
    expect(sc11.value).toContain('of cap 0.0000000000000001 ETH');
    expect(
      evaluate(lines, { pump: { maxTotalSpendWei: '100', totalSpendWei: '140' } }).SC11.fired
    ).toBe(true);
  });

  it('SC13 is a gate at 25 percent skipped ticks', () => {
    const lines = [
      ...Array.from({ length: 3 }, () => rec(1, 'tick')),
      rec(1, 'tick_skipped', { gate: 'claim-proof' })
    ];
    const sc13 = evaluate(lines).SC13;
    expect(sc13.kind).toBe('gate');
    expect(sc13.fired).toBe(true);
  });

  it('the stage gate compares the 82>85 ready-wait p90 to 20 minutes', () => {
    const waits = (ms: number): number[] => Array.from({ length: 10 }, () => ms);
    expect(
      evaluate([rec(1, 'tick')], { readyWaitByRoute: { [R_8285]: waits(12 * 60_000) } }).Gate.fired
    ).toBe(false);
    expect(
      evaluate([rec(1, 'tick')], { readyWaitByRoute: { [R_8285]: waits(25 * 60_000) } }).Gate.fired
    ).toBe(true);
    expect(evaluate([rec(1, 'tick')]).Gate.fired).toBeNull();
    expect(SC.GATE_READY_P90_MS).toBe(1_200_000);
  });
});

describe('routeOfHop', () => {
  it('prefers the route on hop_end and else derives it from the hop index and the ring', () => {
    expect(routeOfHop({ route: 'X->Y', hopIndex: 0 }, RING)).toBe('X->Y');
    expect(routeOfHop({ route: null, hopIndex: 1 }, RING)).toBe('BALI_85->BALI_82');
    expect(routeOfHop({ route: null, hopIndex: 5 }, RING)).toBeNull();
    expect(routeOfHop({ route: null, hopIndex: null }, RING)).toBeNull();
  });
});

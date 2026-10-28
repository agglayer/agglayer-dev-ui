// S53: the pump's schedule on a fake clock. No timers, no I/O — `decidePumpTick`
// is walked by hand the way `workers/pump/l1Pump.ts` drives it.
import { describe, expect, it } from 'vitest';

import type { PumpScheduleConfig, PumpTickInput } from './pumpSchedule';

import { decidePumpTick, pumpGasLimit, pumpWorstCaseWei } from './pumpSchedule';

const GWEI = BigInt(1_000_000_000);
const ETH = BigInt(10) ** BigInt(18);

const config = (over: Partial<PumpScheduleConfig> = {}): PumpScheduleConfig => ({
  intervalMs: 600_000,
  maxTotalSpendWei: (ETH * BigInt(7)) / BigInt(100), // 0.07 ETH
  maxGasPriceWei: BigInt(5) * GWEI,
  amountWei: BigInt(0),
  ...over
});

const input = (over: Partial<PumpTickInput> = {}): PumpTickInput => ({
  now: 0,
  lastTickAt: null,
  pending: false,
  committedWei: BigInt(0),
  gasPriceWei: GWEI / BigInt(1000), // 0.001 gwei
  gasEstimate: BigInt(440_000),
  ...over
});

describe('pump schedule: when it fires', () => {
  it('fires at the very first tick (t = 0)', () => {
    const decision = decidePumpTick(config(), input());
    expect(decision.kind).toBe('fire');
  });

  it('then waits out the interval and fires again exactly on it', () => {
    const cfg = config();
    // First tick at t0, evaluated at the fake time 1_000_000.
    const t0 = 1_000_000;
    expect(decidePumpTick(cfg, input({ now: t0 })).kind).toBe('fire');
    expect(decidePumpTick(cfg, input({ now: t0 + 1, lastTickAt: t0 }))).toStrictEqual({
      kind: 'wait',
      msUntilDue: 599_999
    });
    expect(decidePumpTick(cfg, input({ now: t0 + 599_999, lastTickAt: t0 }))).toStrictEqual({
      kind: 'wait',
      msUntilDue: 1
    });
    expect(decidePumpTick(cfg, input({ now: t0 + 600_000, lastTickAt: t0 })).kind).toBe('fire');
  });

  it('fires 32 times over 5 h 10 min of fake time: t = 0 plus one deposit per 10 min', () => {
    const cfg = config();
    let now = 0;
    let lastTickAt: number | null = null;
    let fired = 0;
    // Drive on a fake clock in 30 s steps for 5 h 10 min.
    for (; now <= 5 * 3_600_000 + 10 * 60_000; now += 30_000) {
      const d = decidePumpTick(cfg, input({ now, lastTickAt }));
      if (d.kind === 'wait') continue;
      expect(d.kind).toBe('fire');
      fired += 1;
      lastTickAt = now;
    }
    expect(fired).toBe(32);
  });
});

describe('pump schedule: gas price pause and resume', () => {
  it('skips with gas_price above the cap, and fires again when the price falls back', () => {
    const cfg = config();
    const t0 = 0;
    const high = BigInt(6) * GWEI;
    expect(decidePumpTick(cfg, input({ now: t0, gasPriceWei: high }))).toStrictEqual({
      kind: 'skip',
      reason: 'gas_price'
    });
    // The skip still consumed the tick: not due again until the next interval.
    expect(
      decidePumpTick(cfg, input({ now: t0 + 100, lastTickAt: t0, gasPriceWei: GWEI })).kind
    ).toBe('wait');
    // Still high at the next tick: paused again.
    expect(
      decidePumpTick(cfg, input({ now: t0 + 600_000, lastTickAt: t0, gasPriceWei: high })).kind
    ).toBe('skip');
    // Price recovered: resumes on its own.
    expect(
      decidePumpTick(
        cfg,
        input({ now: t0 + 1_200_000, lastTickAt: t0 + 600_000, gasPriceWei: GWEI })
      ).kind
    ).toBe('fire');
  });

  it('a price exactly at the cap still fires (the cap is a maximum, not exclusive)', () => {
    const cfg = config();
    expect(decidePumpTick(cfg, input({ gasPriceWei: cfg.maxGasPriceWei })).kind).toBe('fire');
    expect(decidePumpTick(cfg, input({ gasPriceWei: cfg.maxGasPriceWei + BigInt(1) })).kind).toBe(
      'skip'
    );
  });
});

describe('pump schedule: previous_pending', () => {
  it('never sends a second tx while one has no receipt, and reports it ahead of gas and cap', () => {
    const cfg = config();
    expect(decidePumpTick(cfg, input({ pending: true }))).toStrictEqual({
      kind: 'skip',
      reason: 'previous_pending'
    });
    // Even with the gas price too high and the cap blown, pending is reported first.
    expect(
      decidePumpTick(
        cfg,
        input({ pending: true, gasPriceWei: BigInt(99) * GWEI, committedWei: cfg.maxTotalSpendWei })
      )
    ).toStrictEqual({ kind: 'skip', reason: 'previous_pending' });
  });
});

describe('pump schedule: spend cap (counted worst-case)', () => {
  it('the worst case is gas limit (live estimate + 20 %) x the max fee, so the cap is enforced on what a tx is allowed to cost', () => {
    const cfg = config();
    expect(pumpGasLimit(BigInt(445_000))).toBe(BigInt(534_000));
    expect(pumpWorstCaseWei(cfg, BigInt(445_000))).toBe(BigInt(534_000) * BigInt(5) * GWEI);
  });

  it('adds the deposit amount to the worst case', () => {
    const cfg = config({ amountWei: BigInt(1_000_000_000_000) });
    expect(pumpWorstCaseWei(cfg, BigInt(100))).toBe(
      BigInt(120) * BigInt(5) * GWEI + BigInt(1_000_000_000_000)
    );
  });

  it('fires while committed + worst case fits, stops for good the moment it would not', () => {
    const cfg = config();
    const worst = pumpWorstCaseWei(cfg, BigInt(440_000));
    // Exactly at the cap: still allowed (not "exceeds").
    expect(decidePumpTick(cfg, input({ committedWei: cfg.maxTotalSpendWei - worst })).kind).toBe(
      'fire'
    );
    // One wei over: stop.
    expect(
      decidePumpTick(cfg, input({ committedWei: cfg.maxTotalSpendWei - worst + BigInt(1) }))
    ).toStrictEqual({ kind: 'stop', reason: 'cap_reached' });
  });

  it('a still-pending tx is counted at its worst case, so the cap cannot be overrun by a deposit that has not settled', () => {
    const cfg = config();
    const worst = pumpWorstCaseWei(cfg, BigInt(440_000));
    // Committed = settled spend + the pending tx's full allowance. Once that
    // leaves no room for another worst case, the next un-pending tick stops.
    const committed = cfg.maxTotalSpendWei - worst + BigInt(1);
    expect(decidePumpTick(cfg, input({ committedWei: committed })).kind).toBe('stop');
  });

  it('the cap check applies at the real gas estimate: a larger estimate stops earlier', () => {
    const cfg = config();
    const committed = cfg.maxTotalSpendWei - pumpWorstCaseWei(cfg, BigInt(440_000));
    expect(
      decidePumpTick(cfg, input({ committedWei: committed, gasEstimate: BigInt(440_000) })).kind
    ).toBe('fire');
    expect(
      decidePumpTick(cfg, input({ committedWei: committed, gasEstimate: BigInt(460_000) })).kind
    ).toBe('stop');
  });

  it('expected spend at realistic prices (0.001 gwei) is far below the cap: 32 deposits never stop', () => {
    const cfg = config();
    const perDeposit = BigInt(440_000) * (GWEI / BigInt(1000));
    let committed = BigInt(0);
    for (let i = 0; i < 32; i += 1) {
      expect(decidePumpTick(cfg, input({ committedWei: committed })).kind).toBe('fire');
      committed += perDeposit;
    }
    expect(committed < cfg.maxTotalSpendWei).toBe(true);
  });
});

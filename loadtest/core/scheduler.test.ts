// DESIGN §3.5 (token bucket, ramp-up, backpressure, asset interleaving,
// stop) and §3.6 (drain), asserted with a FAKE CLOCK — the "Y bridges per
// minute per user" contract is a number this file measures, not a promise.
import { describe, expect, it } from 'vitest';

import type { InflightLookup, SchedulerDecision } from './scheduler';

import { createFakeClock } from './ring';
import { computeDrainDeadline, createScheduler } from './scheduler';

const HOP_MS = 900_000;

const freeInflight =
  (assetCount = 1): InflightLookup =>
  () => ({
    inflightLapsByAsset: Array.from({ length: assetCount }, () => 0),
    oldestInflightGate: null
  });

// Runs the scheduler forward in `stepMs` increments, collecting every
// decision. This is the whole measurement: nothing sleeps, nothing polls.
const run = (
  scheduler: ReturnType<typeof createScheduler>,
  clock: ReturnType<typeof createFakeClock>,
  untilMs: number,
  inflight: InflightLookup,
  stepMs = 1_000
): SchedulerDecision[] => {
  const decisions: SchedulerDecision[] = [];
  while (clock.now() < untilMs) {
    clock.advance(stepMs);
    decisions.push(...scheduler.pump(inflight));
  }
  return decisions;
};

const countBy = (decisions: readonly SchedulerDecision[], userId: string): number =>
  decisions.filter((d) => d.kind === 'start_lap' && d.userId === userId).length;

describe('scheduler — offered rate (DESIGN §3.5)', () => {
  it('emits exactly Y·Z bridges per user (±1) at steady state', () => {
    const bridgesPerMinutePerUser = 6;
    const durationMinutes = 10;
    const userIds = ['u0', 'u1', 'u2'];
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds,
      bridgesPerMinutePerUser,
      durationMinutes,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 3,
      assetCount: 1,
      hopMs: HOP_MS
    });

    const decisions = run(scheduler, clock, durationMinutes * 60_000 + 60_000, freeInflight());
    const expected = bridgesPerMinutePerUser * durationMinutes;
    for (const userId of userIds) {
      expect(Math.abs(countBy(decisions, userId) - expected)).toBeLessThanOrEqual(1);
    }
    expect(scheduler.counters().ticksIssued).toBe(
      userIds.reduce((sum, userId) => sum + countBy(decisions, userId), 0)
    );
    expect(scheduler.counters().skippedBackpressure).toBe(0);
    expect(scheduler.counters().ticksLostToRamp).toBe(0);
  });

  it('R29 (loadtest/REVIEW.md): a coarse pump cadence (stepMs > periodMs) no longer loses demand', () => {
    // The exact repro REVIEW.md gives: bridgesPerMinutePerUser: 2 (periodMs
    // = 30_000) driven with stepMs = 45_000 for 10 steps — true demand is
    // 450_000 / 30_000 = 15 ticks/user. Before R29's fix, `scheduler.test.ts`
    // never exercised `stepMs > periodMs` (this file's `run()` always used
    // 1000ms, and the one fractional-rate test paired 100ms with rate 2.5),
    // and the OLD code would have delivered only 10 ticks — one per pump()
    // call, capped by the one-token ceiling — silently losing 5.
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 2,
      durationMinutes: 30,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 1000,
      assetCount: 1,
      hopMs: HOP_MS
    });
    const decisions = run(scheduler, clock, 450_000, freeInflight(), 45_000);
    expect(countBy(decisions, 'u0')).toBe(15);
    expect(scheduler.counters().ticksIssued).toBe(15);
  });

  it('R29: ticksExpected is an INDEPENDENT term computed from config alone, not from the bucket', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0', 'u1'],
      bridgesPerMinutePerUser: 2,
      durationMinutes: 10,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 1000,
      assetCount: 1,
      hopMs: HOP_MS
    });
    // users(2) x rate(2) x minutes(10) = 40, known before a single pump().
    expect(scheduler.counters().ticksExpected).toBe(40);
    run(scheduler, clock, 10 * 60_000 + 60_000, freeInflight());
    // ticksExpected does not move once the run starts issuing ticks — it
    // is not derived from ticksIssued/skippedBackpressure/ticksLostToRamp.
    expect(scheduler.counters().ticksExpected).toBe(40);
    expect(Math.abs(scheduler.counters().ticksOffered - 40)).toBeLessThanOrEqual(2);
  });

  it('holds the ±1 bound at a fractional rate and a fine tick granularity', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 2.5,
      durationMinutes: 8,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 5,
      assetCount: 1,
      hopMs: HOP_MS
    });
    const decisions = run(scheduler, clock, 8 * 60_000, freeInflight(), 100);
    expect(Math.abs(countBy(decisions, 'u0') - 20)).toBeLessThanOrEqual(1);
  });

  it('R29 (loadtest/REVIEW.md): a long pump gap BURSTS the full backlog instead of losing it', () => {
    // Credit used to be capped at exactly ONE token's worth regardless of
    // how many periods elapsed between two pump() calls, silently
    // discarding the excess — this test used to assert THAT behaviour
    // ("never bursts... a long gap earns at most one tick"), which is
    // exactly the bug: the pump loop runs on the same Node event loop
    // `runner.ts` samples for `eventLoopDelayP99Ms`, and S17 measured it
    // backed up to 35 433ms p99 — past `periodMs` at the plan's own
    // `--rate 2`. Credit now accrues without a cap and the pump loop drains
    // every whole period as its own tick, so the demand is delivered (as a
    // burst, each tick still independently subject to backpressure) rather
    // than silently vanishing.
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 30,
      rampUpSeconds: 0,
      // High enough that backpressure never bites in THIS test — the
      // backpressure interaction is asserted separately below.
      maxInflightLapsPerUser: 1000,
      assetCount: 1,
      hopMs: HOP_MS
    });
    clock.advance(600_000); // ten idle minutes = 600 periods at Y = 60/min
    const decisions = scheduler.pump(freeInflight());
    expect(decisions).toHaveLength(600);
    expect(decisions.every((d) => d.kind === 'start_lap')).toBe(true);
    expect(scheduler.counters().ticksIssued).toBe(600);
    // The backlog is now fully drained — no leftover credit for a second
    // pump at the same instant.
    expect(scheduler.pump(freeInflight())).toHaveLength(0);
  });

  it('R29: a burst still respects backpressure — later ticks in the same burst see the earlier ones as in-flight', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 30,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 5,
      assetCount: 1,
      hopMs: HOP_MS
    });
    clock.advance(600_000);
    // `freeInflight()` reports 0 in-flight regardless of decisions already
    // made THIS call — so without the burst's own forward-simulation
    // (`providedThisPump` in scheduler.ts), every one of the 600 periods
    // would fire as `start_lap`, silently exceeding
    // `maxInflightLapsPerUser`. With it, only the first 5 do.
    const decisions = scheduler.pump(freeInflight());
    expect(decisions).toHaveLength(600);
    expect(decisions.filter((d) => d.kind === 'start_lap')).toHaveLength(5);
    expect(decisions.filter((d) => d.kind === 'skipped_backpressure')).toHaveLength(595);
    expect(scheduler.counters().skippedBackpressure).toBe(595);
  });

  it('issues no ticks after durationMinutes elapses (§3.5 "Stop")', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 1,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 5,
      assetCount: 1,
      hopMs: HOP_MS
    });
    run(scheduler, clock, 60_000, freeInflight());
    expect(scheduler.phase()).toBe('stopped');
    clock.advance(60_000);
    expect(scheduler.pump(freeInflight())).toEqual([]);
  });
});

describe('scheduler — ramp-up (DESIGN §3.5)', () => {
  it('admits user k at rampUpSeconds × 1000 × k / total, with an empty bucket', () => {
    const clock = createFakeClock(0);
    const userIds = ['u0', 'u1', 'u2', 'u3'];
    const scheduler = createScheduler({
      clock,
      userIds,
      bridgesPerMinutePerUser: 60, // one token per second
      durationMinutes: 5,
      rampUpSeconds: 60,
      maxInflightLapsPerUser: 5,
      assetCount: 1,
      hopMs: HOP_MS
    });

    expect(userIds.map((_, index) => scheduler.admissibleAt(index))).toEqual([
      0, 15_000, 30_000, 45_000
    ]);

    const decisions = run(scheduler, clock, 120_000, freeInflight());
    const firstTickAt = (userId: string): number | undefined =>
      decisions.find((d) => d.kind === 'start_lap' && d.userId === userId)?.at;

    // Bucket starts EMPTY at the ramp-in instant, so the first tick lands one
    // full refill period later — no user front-loads a token it earned
    // before it existed.
    expect(firstTickAt('u0')).toBe(1_000);
    expect(firstTickAt('u1')).toBe(16_000);
    expect(firstTickAt('u2')).toBe(31_000);
    expect(firstTickAt('u3')).toBe(46_000);

    expect(scheduler.phase()).toBe('steady');

    // The tokens the ramp cost are reported, not silently dropped: user k
    // forgoes floor(rate × rampDelay_k) = 0 + 15 + 30 + 45 = 90 ticks.
    expect(scheduler.counters().ticksLostToRamp).toBe(90);
    expect(scheduler.counters().ticksOffered).toBe(
      scheduler.counters().ticksIssued + scheduler.counters().skippedBackpressure + 90
    );
  });

  it('reports the ramping phase until rampUpSeconds has elapsed', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0', 'u1'],
      bridgesPerMinutePerUser: 6,
      durationMinutes: 10,
      rampUpSeconds: 60,
      maxInflightLapsPerUser: 3,
      assetCount: 1,
      hopMs: HOP_MS
    });
    expect(scheduler.phase()).toBe('ramping');
    clock.set(59_999);
    expect(scheduler.phase()).toBe('ramping');
    clock.set(60_000);
    expect(scheduler.phase()).toBe('steady');
  });
});

describe('scheduler — backpressure (DESIGN §3.5)', () => {
  it('drops the tick and records skipped_backpressure with the stalling gate', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 5,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 3,
      assetCount: 1,
      hopMs: HOP_MS
    });
    const saturated: InflightLookup = () => ({
      inflightLapsByAsset: [3],
      oldestInflightGate: 'claimed'
    });

    clock.advance(1_000);
    expect(scheduler.pump(saturated)).toEqual([
      { kind: 'skipped_backpressure', userId: 'u0', at: 1_000, gate: 'claimed' }
    ]);
    expect(scheduler.counters().skippedBackpressure).toBe(1);
    expect(scheduler.counters().ticksIssued).toBe(0);

    // Dropped, NOT queued: the next second yields exactly one tick, never a
    // catch-up burst.
    clock.advance(1_000);
    expect(scheduler.pump(freeInflight())).toEqual([
      { kind: 'start_lap', userId: 'u0', assetIndex: 0, at: 2_000 }
    ]);
  });

  it('skips only the saturated asset ring and round-robins the rest', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 5,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 2,
      assetCount: 3,
      hopMs: HOP_MS
    });
    // Asset 0's ring is full; assets 1 and 2 are free.
    const partly: InflightLookup = () => ({
      inflightLapsByAsset: [2, 0, 0],
      oldestInflightGate: 'activity-index'
    });

    const picked: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      clock.advance(1_000);
      for (const decision of scheduler.pump(partly)) {
        if (decision.kind === 'start_lap') picked.push(decision.assetIndex);
      }
    }
    expect(picked).toEqual([1, 2, 1, 2]);
    expect(scheduler.counters().skippedBackpressure).toBe(0);
  });

  it('counts skipped_backpressure only when EVERY asset ring is at its limit', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 5,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 2,
      assetCount: 2,
      hopMs: HOP_MS
    });
    const full: InflightLookup = () => ({
      inflightLapsByAsset: [2, 2],
      oldestInflightGate: 'l1-info-tree-index'
    });
    clock.advance(1_000);
    const decisions = scheduler.pump(full);
    expect(decisions).toEqual([
      { kind: 'skipped_backpressure', userId: 'u0', at: 1_000, gate: 'l1-info-tree-index' }
    ]);
  });

  it('round-robins across assets when nothing is saturated', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 5,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 5,
      assetCount: 2,
      hopMs: HOP_MS
    });
    const picked: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      clock.advance(1_000);
      for (const decision of scheduler.pump(freeInflight(2))) {
        if (decision.kind === 'start_lap') picked.push(decision.assetIndex);
      }
    }
    expect(picked).toEqual([0, 1, 0, 1]);
  });
});

describe('scheduler — drain and abort (DESIGN §3.6)', () => {
  it('computeDrainDeadline is bounded by hopMs and by each hop’s own budget', () => {
    // Two hops, the youngest started 100 s before drain: its budget runs out
    // at 100_000 + hopMs, which is earlier than drainStart + hopMs.
    expect(
      computeDrainDeadline({
        drainStartedAt: 500_000,
        hopMs: HOP_MS,
        inflightHopStartedAt: [100_000, 20_000]
      })
    ).toBe(100_000 + HOP_MS);
    // A hop that just started cannot push the deadline past drainStart+hopMs.
    expect(
      computeDrainDeadline({
        drainStartedAt: 500_000,
        hopMs: HOP_MS,
        inflightHopStartedAt: [499_000, 500_000]
      })
    ).toBe(500_000 + HOP_MS);
    // Nothing in flight: drain ends immediately.
    expect(
      computeDrainDeadline({ drainStartedAt: 500_000, hopMs: HOP_MS, inflightHopStartedAt: [] })
    ).toBe(500_000);
  });

  it('stops issuing ticks at once and finishes within hopMs of drain start', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0', 'u1'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 10,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 3,
      assetCount: 1,
      hopMs: HOP_MS
    });
    run(scheduler, clock, 30_000, freeInflight());
    const drainStartedAt = clock.now();
    scheduler.beginDrain('sigint', [drainStartedAt - 5_000, drainStartedAt - 200_000]);

    expect(scheduler.phase()).toBe('draining');
    expect(scheduler.pump(freeInflight())).toEqual([]);
    const deadline = scheduler.drainDeadline();
    expect(deadline).not.toBeNull();
    expect((deadline ?? 0) - drainStartedAt).toBeLessThanOrEqual(HOP_MS);
    expect(scheduler.drainCause()).toBe('sigint');
    expect(scheduler.isStopped()).toBe(false);

    clock.set(deadline ?? 0);
    expect(scheduler.isStopped()).toBe(true);
    expect(scheduler.phase()).toBe('stopped');
  });

  it('a second SIGINT during drain cuts the grace period to zero (§3.6 step 5)', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 60,
      durationMinutes: 10,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 3,
      assetCount: 1,
      hopMs: HOP_MS
    });
    clock.set(10_000);
    scheduler.beginDrain('sigint', [9_000]);
    expect(scheduler.isStopped()).toBe(false);
    clock.set(20_000);
    scheduler.beginDrain('sigint', [9_000]);
    expect(scheduler.drainDeadline()).toBe(20_000);
    expect(scheduler.isStopped()).toBe(true);
  });

  it('records duration_elapsed as the abort cause when the run simply ends', () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler({
      clock,
      userIds: ['u0'],
      bridgesPerMinutePerUser: 6,
      durationMinutes: 1,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 3,
      assetCount: 1,
      hopMs: HOP_MS
    });
    run(scheduler, clock, 60_000, freeInflight());
    scheduler.beginDrain('duration_elapsed', []);
    expect(scheduler.drainCause()).toBe('duration_elapsed');
    expect(scheduler.drainDeadline()).toBe(60_000);
    expect(scheduler.isStopped()).toBe(true);
  });
});

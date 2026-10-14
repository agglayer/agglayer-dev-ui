// Unit tests for the metrics collector — DESIGN §5 (percentile math §5.1,
// HTTP samples §5.2, gate accounting §5.4, honesty invariants §5.5) and the
// activity.ndjson half of §6.2.
import { describe, expect, it } from 'vitest';

import { createCollector, createMemoryActivitySink, computeStats } from './collector';

const FAKE_CLOCK = () => {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    }
  };
};

describe('computeStats — percentile math (DESIGN §5.5 invariant 5)', () => {
  it('returns null for an empty sample set (never a zero-filled histogram)', () => {
    expect(computeStats([])).toBeNull();
  });

  it('n=1: every percentile equals the single sample', () => {
    const stats = computeStats([42]);
    expect(stats).toStrictEqual({ n: 1, p50: 42, p90: 42, p99: 42, max: 42 });
  });

  it('known samples: nearest-rank percentiles over [10,20,30,40,50,60,70,80,90,100]', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = computeStats(samples);
    expect(stats).not.toBeNull();
    expect(stats?.n).toBe(10);
    expect(stats?.p50).toBe(50);
    expect(stats?.p90).toBe(90);
    expect(stats?.p99).toBe(100);
    expect(stats?.max).toBe(100);
  });

  it('is order-independent (sorts internally)', () => {
    const a = computeStats([5, 1, 4, 2, 3]);
    const b = computeStats([1, 2, 3, 4, 5]);
    expect(a).toStrictEqual(b);
  });
});

describe('collector — phase timers, note N5 (hop_total only recorded on success)', () => {
  it('an all-failures run never emits a hop_total key at all', () => {
    const collector = createCollector();
    // No recordPhase('hop_total', ...) call at all — mirrors a run where
    // every hop fails before core/ring.ts's `finish()` ever records the
    // success-only hop_total sample (note N5).
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 100
    });
    const snapshot = collector.snapshot();
    expect(snapshot.phases.hop_total).toBeUndefined();
    expect(snapshot.phases.bridge_submit).toBeDefined();
  });

  it('splits by mode (browser vs headless) and omits an empty mode rather than zero-filling it', () => {
    const collector = createCollector();
    collector.recordPhase({
      phase: 'bridge_receipt',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 500
    });
    const snapshot = collector.snapshot();
    expect(snapshot.phases.bridge_receipt?.headless).toStrictEqual({
      n: 1,
      p50: 500,
      p90: 500,
      p99: 500,
      max: 500
    });
    expect(snapshot.phases.bridge_receipt?.browser).toBeNull();
  });

  it('aggregates per-route phases independently of the global phase aggregate', () => {
    const collector = createCollector();
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 100
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L2A->L2B',
      assetKind: 'eth',
      durationMs: 900
    });
    const snapshot = collector.snapshot();
    expect(snapshot.phases.bridge_submit?.headless?.n).toBe(2);
    expect(snapshot.hopsByRoute['L1->L2A'].phases.bridge_submit?.headless?.n).toBe(1);
    expect(snapshot.hopsByRoute['L2A->L2B'].phases.bridge_submit?.headless?.max).toBe(900);
  });

  it('R2 (loadtest/REVIEW.md): a censored sample is counted separately, never mixed into the percentile array', () => {
    const collector = createCollector();
    collector.recordPhase({
      phase: 'ready_to_claim',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 10_000
    });
    collector.recordPhase({
      phase: 'ready_to_claim',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 600_000,
      censored: true
    });
    const snapshot = collector.snapshot();
    // The percentile-bearing sample count stays at the ONE real completion
    // — the censored 600_000ms wait does not pull p99 up toward the
    // timeout budget.
    expect(snapshot.phases.ready_to_claim?.headless).toStrictEqual({
      n: 1,
      p50: 10_000,
      p90: 10_000,
      p99: 10_000,
      max: 10_000
    });
    // But it is not silently absent either — the count is disclosed
    // separately, so a reader can see one more hop entered this phase and
    // never finished it.
    expect(snapshot.phaseCensoredCounts.ready_to_claim).toBe(1);
  });
});

describe('collector — HTTP samples (§5.2, attempt visibility §9.5)', () => {
  it('aggregates status breakdown and marks retries (attempt > 0) without inflating n', () => {
    const collector = createCollector();
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'headless',
      endpointClass: 'bridge/claim-proof[1]',
      method: 'GET',
      status: 200,
      durationMs: 50,
      attempt: 0
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'headless',
      endpointClass: 'bridge/claim-proof[1]',
      method: 'GET',
      status: 200,
      durationMs: 60,
      attempt: 1
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'headless',
      endpointClass: 'bridge/claim-proof[1]',
      method: 'GET',
      status: 404,
      durationMs: 70,
      attempt: 0
    });

    // No `origin` passed on any sample above — defaults to 'ui' (S24), so
    // the aggregate lands under `.ui`, not `.harness`.
    const entry = collector.snapshot().http['bridge/claim-proof[1]'].headless.ui;
    expect(entry?.n).toBe(3);
    expect(entry?.byStatus).toStrictEqual({ '200': 2, '404': 1 });
    expect(entry?.retries).toBe(1);
  });

  it('splits browser vs headless per endpointClass', () => {
    const collector = createCollector();
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 10,
      attempt: 0
    });
    const snapshot = collector.snapshot();
    expect(snapshot.http['tracker/activity'].browser.ui?.n).toBe(1);
    expect(snapshot.http['tracker/activity'].headless.ui).toBeNull();
    expect(snapshot.http['tracker/activity'].headless.harness).toBeNull();
  });

  it('S24 (DESIGN §9.3 finding C16): a sample tagged `harness` never lands in the `ui` figure, and vice versa', () => {
    const collector = createCollector();
    // Two real-UI-shaped browser samples (default origin, no field passed —
    // mirrors every pre-existing call site in the codebase)...
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 10,
      attempt: 0
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 20,
      attempt: 0
    });
    // ...and three explicitly harness-tagged ones (the driver's own
    // control-flow poll) to the SAME endpointClass and mode.
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 5,
      attempt: 0,
      origin: 'harness'
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 6,
      attempt: 0,
      origin: 'harness'
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 7,
      attempt: 0,
      origin: 'harness'
    });

    const split = collector.snapshot().http['tracker/activity'].browser;
    expect(split.ui?.n).toBe(2);
    expect(split.harness?.n).toBe(3);
    // Neither count leaked into the other, and durations stayed with their
    // own origin (not merged across the split).
    expect(split.ui?.max).toBe(20);
    expect(split.harness?.max).toBe(7);

    // Explicit `origin: 'ui'` behaves identically to omitting the field.
    const collector2 = createCollector();
    collector2.recordHttpSample({
      userId: 'u2',
      mode: 'browser',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 1,
      attempt: 0,
      origin: 'ui'
    });
    expect(collector2.snapshot().http['tracker/activity'].browser.ui?.n).toBe(1);
    expect(collector2.snapshot().http['tracker/activity'].browser.harness).toBeNull();
  });

  it("S24: headless mode has no harness component in this test's samples — every headless HTTP sample defaults to `ui` unless a caller explicitly opts a Node-side driver-bookkeeping call into `harness`", () => {
    const collector = createCollector();
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'headless',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 10,
      attempt: 0
    });
    const split = collector.snapshot().http['tracker/activity'].headless;
    expect(split.ui?.n).toBe(1);
    expect(split.harness).toBeNull();
  });
});

describe('collector — gate-stall accounting (§5.4)', () => {
  it('accumulates hopsEntered / totalMs / percentiles and blockedTicks per gate', () => {
    const collector = createCollector();
    collector.recordGateVisit({ gate: 'claim-proof', durationMs: 1000 });
    collector.recordGateVisit({ gate: 'claim-proof', durationMs: 3000 });
    collector.recordGateBlocked('claim-proof');
    collector.recordGateBlocked('claim-proof');
    collector.recordGateBlocked('activity-index');

    const snapshot = collector.snapshot();
    expect(snapshot.gates['claim-proof']).toStrictEqual({
      hopsEntered: 2,
      totalMs: 4000,
      p50: 1000,
      p90: 3000,
      p99: 3000,
      blockedTicks: 2,
      timedOutVisits: 0
    });
    // A gate that was only ever a blockage target (never visited) still
    // shows up, with hopsEntered 0 — the number that "answers whether the
    // devnet or the tool was the bottleneck" (DESIGN §5.4).
    expect(snapshot.gates['activity-index']).toStrictEqual({
      hopsEntered: 0,
      totalMs: 0,
      p50: 0,
      p90: 0,
      p99: 0,
      blockedTicks: 1,
      timedOutVisits: 0
    });
  });

  it('a null gate (no hop to blame) is silently dropped, not recorded as a gate', () => {
    const collector = createCollector();
    collector.recordGateBlocked(null);
    expect(collector.snapshot().gates).toStrictEqual({});
  });

  it('R6 (loadtest/REVIEW.md): counts how many visits ended at a timeout, without excluding them from the percentiles', () => {
    const collector = createCollector();
    collector.recordGateVisit({ gate: 'claim-proof', durationMs: 1000 });
    collector.recordGateVisit({ gate: 'claim-proof', durationMs: 900_000, timedOut: true });
    const stats = collector.snapshot().gates['claim-proof'];
    // Unlike phases (R2), a gate visit's percentiles ARE computed over
    // every visit, timed-out ones included — `timedOutVisits` is what
    // makes a percentile piled up at the timeout budget interpretable.
    expect(stats?.hopsEntered).toBe(2);
    expect(stats?.timedOutVisits).toBe(1);
    expect(stats?.p99).toBe(900_000);
  });
});

describe('collector — error aggregation (§5.3/§5.5) and secret redaction', () => {
  it('not_ready is excluded from byClass and top (DESIGN §5.3: "Not an error")', () => {
    const collector = createCollector();
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'not_ready',
      message: 'not ready yet'
    });
    const snapshot = collector.snapshot();
    expect(snapshot.errors.byClass.not_ready).toBeUndefined();
    expect(snapshot.errors.top).toHaveLength(0);
    // R7 (loadtest/REVIEW.md): suppressed does NOT mean uncounted anymore.
    expect(snapshot.errors.suppressed.notReady).toBe(1);
  });

  it('R7 (loadtest/REVIEW.md): a run whose only errors were suppressed no longer silently reads "no errors" in the machine-readable counts', () => {
    const collector = createCollector();
    for (let i = 0; i < 10; i += 1) {
      collector.error({
        userId: 'u1',
        mode: 'browser',
        errorClass: 'console_error',
        message: 'icon fetch failed',
        endpointClass: 'icon.invalid'
      });
    }
    collector.error({
      userId: 'u2',
      mode: 'headless',
      errorClass: 'not_ready',
      message: 'not ready yet'
    });
    const snapshot = collector.snapshot();
    expect(snapshot.errors.byClass).toStrictEqual({});
    expect(snapshot.errors.top).toHaveLength(0);
    expect(snapshot.errors.suppressed).toStrictEqual({ notReady: 1, benignExternalAsset: 10 });
  });

  it('S11 retry defect (3): a console_error from a known-benign external asset host is excluded from byClass/top but still written to activity.ndjson with its URL', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    collector.error({
      userId: 'u1',
      mode: 'browser',
      errorClass: 'console_error',
      message: 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED',
      endpointClass: 'https://raw.githubusercontent.com'
    });
    const snapshot = collector.snapshot();
    expect(snapshot.errors.byClass.console_error).toBeUndefined();
    expect(snapshot.errors.top).toHaveLength(0);
    // Still auditable: the raw ndjson line survives, with the real host.
    const errorLine = sink.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.kind === 'error');
    expect(errorLine?.endpointClass).toBe('https://raw.githubusercontent.com');
  });

  it('a genuine (non-benign-host) console_error is still counted normally', () => {
    const collector = createCollector();
    collector.error({
      userId: 'u1',
      mode: 'browser',
      errorClass: 'console_error',
      message: 'app threw'
    });
    const snapshot = collector.snapshot();
    expect(snapshot.errors.byClass.console_error).toBe(1);
    expect(snapshot.errors.top).toHaveLength(1);
  });

  it('aggregates count / firstSeen / lastSeen / one sample per class, top sorted by count desc', () => {
    const clock = FAKE_CLOCK();
    const collector = createCollector({ clock });
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'proxy_5xx',
      message: 'first',
      endpointClass: 'bridge/claim-proof[1]'
    });
    clock.advance(1000);
    collector.error({ userId: 'u2', mode: 'headless', errorClass: 'proxy_5xx', message: 'second' });
    collector.error({
      userId: 'u3',
      mode: 'headless',
      errorClass: 'rpc_error',
      message: 'rpc boom'
    });

    const snapshot = collector.snapshot();
    expect(snapshot.errors.byClass.proxy_5xx).toBe(2);
    expect(snapshot.errors.byClass.rpc_error).toBe(1);
    expect(snapshot.errors.top[0].class).toBe('proxy_5xx');
    expect(snapshot.errors.top[0].count).toBe(2);
    expect(snapshot.errors.top[0].firstSeen).not.toBe(snapshot.errors.top[0].lastSeen);
    expect(snapshot.errors.top[0].sample).toBe('first');
  });

  it('caps top at 10 classes', () => {
    const collector = createCollector();
    const classes = [
      'proxy_4xx',
      'proxy_5xx',
      'rpc_error',
      'tx_revert',
      'lbt_underflow',
      'already_claimed',
      'ui_assertion',
      'browser_crash',
      'console_error',
      'funding',
      'config',
      'internal'
    ] as const;
    classes.forEach((errorClass) =>
      collector.error({ userId: 'u1', mode: 'headless', errorClass, message: 'x' })
    );
    expect(collector.snapshot().errors.top).toHaveLength(10);
  });

  it('redacts a secret in the message even when the caller forgot to (defense in depth)', () => {
    const PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';
    const collector = createCollector();
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'internal',
      message: `boom ${PRIVATE_KEY}`
    });
    const snapshot = collector.snapshot();
    expect(snapshot.errors.top[0].sample).not.toContain(PRIVATE_KEY);
  });
});

describe('collector — hop/lap outcomes', () => {
  it('aggregates hopsByOutcome and hopsByRoute independently', () => {
    const collector = createCollector();
    collector.hopEnd({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L1->L2A',
      outcome: 'hop_completed_auto'
    });
    collector.hopEnd({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h2',
      lapId: 'l1',
      hopRoute: 'L1->L2A',
      outcome: 'revert_bridge'
    });
    collector.hopEnd({
      userId: 'u2',
      mode: 'browser',
      hopId: 'h3',
      lapId: 'l2',
      hopRoute: 'L2A->L2B',
      outcome: 'hop_completed_manual'
    });

    const snapshot = collector.snapshot();
    expect(snapshot.hopsByOutcome.hop_completed_auto).toBe(1);
    expect(snapshot.hopsByOutcome.revert_bridge).toBe(1);
    expect(snapshot.hopsByRoute['L1->L2A'].byOutcome).toStrictEqual({
      hop_completed_auto: 1,
      revert_bridge: 1
    });
    expect(snapshot.hopsByRoute['L2A->L2B'].byOutcome).toStrictEqual({ hop_completed_manual: 1 });
  });

  // S30 (plans/bridge-loadtest-plan.md §7/§8): `byOutcomeByMode` is what
  // lets `metrics/report.ts` compute a per-(route, mode) attempted/
  // completed figure instead of only the mode-blind per-route aggregate
  // above — a specific hop degrading in exactly one mode (S26/S29's
  // headless-only `rpc_error`s on `L2B->L1`) must be visible even when the
  // OTHER mode's hops on that SAME route keep the route aggregate healthy.
  it('aggregates hopsByRoute[route].byOutcomeByMode PER MODE, independently of byOutcome', () => {
    const collector = createCollector();
    collector.hopEnd({
      userId: 'u1',
      mode: 'browser',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    collector.hopEnd({
      userId: 'u2',
      mode: 'browser',
      hopId: 'h2',
      lapId: 'l2',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    collector.hopEnd({
      userId: 'u3',
      mode: 'headless',
      hopId: 'h3',
      lapId: 'l3',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    collector.hopEnd({
      userId: 'u4',
      mode: 'headless',
      hopId: 'h4',
      lapId: 'l4',
      hopRoute: 'L2B->L1',
      outcome: 'rpc_error'
    });

    const snapshot = collector.snapshot();
    // The mode-blind aggregate stays healthy (3 of 4 completed)...
    expect(snapshot.hopsByRoute['L2B->L1'].byOutcome).toStrictEqual({
      hop_completed_manual: 3,
      rpc_error: 1
    });
    // ...but the per-mode split reveals headless is the ONLY mode with the
    // failure, at a much worse local rate (0 of 1) than the aggregate
    // suggests.
    expect(snapshot.hopsByRoute['L2B->L1'].byOutcomeByMode).toStrictEqual({
      browser: { hop_completed_manual: 2 },
      headless: { hop_completed_manual: 1, rpc_error: 1 }
    });
  });

  it('aggregates lap outcomes', () => {
    const collector = createCollector();
    collector.lapEnd({ userId: 'u1', mode: 'headless', lapId: 'l1', outcome: 'LAP_DONE' });
    collector.lapEnd({ userId: 'u2', mode: 'headless', lapId: 'l2', outcome: 'LAP_FAILED' });
    expect(collector.snapshot().lapsByOutcome).toStrictEqual({
      LAP_DONE: 1,
      LAP_FAILED: 1,
      LAP_ABORTED: 0
    });
  });

  // S27 (plans/bridge-loadtest-plan.md §7): `lapsByOutcomeByMode` is what
  // lets `metrics/report.ts` compute a per-mode attempted/completed figure
  // instead of only the cross-mode aggregate above — a mode collapsing to
  // near-zero completion must be visible even when the OTHER mode's laps
  // keep the aggregate `LAP_DONE` count above zero.
  it('aggregates lap outcomes PER MODE, independently of the cross-mode aggregate', () => {
    const collector = createCollector();
    collector.lapEnd({ userId: 'u1', mode: 'browser', lapId: 'l1', outcome: 'LAP_DONE' });
    collector.lapEnd({ userId: 'u2', mode: 'browser', lapId: 'l2', outcome: 'LAP_DONE' });
    collector.lapEnd({ userId: 'u3', mode: 'headless', lapId: 'l3', outcome: 'LAP_DONE' });
    collector.lapEnd({ userId: 'u4', mode: 'headless', lapId: 'l4', outcome: 'LAP_FAILED' });
    collector.lapEnd({ userId: 'u5', mode: 'headless', lapId: 'l5', outcome: 'LAP_ABORTED' });

    const snapshot = collector.snapshot();
    expect(snapshot.lapsByOutcome).toStrictEqual({ LAP_DONE: 3, LAP_FAILED: 1, LAP_ABORTED: 1 });
    expect(snapshot.lapsByOutcomeByMode).toStrictEqual({
      browser: { LAP_DONE: 2, LAP_FAILED: 0, LAP_ABORTED: 0 },
      headless: { LAP_DONE: 1, LAP_FAILED: 1, LAP_ABORTED: 1 }
    });
  });
});

describe('collector — policy counters (§3.4) and scheduler counters / bridgesSubmitted (§5.5)', () => {
  it('tallies the three policy counters results.json surfaces', () => {
    const collector = createCollector();
    collector.recordHopCounter('autoclaim_overdue');
    collector.recordHopCounter('autoclaim_overdue');
    collector.recordHopCounter('unexpected_autoclaim');
    collector.recordHopCounter('claim_race_lost');
    expect(collector.snapshot().policy).toStrictEqual({
      autoclaimOverdue: 2,
      unexpectedAutoclaim: 1,
      claimRaceLost: 1
    });
  });

  it('derives hopBridgesSubmitted (informational, per-HOP) from recorded bridge_submit phase samples, split ramp vs steady by rampUpSeconds', () => {
    const clock = FAKE_CLOCK();
    const collector = createCollector({ clock });
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' },
      rampUpSeconds: 10
    });

    // During ramp (t=0 < 10s).
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 1
    });
    clock.advance(20_000); // now past the 10s ramp boundary
    // Steady state.
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 1
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 1
    });

    const snapshot = collector.snapshot();
    expect(snapshot.scheduler.hopBridgesSubmittedRamp).toBe(1);
    expect(snapshot.scheduler.hopBridgesSubmittedSteady).toBe(2);
    expect(snapshot.scheduler.hopBridgesSubmitted).toBe(3);
    // hop-level counts are NOT the §5.5 identity term — no `tick()` was
    // called above, so the lap-start counters stay at 0.
    expect(snapshot.scheduler.lapStartsSubmitted).toBe(0);
  });

  it('derives lapStartsSubmitted (the §5.5 identity term, one per lap start) from tick() calls, split ramp vs steady by rampUpSeconds (S11 retry defect 1)', () => {
    const clock = FAKE_CLOCK();
    const collector = createCollector({ clock });
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' },
      rampUpSeconds: 10
    });

    // During ramp (t=0 < 10s).
    collector.tick('u1', 'headless');
    clock.advance(20_000); // now past the 10s ramp boundary
    // Steady state — a 3-hop lap submits 3 `bridge_submit` phase samples
    // per lap start, but only ONE `tick()` per lap start.
    collector.tick('u1', 'headless');
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 1
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L2A->L2B',
      assetKind: 'eth',
      durationMs: 1
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L2B->L1',
      assetKind: 'eth',
      durationMs: 1
    });

    const snapshot = collector.snapshot();
    expect(snapshot.scheduler.lapStartsSubmittedRamp).toBe(1);
    expect(snapshot.scheduler.lapStartsSubmittedSteady).toBe(1);
    expect(snapshot.scheduler.lapStartsSubmitted).toBe(2);
    // The one steady-state lap start produced 3 hop-level bridge sends —
    // a DIFFERENT unit, deliberately not equal to lapStartsSubmitted.
    expect(snapshot.scheduler.hopBridgesSubmittedSteady).toBe(3);
  });

  it('setSchedulerCounters feeds the other three §5.5 invariant-1 terms', () => {
    const collector = createCollector();
    collector.setSchedulerCounters({
      ticksOffered: 10,
      skippedBackpressure: 2,
      ticksLostToRamp: 1
    });
    const scheduler = collector.snapshot().scheduler;
    expect(scheduler.ticksOffered).toBe(10);
    expect(scheduler.skippedBackpressure).toBe(2);
    expect(scheduler.ticksLostToRamp).toBe(1);
  });
});

describe('collector — activity.ndjson (§6.2)', () => {
  it('every written line round-trips through JSON.parse and carries {ts, kind, userId, mode}', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });

    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' }
    });
    collector.userReady('u1', 'headless');
    collector.tick('u1', 'headless');
    collector.tickSkipped('u1', 'headless', 'claim-proof');
    collector.hopState({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      lapId: 'l1',
      from: 'PLANNED',
      to: 'BRIDGE_BUILD',
      transition: 'T2'
    });
    collector.txSent({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      step: 'bridge',
      txHash: '0xabc'
    });
    collector.txReceipt({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      step: 'bridge',
      status: 'success'
    });
    collector.activityRow({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      hash: '0xabc',
      status: 'PENDING'
    });
    collector.claimAttempt({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      claimable: false,
      reason: 'SOURCE_NOT_ON_L1_INFO_TREE'
    });
    collector.error({ userId: 'u1', mode: 'headless', errorClass: 'proxy_5xx', message: 'boom' });
    collector.hopEnd({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L1->L2A',
      outcome: 'hop_completed_manual'
    });
    collector.lapEnd({ userId: 'u1', mode: 'headless', lapId: 'l1', outcome: 'LAP_DONE' });
    collector.resourceSample({ toolRssMb: 100, toolCpuPct: 5, browserProcesses: [] });
    collector.runEnd({ aborted: false, abortCause: null });

    expect(sink.lines.length).toBeGreaterThan(0);
    const kinds = sink.lines.map((line) => {
      const parsed = JSON.parse(line) as {
        ts: unknown;
        kind: unknown;
        userId: unknown;
        mode: unknown;
      };
      expect(typeof parsed.ts).toBe('string');
      expect('kind' in parsed).toBe(true);
      expect('userId' in parsed).toBe(true);
      expect('mode' in parsed).toBe(true);
      return parsed.kind;
    });
    expect(kinds).toContain('run_start');
    expect(kinds).toContain('hop_state');
    expect(kinds).toContain('run_end');
  });

  it('the not_ready guard also suppresses the ndjson error line', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'not_ready',
      message: 'not ready'
    });
    expect(sink.lines).toHaveLength(0);
  });

  it('redacts a secret before it ever reaches an ndjson line', () => {
    const PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'internal',
      message: `boom ${PRIVATE_KEY}`
    });
    expect(sink.lines.join('\n')).not.toContain(PRIVATE_KEY);
  });
});

// S16/A5 (VALIDATION-1.md): `eventLoopDelayP99Ms` is optional so every
// existing caller/test above (which never passes it) keeps compiling and
// working — `resources.samples[]` must still carry it through verbatim
// when a caller (`runner.ts`) does supply it, since `metrics/report.ts`
// reads it to decide whether this run's own latency percentiles are
// trustworthy.
describe('collector — resourceSample carries eventLoopDelayP99Ms through (S16/A5)', () => {
  it('is undefined in the snapshot when the caller omits it', () => {
    const collector = createCollector();
    collector.resourceSample({ toolRssMb: 100, toolCpuPct: 5, browserProcesses: [] });
    const [sample] = collector.snapshot().resources.samples;
    expect(sample.eventLoopDelayP99Ms).toBeUndefined();
  });

  it('round-trips into the snapshot and the ndjson line when the caller supplies it', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    collector.resourceSample({
      toolRssMb: 100,
      toolCpuPct: 5,
      browserProcesses: [],
      eventLoopDelayP99Ms: 42.5
    });

    const [sample] = collector.snapshot().resources.samples;
    expect(sample.eventLoopDelayP99Ms).toBe(42.5);

    const resourceLine = sink.lines
      .map((line) => JSON.parse(line) as { kind: string })
      .find((line) => line.kind === 'resource_sample') as
      | { eventLoopDelayP99Ms?: number }
      | undefined;
    expect(resourceLine?.eventLoopDelayP99Ms).toBe(42.5);
  });
});

describe('collector — run lifecycle', () => {
  it('records startedAt/endedAt/durationMs/aborted/abortCause', () => {
    const clock = FAKE_CLOCK();
    const collector = createCollector({ clock });
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 4, totalMemMb: 8192, platform: 'linux' }
    });
    clock.advance(5000);
    collector.runEnd({ aborted: true, abortCause: 'sigint' });
    const run = collector.snapshot().run;
    expect(run.durationMs).toBe(5000);
    expect(run.aborted).toBe(true);
    expect(run.abortCause).toBe('sigint');
    expect(run.toolVersion).toBe('v1');
    expect(run.host).toStrictEqual({ cores: 4, totalMemMb: 8192, platform: 'linux' });
  });

  it('S11 retry defect (2): lapsInFlightAtStop is recorded independently of aborted, defaults to 0', () => {
    const collectorWithNoArg = createCollector();
    collectorWithNoArg.runEnd({ aborted: false, abortCause: null });
    expect(collectorWithNoArg.snapshot().run.lapsInFlightAtStop).toBe(0);

    const collectorNormalDrain = createCollector();
    collectorNormalDrain.runEnd({ aborted: false, abortCause: null, lapsInFlightAtStop: 3 });
    const run = collectorNormalDrain.snapshot().run;
    // A normal (`duration_elapsed`) drain with laps still in flight is NOT
    // aborted — only `lapsInFlightAtStop` notes it.
    expect(run.aborted).toBe(false);
    expect(run.lapsInFlightAtStop).toBe(3);
  });
});

describe('collector — hopMeasurement (S45 C3)', () => {
  const record = {
    hopId: 'h1',
    lapId: 'l1',
    userId: 'u1',
    mode: 'headless' as const,
    hopRoute: 'A->B',
    fromNetworkId: 82,
    toNetworkId: 85,
    assetKind: 'eth' as const,
    assetIndex: 0,
    outcome: 'hop_completed_manual' as const,
    depositCount: 4,
    bridge: { txHash: '0xb', blockNumber: '10', minedObservedAt: 1, gas: null },
    stages: null,
    readyObservedAt: 5,
    claim: {
      txHash: '0xc',
      blockNumber: '12',
      sentAt: 6,
      minedObservedAt: 8,
      gas: { blockNumber: '12', gasUsed: '1', effectiveGasPrice: '2' },
      claimKind: 'eth' as const
    }
  };

  it('writes one hop_measurement ndjson line per hop and keeps the record for the snapshot', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    collector.hopMeasurement(record);

    expect(sink.lines).toHaveLength(1);
    const line = JSON.parse(sink.lines[0]);
    expect(line).toMatchObject({
      kind: 'hop_measurement',
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      hopRoute: 'A->B',
      depositCount: 4,
      claim: { claimKind: 'eth', gas: { gasUsed: '1' } }
    });
    expect(collector.snapshot().hopMeasurements).toStrictEqual([record]);
  });
});

// ---------------------------------------------------------------------------
// S53 (heavy-load design §1.3/§1.4): harness records, HTTP windows, live counters.
// ---------------------------------------------------------------------------

describe('collector — pump records (S53)', () => {
  const started = {
    kind: 'state' as const,
    state: 'started' as const,
    sender: '0x00000000000000000000000000000000000000b1',
    intervalSeconds: 600,
    maxTotalSpendWei: '70000000000000000',
    maxGasPriceWei: '5000000000',
    destinationNetworkId: 82,
    amountWei: '0'
  };
  const deposit = (n: number, cumulative: string) => ({
    kind: 'deposit' as const,
    txHash: `0x${n.toString(16).padStart(64, '0')}`,
    blockNumber: String(100 + n),
    depositCount: n,
    status: 'success' as const,
    gasUsed: '437125',
    effectiveGasPrice: '1000000',
    costWei: '437125000000',
    cumulativeSpendWei: cumulative,
    sentAt: 1000 * n,
    minedObservedAt: 1000 * n + 12
  });

  it('writes pump_state / pump_deposit / pump_skipped under userId harness:pump with a null mode', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    collector.pumpEvent(started);
    collector.pumpEvent(deposit(1, '437125000000'));
    collector.pumpEvent({
      kind: 'skipped',
      reason: 'gas_price',
      gasPriceWei: '6000000000',
      cumulativeSpendWei: '437125000000'
    });
    collector.pumpEvent({
      ...started,
      state: 'stopped',
      pendingAtStop: false,
      totalSpendWei: '437125000000'
    });

    const lines = sink.lines.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toStrictEqual([
      'pump_state',
      'pump_deposit',
      'pump_skipped',
      'pump_state'
    ]);
    for (const line of lines) {
      expect(line.userId).toBe('harness:pump');
      expect(line.mode).toBeNull();
    }
    expect(lines[0]).toMatchObject({ state: 'started', sender: started.sender, amountWei: '0' });
    expect(lines[1]).toMatchObject({
      txHash: deposit(1, '').txHash,
      depositCount: 1,
      cumulativeSpendWei: '437125000000'
    });
    expect(lines[2]).toMatchObject({ reason: 'gas_price', gasPriceWei: '6000000000' });
    expect(lines[3]).toMatchObject({ state: 'stopped', pendingAtStop: false });
    // The `kind` discriminator of the input is not leaked into the payload twice.
    expect(lines[1].kind).toBe('pump_deposit');
  });

  it('snapshots a pump block, and only once a pump started', () => {
    const collector = createCollector();
    expect('pump' in collector.snapshot()).toBe(false);

    collector.pumpEvent(started);
    collector.pumpEvent(deposit(1, '100'));
    collector.pumpEvent(deposit(2, '200'));
    collector.pumpEvent({ kind: 'skipped', reason: 'previous_pending', cumulativeSpendWei: '200' });
    collector.pumpEvent({ kind: 'skipped', reason: 'previous_pending', cumulativeSpendWei: '200' });
    collector.pumpEvent({ kind: 'skipped', reason: 'cap_reached', cumulativeSpendWei: '250' });

    const pump = collector.snapshot().pump;
    expect(pump).toMatchObject({
      enabled: true,
      sender: started.sender,
      destinationNetworkId: 82,
      intervalSeconds: 600,
      maxTotalSpendWei: '70000000000000000',
      maxGasPriceWei: '5000000000',
      skipped: { gas_price: 0, cap_reached: 1, previous_pending: 2, send_error: 0 },
      totalSpendWei: '250',
      pendingAtStop: false
    });
    expect(pump?.deposits.map((d) => d.depositCount)).toStrictEqual([1, 2]);
    // The per-line running total is an event field, not part of the results record.
    expect(pump?.deposits[0]).not.toHaveProperty('cumulativeSpendWei');
  });

  it('a stopped record carries pendingAtStop and the final counted total into the snapshot', () => {
    const collector = createCollector();
    collector.pumpEvent(started);
    collector.pumpEvent({
      ...started,
      state: 'stopped',
      pendingAtStop: true,
      totalSpendWei: '999'
    });
    expect(collector.snapshot().pump).toMatchObject({ pendingAtStop: true, totalSpendWei: '999' });
  });

  it('keeps pump records out of every hop, lap, tick, phase and error aggregate', () => {
    const collector = createCollector();
    collector.pumpEvent(started);
    collector.pumpEvent(deposit(1, '100'));
    collector.pumpEvent({ kind: 'skipped', reason: 'send_error', cumulativeSpendWei: '100' });
    const snap = collector.snapshot();
    expect(snap.hopsByOutcome).toStrictEqual({});
    expect(snap.lapsByOutcome).toStrictEqual({ LAP_DONE: 0, LAP_FAILED: 0, LAP_ABORTED: 0 });
    expect(snap.scheduler.lapStartsSubmitted).toBe(0);
    expect(snap.phases).toStrictEqual({});
    expect(snap.errors.byClass).toStrictEqual({});
  });
});

describe('collector — wallet balance and L1 info tree records (S53)', () => {
  it('wallet_balance: an ndjson line (null user and mode) per call, kept in order for the snapshot', () => {
    const clock = FAKE_CLOCK();
    const sink = createMemoryActivitySink();
    const collector = createCollector({ clock, activitySink: sink });
    expect('walletBalances' in collector.snapshot()).toBe(false);

    const sample = {
      chainKey: 'BALI_82',
      n: 3,
      minWei: '1',
      medianWei: '2',
      maxWei: '3',
      lowest: [{ userId: 'u1', wei: '1' }]
    };
    collector.walletBalance(sample);
    clock.advance(60_000);
    collector.walletBalance({ ...sample, chainKey: 'BALI_85' });

    const lines = sink.lines.map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'wallet_balance', userId: null, mode: null, ...sample });
    const snap = collector.snapshot().walletBalances;
    expect(snap?.map((s) => s.chainKey)).toStrictEqual(['BALI_82', 'BALI_85']);
    expect(snap?.[1].ts).toBe(new Date(60_000).toISOString());
  });

  it('l1_info_leaf / l1_info_poll_error: ndjson kinds, a redacted error message, and the l1InfoTree snapshot', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    expect('l1InfoTree' in collector.snapshot()).toBe(false);

    collector.l1InfoTreeStart({
      gerManagerAddress: '0x00000000000000000000000000000000000000a1',
      baselineLeafCount: 500
    });
    collector.l1InfoLeaf({
      blockNumber: '1010',
      leafCount: 501,
      txHash: '0xaa',
      minTimestamp: 7,
      fromPump: true
    });
    collector.l1InfoPollError('boom URL: https://rpc.example.invalid/AbCdEf0123456789TokenXyz');

    const lines = sink.lines.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toStrictEqual(['l1_info_leaf', 'l1_info_poll_error']);
    expect(lines[0]).toMatchObject({
      blockNumber: '1010',
      leafCount: 501,
      txHash: '0xaa',
      minTimestamp: 7,
      fromPump: true
    });
    expect(JSON.stringify(lines[1])).not.toContain('AbCdEf0123456789TokenXyz');

    const tree = collector.snapshot().l1InfoTree;
    expect(tree).toMatchObject({
      gerManagerAddress: '0x00000000000000000000000000000000000000a1',
      baselineLeafCount: 500,
      pollErrors: 1
    });
    expect(tree?.leaves).toHaveLength(1);
  });
});

describe('collector — flushHttpWindow (M4)', () => {
  const sample = (
    collector: ReturnType<typeof createCollector>,
    endpointClass: string,
    over: Partial<{
      status: number;
      durationMs: number;
      origin: 'ui' | 'harness';
      mode: 'browser' | 'headless';
    }> = {}
  ) =>
    collector.recordHttpSample({
      userId: 'u0',
      mode: over.mode ?? 'headless',
      endpointClass,
      method: 'GET',
      status: over.status ?? 200,
      durationMs: over.durationMs ?? 10,
      attempt: 0,
      origin: over.origin ?? 'ui'
    });
  const windows = (sink: ReturnType<typeof createMemoryActivitySink>) =>
    sink.lines.map((l) => JSON.parse(l)).filter((l) => l.kind === 'http_window');

  it('groups tracker/activity, tracker/other, bridge/<route> without the network suffix and rpc/<chainKey> without the method', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    sample(collector, 'tracker/activity');
    sample(collector, 'tracker/tx');
    sample(collector, 'tracker/health');
    sample(collector, 'bridge/claim-proof[82]');
    sample(collector, 'bridge/claim-proof[85]');
    sample(collector, 'rpc/BALI_82/eth_call');
    sample(collector, 'rpc/BALI_82/eth_getBalance');
    sample(collector, 'rpc/BALI_85/eth_call');
    collector.flushHttpWindow(60_000);

    const [window] = windows(sink);
    expect(window).toMatchObject({
      kind: 'http_window',
      userId: null,
      mode: null,
      windowMs: 60_000
    });
    expect(Object.keys(window.classes)).toStrictEqual([
      'bridge/claim-proof',
      'rpc/BALI_82',
      'rpc/BALI_85',
      'tracker/activity',
      'tracker/other'
    ]);
    expect(window.classes['bridge/claim-proof'].ui.n).toBe(2);
    expect(window.classes['rpc/BALI_82'].ui.n).toBe(2);
    expect(window.classes['tracker/other'].ui.n).toBe(2);
  });

  it('reports n, status mix and a nearest-rank p90 per origin, with ui and harness kept apart (and browser merged with headless)', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    for (let i = 1; i <= 10; i += 1) sample(collector, 'tracker/activity', { durationMs: i * 10 });
    sample(collector, 'tracker/activity', { status: 503, durationMs: 5 });
    sample(collector, 'tracker/activity', { origin: 'harness', durationMs: 900 });
    sample(collector, 'tracker/activity', { mode: 'browser', durationMs: 1 });
    collector.flushHttpWindow(10_000);

    const activity = windows(sink)[0].classes['tracker/activity'];
    expect(activity.ui).toStrictEqual({ n: 12, byStatus: { '200': 11, '503': 1 }, p90: 90 });
    expect(activity.harness).toStrictEqual({ n: 1, byStatus: { '200': 1 }, p90: 900 });
  });

  it('only covers samples since the previous flush; an idle window is an empty classes object', () => {
    const sink = createMemoryActivitySink();
    const collector = createCollector({ activitySink: sink });
    sample(collector, 'tracker/activity');
    collector.flushHttpWindow(60_000);
    sample(collector, 'tracker/activity', { status: 500 });
    sample(collector, 'tracker/activity', { status: 500 });
    collector.flushHttpWindow(60_000);
    collector.flushHttpWindow(60_000);

    const [first, second, third] = windows(sink);
    expect(first.classes['tracker/activity'].ui).toMatchObject({ n: 1, byStatus: { '200': 1 } });
    expect(second.classes['tracker/activity'].ui).toMatchObject({ n: 2, byStatus: { '500': 2 } });
    expect(third.classes).toStrictEqual({});
  });

  it('does not change the cumulative http statistics in the snapshot', () => {
    const collector = createCollector();
    for (let i = 0; i < 5; i += 1)
      sample(collector, 'tracker/activity', { durationMs: 10 * (i + 1) });
    const before = collector.snapshot().http;
    collector.flushHttpWindow(60_000);
    expect(collector.snapshot().http).toStrictEqual(before);
  });
});

describe('collector — liveCounters (F6)', () => {
  it('tracks lap starts, backpressure skips and non-suppressed errors without a snapshot', () => {
    const collector = createCollector();
    expect(collector.liveCounters()).toStrictEqual({
      lapStartsSubmitted: 0,
      skippedBackpressure: 0,
      errorsTotal: 0,
      errorsByClass: {}
    });
    collector.tick('u0', 'headless');
    collector.tick('u1', 'headless');
    collector.setSchedulerCounters({ ticksOffered: 5, skippedBackpressure: 3, ticksLostToRamp: 0 });
    collector.error({ userId: 'u0', mode: 'headless', errorClass: 'proxy_5xx', message: 'a' });
    collector.error({ userId: 'u0', mode: 'headless', errorClass: 'proxy_5xx', message: 'b' });
    collector.error({
      userId: 'u0',
      mode: 'headless',
      errorClass: 'tracker_not_ready',
      message: 'c'
    });
    // Suppressed (`not_ready`) errors are not counted, exactly as in `errors.byClass`.
    collector.error({ userId: 'u0', mode: 'headless', errorClass: 'not_ready', message: 'd' });

    expect(collector.liveCounters()).toStrictEqual({
      lapStartsSubmitted: 2,
      skippedBackpressure: 3,
      errorsTotal: 3,
      errorsByClass: { proxy_5xx: 2, tracker_not_ready: 1 }
    });
  });

  it('agrees with the full snapshot', () => {
    const collector = createCollector();
    collector.tick('u0', 'headless');
    collector.error({ userId: 'u0', mode: 'headless', errorClass: 'internal', message: 'x' });
    collector.setSchedulerCounters({ ticksOffered: 2, skippedBackpressure: 1, ticksLostToRamp: 0 });
    const live = collector.liveCounters();
    const snap = collector.snapshot();
    expect(live.lapStartsSubmitted).toBe(snap.scheduler.lapStartsSubmitted);
    expect(live.skippedBackpressure).toBe(snap.scheduler.skippedBackpressure);
    expect(live.errorsByClass).toStrictEqual(snap.errors.byClass);
    expect(live.errorsTotal).toBe(
      Object.values(snap.errors.byClass).reduce((a, b) => a + (b ?? 0), 0)
    );
  });
});

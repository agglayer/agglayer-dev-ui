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

// Unit tests for the report writer — DESIGN §6.1 (`results.json`) and §6.3
// (`summary.md`'s fixed section order). Builds a valid `LoadtestConfig` the
// same way `loadtest/config/schema.test.ts` does (via `deriveDevnetConfig`
// against the fixtures directory, never the live devnet summary.json), and
// drives a real `createCollector` with synthetic events rather than
// hand-building a `CollectorSnapshot` — closer to how S08/S10/S11 will
// actually call this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LoadtestConfig } from '../config/schema';

import { deriveDevnetConfig } from '../config/deriveDevnet';
import { parseLoadtestConfig } from '../config/schema';
import { createCollector } from './collector';
import {
  buildResultsJson,
  checkThroughputIdentity,
  redactConfigForReport,
  renderSummaryMd,
  requestedFromConfig,
  writeReportFiles
} from './report';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../config/__fixtures__');

const PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';

const buildDevnetConfig = (): LoadtestConfig => {
  const { config } = deriveDevnetConfig({
    repoRoot: '/unused-repo-root-for-tests',
    summaryPath: path.join(FIXTURES_DIR, 'summary.json'),
    ciConfigPath: path.join(FIXTURES_DIR, 'config.ci.devnet.json'),
    env: {}
  });
  return parseLoadtestConfig(config);
};

const SUMMARY_HEADINGS = [
  '## Configuration',
  '## Throughput',
  '## Hop outcomes',
  '## Phase latencies',
  '## Endpoint latencies',
  '## Gate stalls',
  '## Autoclaim policy',
  '## Errors',
  '## Resources',
  '## Environment'
];

describe('redactConfigForReport — DESIGN §6.1 "every secretRef replaced by {ref: ...}"', () => {
  it('replaces an {env} secretRef', () => {
    expect(redactConfigForReport({ env: 'FUNDER_KEY' })).toStrictEqual({ ref: 'env:FUNDER_KEY' });
  });

  it('replaces a {file} secretRef', () => {
    expect(redactConfigForReport({ file: '/secrets/key' })).toStrictEqual({
      ref: 'file:/secrets/key'
    });
  });

  it('walks arrays and nested objects, leaving ordinary fields untouched', () => {
    const input = { a: [{ env: 'X' }, { b: 1 }], c: { file: '/y' }, d: 'plain' };
    expect(redactConfigForReport(input)).toStrictEqual({
      a: [{ ref: 'env:X' }, { b: 1 }],
      c: { ref: 'file:/y' },
      d: 'plain'
    });
  });

  it('does not mistake an ordinary two-key object for a secretRef', () => {
    expect(redactConfigForReport({ env: 'X', extra: 1 })).toStrictEqual({ env: 'X', extra: 1 });
  });
});

describe('requestedFromConfig / achievedFromSnapshot / checkThroughputIdentity (DESIGN §5.5 invariant 1)', () => {
  it('derives requested load from config', () => {
    const config = buildDevnetConfig();
    const requested = requestedFromConfig(config);
    expect(requested).toStrictEqual({
      users: config.users.total,
      browser: config.users.browser,
      ratePerUserPerMin: config.load.bridgesPerMinutePerUser,
      minutes: config.load.durationMinutes
    });
  });

  it('the identity holds when the four terms are consistent', () => {
    expect(
      checkThroughputIdentity({
        ticksOffered: 10,
        ticksExpected: 10,
        lapStartsSubmitted: 7,
        skippedBackpressure: 2,
        ticksLostToRamp: 1,
        hopBridgesSubmitted: 21,
        steadyStateRatePerUserPerMin: 0,
        steadyStateRatePerUserPerModeMin: { browser: null, headless: null }
      })
    ).toBe(true);
  });

  it('the identity fails loudly when they are not — MISMATCH must be detectable', () => {
    expect(
      checkThroughputIdentity({
        ticksOffered: 10,
        ticksExpected: 10,
        lapStartsSubmitted: 7,
        skippedBackpressure: 2,
        ticksLostToRamp: 99,
        hopBridgesSubmitted: 21,
        steadyStateRatePerUserPerMin: 0,
        steadyStateRatePerUserPerModeMin: { browser: null, headless: null }
      })
    ).toBe(false);
  });

  it('the identity is unaffected by hopBridgesSubmitted — a different unit, not part of the check (S11 retry defect 1)', () => {
    // A 3-hop ring: 7 lap starts but 21 hop-level bridge sends. Attempt #1
    // compared ticksOffered against the hop-level count directly, which
    // could never satisfy the identity for any ring with more than one hop.
    expect(
      checkThroughputIdentity({
        ticksOffered: 7,
        ticksExpected: 7,
        lapStartsSubmitted: 7,
        skippedBackpressure: 0,
        ticksLostToRamp: 0,
        hopBridgesSubmitted: 21,
        steadyStateRatePerUserPerMin: 0,
        steadyStateRatePerUserPerModeMin: { browser: null, headless: null }
      })
    ).toBe(true);
  });
});

describe('buildResultsJson — renders from a synthetic collector', () => {
  it('assembles every top-level §6.1 section', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 8, totalMemMb: 16384, platform: 'linux' }
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: config.ring[0],
      assetKind: 'eth',
      durationMs: 100
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'headless',
      endpointClass: 'tracker/activity',
      method: 'GET',
      status: 200,
      durationMs: 20,
      attempt: 0
    });
    collector.recordGateVisit({ gate: 'claim-proof', durationMs: 500 });
    collector.recordHopCounter('autoclaim_overdue');
    collector.hopEnd({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L1->L2A',
      outcome: 'hop_completed_auto'
    });
    collector.lapEnd({ userId: 'u1', mode: 'headless', lapId: 'l1', outcome: 'LAP_DONE' });
    collector.setSchedulerCounters({ ticksOffered: 1, skippedBackpressure: 0, ticksLostToRamp: 0 });
    collector.runEnd({ aborted: false, abortCause: null });

    const results = buildResultsJson({ snapshot: collector.snapshot(), config });

    expect(results.schemaVersion).toBe(1);
    expect(results.requested.users).toBe(config.users.total);
    // One `bridge_submit` phase sample was recorded directly (hop-level),
    // no `tick()` call was made — so `hopBridgesSubmitted` reflects it and
    // `lapStartsSubmitted` (the §5.5 identity term) stays 0.
    expect(results.achieved.hopBridgesSubmitted).toBe(1);
    expect(results.achieved.lapStartsSubmitted).toBe(0);
    expect(results.hops.byOutcome.hop_completed_auto).toBe(1);
    expect(results.laps.byOutcome.LAP_DONE).toBe(1);
    expect(results.gates['claim-proof']?.hopsEntered).toBe(1);
    expect(results.policy.autoclaimOverdue).toBe(1);
    expect(results.run.toolVersion).toBe('v1');

    // Every line of results.json must round-trip through JSON.
    expect(() => JSON.parse(JSON.stringify(results))).not.toThrow();
  });

  it('omits a zero-sample histogram entirely (DESIGN §5.5 invariant 5)', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.phases).toStrictEqual({});
  });
});

describe('renderSummaryMd — every DESIGN §6.3 section is present', () => {
  it('contains every fixed heading in order, and the pass/abort first line', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 4, totalMemMb: 8192, platform: 'linux' }
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 100
    });
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'proxy_5xx',
      message: 'upstream down'
    });
    collector.hopEnd({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L1->L2A',
      outcome: 'revert_bridge'
    });
    collector.resourceSample({
      toolRssMb: 200,
      toolCpuPct: 10,
      browserProcesses: [{ pid: 1, rssMb: 50 }]
    });
    collector.runEnd({ aborted: false, abortCause: null });

    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);

    expect(summaryMd.startsWith('# Bridge load test —')).toBe(true);
    expect(summaryMd).toContain('PASS');

    let lastIndex = -1;
    for (const heading of SUMMARY_HEADINGS) {
      const index = summaryMd.indexOf(heading);
      expect(index, `missing heading: ${heading}`).toBeGreaterThan(-1);
      expect(index, `out of order: ${heading}`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  // S16/A5 (VALIDATION-1.md): a report that can invalidate its own numbers
  // is the only honest version of this measurement — 100 users sharing one
  // Node event loop measured headless `tracker/activity` p50 5316ms against
  // p50 1ms for the same endpoint in-browser in the same run, and nothing
  // in the report said so.
  it('self-disqualifies the Phase/Endpoint latency sections when event-loop lag is high', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 4, totalMemMb: 8192, platform: 'linux' }
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 100
    });
    collector.recordHttpSample({
      userId: 'u1',
      mode: 'headless',
      endpointClass: 'tracker/activity',
      method: 'GET',
      origin: 'ui',
      status: 200,
      durationMs: 5316,
      attempt: 0
    });
    // Well past EVENT_LOOP_LAG_DISQUALIFY_THRESHOLD_MS (100ms) — this is the
    // shape a genuinely saturated loop leaves behind.
    collector.resourceSample({
      toolRssMb: 200,
      toolCpuPct: 101,
      browserProcesses: [],
      eventLoopDelayP99Ms: 500
    });
    collector.runEnd({ aborted: false, abortCause: null });

    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);

    expect(summaryMd).toContain('Not usable as server/proxy latency');
    expect(summaryMd).toContain('500.0');
    // The banner must land inside BOTH sections it warns about, not just
    // float somewhere in the document.
    const phaseSection = summaryMd.slice(
      summaryMd.indexOf('## Phase latencies'),
      summaryMd.indexOf('## Endpoint latencies')
    );
    const endpointSection = summaryMd.slice(
      summaryMd.indexOf('## Endpoint latencies'),
      summaryMd.indexOf('## Gate stalls')
    );
    expect(phaseSection).toContain('Not usable as server/proxy latency');
    expect(endpointSection).toContain('Not usable as server/proxy latency');
    // The Resources section also surfaces the raw measurement.
    expect(summaryMd).toContain('eventLoopDelayP99Ms');
  });

  it('does not disqualify latency sections when event-loop lag stays low (or was never sampled)', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 4, totalMemMb: 8192, platform: 'linux' }
    });
    collector.recordPhase({
      phase: 'bridge_submit',
      mode: 'headless',
      hopRoute: 'L1->L2A',
      assetKind: 'eth',
      durationMs: 100
    });
    collector.resourceSample({
      toolRssMb: 200,
      toolCpuPct: 10,
      browserProcesses: [],
      eventLoopDelayP99Ms: 3
    });
    collector.runEnd({ aborted: false, abortCause: null });

    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);

    expect(summaryMd).not.toContain('Not usable as server/proxy latency');
  });

  it('an aborted run states so on the first line', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' }
    });
    collector.runEnd({ aborted: true, abortCause: 'sigint' });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);
    const firstLine = summaryMd.split('\n')[0];
    expect(firstLine).toContain('Bridge load test');
    expect(firstLine).toContain('ABORTED');
    expect(firstLine).toContain('sigint');
  });

  // S12: the sibling of the `sigint` case above — `runLoadTest` (runner.ts)
  // treats BOTH `sigint` and `fatal` as abnormal termination (`abnormalAbort
  // = drainCause === 'sigint' || drainCause === 'fatal'`), never just
  // `sigint`. `fatal` had no test anywhere before this — locks the other
  // half of that `||`.
  it('a fatal-error abort also states so on the first line, not just sigint', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' }
    });
    collector.runEnd({ aborted: true, abortCause: 'fatal' });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.run.aborted).toBe(true);
    expect(results.run.abortCause).toBe('fatal');
    const summaryMd = renderSummaryMd(results, config);
    const firstLine = summaryMd.split('\n')[0];
    expect(firstLine).toContain('ABORTED');
    expect(firstLine).toContain('fatal');
  });

  it('S11 retry defect (2): a normal duration_elapsed drain is NOT marked aborted, and notes laps still in flight', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' }
    });
    // `duration_elapsed` is the runner's NORMAL end-of-run drain cause — a
    // run that served its full requested `--minutes` must read as PASS,
    // never ABORTED, regardless of what drained.
    collector.runEnd({ aborted: false, abortCause: null, lapsInFlightAtStop: 4 });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.run.aborted).toBe(false);
    const summaryMd = renderSummaryMd(results, config);
    const firstLine = summaryMd.split('\n')[0];
    expect(firstLine).not.toContain('ABORTED');
    expect(firstLine).toContain('PASS');
    expect(firstLine).toContain('drained 4 in-flight laps');
  });

  it('a normal run with nothing in flight at stop reads as a plain PASS', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runEnd({ aborted: false, abortCause: null, lapsInFlightAtStop: 0 });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);
    const firstLine = summaryMd.split('\n')[0];
    expect(firstLine).toContain(' PASS —');
  });

  it('shows the throughput identity as OK or MISMATCH explicitly', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.setSchedulerCounters({ ticksOffered: 5, skippedBackpressure: 5, ticksLostToRamp: 0 });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toMatch(/Identity check.*\*\*OK\*\*/);
  });

  it('R29 (loadtest/REVIEW.md): renders ticksExpected alongside ticksOffered and flags a non-zero gap', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    // ticksOffered = 5 + 0 + 0 = 5 by construction (identity OK), but
    // ticksExpected is INDEPENDENT and can disagree.
    collector.setSchedulerCounters({
      ticksOffered: 5,
      skippedBackpressure: 0,
      ticksLostToRamp: 0,
      ticksExpected: 40
    });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.achieved.ticksExpected).toBe(40);
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('ticksExpected');
    expect(summaryMd).toMatch(/ticksOffered - ticksExpected.*\*\*-35\*\*/);
    expect(summaryMd).toContain('never even offered');
  });

  it('A10 (VALIDATION-1.md): reports achieved rate PER MODE, not one blended headline', () => {
    const config = {
      ...buildDevnetConfig(),
      users: { ...buildDevnetConfig().users, total: 4, browser: 2 }
    };
    const collector = createCollector();
    // Browser: both users tick 10 times each (fully achieving the
    // requested rate). Headless: both users never tick at all (100%
    // backpressure-starved). A single blended average would hide this
    // completely; the per-mode table must not.
    for (let i = 0; i < 20; i += 1) collector.tick('b', 'browser');
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.achieved.steadyStateRatePerUserPerModeMin.browser).not.toBeNull();
    expect(results.achieved.steadyStateRatePerUserPerModeMin.browser).toBeGreaterThan(0);
    expect(results.achieved.steadyStateRatePerUserPerModeMin.headless).toBe(0);
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('Achieved rate per mode');
    expect(summaryMd).toMatch(/\|\s*browser\s*\|\s*2\s*\|/);
    expect(summaryMd).toMatch(/\|\s*headless\s*\|\s*2\s*\|/);
  });

  it('S27 (plans/bridge-loadtest-plan.md §7): reports attempted-vs-completed laps PER MODE, alongside A10', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    // Browser: 3 laps started, all 3 finish (2 done, 1 failed) — 66.7%.
    // Headless: 2 laps started, both finish, 0 complete — the near-total
    // collapse this gate exists to catch.
    collector.lapEnd({ userId: 'b1', mode: 'browser', lapId: 'l1', outcome: 'LAP_DONE' });
    collector.lapEnd({ userId: 'b2', mode: 'browser', lapId: 'l2', outcome: 'LAP_DONE' });
    collector.lapEnd({ userId: 'b3', mode: 'browser', lapId: 'l3', outcome: 'LAP_FAILED' });
    collector.lapEnd({ userId: 'h1', mode: 'headless', lapId: 'l4', outcome: 'LAP_FAILED' });
    collector.lapEnd({ userId: 'h2', mode: 'headless', lapId: 'l5', outcome: 'LAP_ABORTED' });

    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.laps.byMode.browser).toStrictEqual({
      attempted: 3,
      completed: 2,
      completionRate: 2 / 3
    });
    expect(results.laps.byMode.headless).toStrictEqual({
      attempted: 2,
      completed: 0,
      completionRate: 0
    });

    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('Per-mode lap reliability');
    expect(summaryMd).toMatch(/\|\s*browser\s*\|\s*3\s*\|\s*2\s*\|\s*66\.7%\s*\|/);
    expect(summaryMd).toMatch(/\|\s*headless\s*\|\s*2\s*\|\s*0\s*\|\s*0\.0%\s*\|/);
  });

  it('S30 (plans/bridge-loadtest-plan.md §7/§8): reports attempted-vs-completed hops PER ROUTE x PER MODE', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    // L2B->L1: browser completes both its hops; headless completes 1 of 2
    // — the exact shape of S26/S29's pre-fix headless-only degradation on
    // this route, invisible in the mode-blind `hops.byRoute` aggregate.
    collector.hopEnd({
      userId: 'b1',
      mode: 'browser',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    collector.hopEnd({
      userId: 'b2',
      mode: 'browser',
      hopId: 'h2',
      lapId: 'l2',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    collector.hopEnd({
      userId: 'h1',
      mode: 'headless',
      hopId: 'h3',
      lapId: 'l3',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    collector.hopEnd({
      userId: 'h2',
      mode: 'headless',
      hopId: 'h4',
      lapId: 'l4',
      hopRoute: 'L2B->L1',
      outcome: 'rpc_error'
    });

    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.hops.byRouteMode['L2B->L1'].browser).toStrictEqual({
      attempted: 2,
      completed: 2,
      completionRate: 1
    });
    expect(results.hops.byRouteMode['L2B->L1'].headless).toStrictEqual({
      attempted: 2,
      completed: 1,
      completionRate: 0.5
    });

    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('Per-route x per-mode hop reliability');
    expect(summaryMd).toMatch(/\|\s*L2B->L1\s*\|\s*browser\s*\|\s*2\s*\|\s*2\s*\|\s*100\.0%\s*\|/);
    expect(summaryMd).toMatch(/\|\s*L2B->L1\s*\|\s*headless\s*\|\s*2\s*\|\s*1\s*\|\s*50\.0%\s*\|/);
  });

  it('S30: a (route, mode) pair with zero hops reaching hopEnd reports completionRate n/a, never a false 0%', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.hopEnd({
      userId: 'b1',
      mode: 'browser',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L2B->L1',
      outcome: 'hop_completed_manual'
    });
    // headless: no hopEnd calls on this route at all.
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.hops.byRouteMode['L2B->L1'].headless).toStrictEqual({
      attempted: 0,
      completed: 0,
      completionRate: null
    });
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toMatch(
      /\|\s*L2B->L1\s*\|\s*headless\s*\|\s*0\s*\|\s*0\s*\|\s*n\/a \(0 attempted\)\s*\|/
    );
  });

  it('S27: a mode with zero laps reaching lapEnd reports completionRate n/a, never a false 0%', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.lapEnd({ userId: 'b1', mode: 'browser', lapId: 'l1', outcome: 'LAP_DONE' });
    // headless: no lapEnd calls at all.
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.laps.byMode.headless).toStrictEqual({
      attempted: 0,
      completed: 0,
      completionRate: null
    });
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toMatch(/\|\s*headless\s*\|\s*0\s*\|\s*0\s*\|\s*n\/a \(0 attempted\)\s*\|/);
  });

  it('R7 (loadtest/REVIEW.md): "No errors recorded" distinguishes truly-empty from suppressed-only', () => {
    const config = buildDevnetConfig();
    const collectorEmpty = createCollector();
    const emptyResults = buildResultsJson({ snapshot: collectorEmpty.snapshot(), config });
    expect(renderSummaryMd(emptyResults, config)).toContain('No errors recorded.');

    const collectorSuppressed = createCollector();
    collectorSuppressed.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'not_ready',
      message: 'not ready'
    });
    const suppressedResults = buildResultsJson({
      snapshot: collectorSuppressed.snapshot(),
      config
    });
    const summaryMd = renderSummaryMd(suppressedResults, config);
    expect(summaryMd).toContain('No non-suppressed errors recorded (1 suppressed');
    expect(summaryMd).not.toContain('No errors recorded.');
    expect(summaryMd).toMatch(/not_ready\s*\|\s*1/);
  });

  it('R2 (loadtest/REVIEW.md): the Phase latencies table discloses the timedOut column and a censoring note', () => {
    const config = buildDevnetConfig();
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
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('timedOut');
    expect(summaryMd).toContain('Note (R2)');
    // The row itself shows the real p50 (10000, unaffected by the censored
    // sample) alongside a timedOut count of 1.
    expect(summaryMd).toMatch(/ready_to_claim.*n=1 p50=10000.*\|\s*1\s*\|/);
  });

  it('R6 (loadtest/REVIEW.md): the Gate stalls table discloses timedOutVisits and a censoring note', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.recordGateVisit({ gate: 'claim-proof', durationMs: 900_000, timedOut: true });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('timedOutVisits');
    expect(summaryMd).toContain('Note (R6)');
  });

  it('R8 (loadtest/REVIEW.md): achieved rate divides by ELAPSED minutes when known, not requested', () => {
    const config = {
      ...buildDevnetConfig(),
      users: { ...buildDevnetConfig().users, total: 1 },
      load: {
        ...buildDevnetConfig().load,
        bridgesPerMinutePerUser: 2,
        durationMinutes: 20,
        rampUpSeconds: 0
      }
    };
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' }
    });
    // Simulate a run SIGINT-ed after 4 minutes of a requested 20: 8 lap
    // starts actually submitted (rate 2/min for 4 min = 8 — the tool DID
    // achieve its requested rate in the time it actually ran).
    for (let i = 0; i < 8; i += 1) collector.tick('u0', 'headless');
    collector.runEnd({ aborted: true, abortCause: 'sigint' });
    // Directly stamp an elapsed duration of 4 minutes (240_000ms) — a real
    // run's `run.durationMs` comes from `runStart`/`runEnd` timestamps;
    // this asserts against a fixed value rather than real wall-clock time.
    const snapshot = {
      ...collector.snapshot(),
      run: { ...collector.snapshot().run, durationMs: 240_000 }
    };
    const results = buildResultsJson({ snapshot, config });
    // 8 lap-starts / (1 user x 4 elapsed minutes) = 2.0000 — the REQUESTED
    // rate, not ~0.4 (8 / (1 x 19 requested-minus-ramp minutes)).
    expect(results.achieved.steadyStateRatePerUserPerMin).toBeCloseTo(2, 4);
  });

  it('R9 (loadtest/REVIEW.md): a config with rampUpSeconds >= durationMinutes*60 is rejected by the schema', () => {
    // Covered directly in config/schema.test.ts; this asserts the DEFAULT
    // ramp (60s) really does hit the R9 failure mode a naive `--minutes 1`
    // invocation would have silently produced, absent the schema guard —
    // i.e. that steadyStateMinutes itself still floors at 0 rather than
    // going negative, for a config that (hypothetically, or from an older
    // results.json) still has ramp >= duration.
    const config = {
      ...buildDevnetConfig(),
      load: {
        ...buildDevnetConfig().load,
        bridgesPerMinutePerUser: 2,
        durationMinutes: 1,
        rampUpSeconds: 60
      }
    };
    const collector = createCollector();
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    expect(results.achieved.steadyStateRatePerUserPerMin).toBe(0);
  });
});

describe("secrets never reach any output path (DESIGN §2.2 / this step's acceptance criterion 5)", () => {
  it('results.json shows env:NAME, never the resolved secret value, and errors are redacted', () => {
    const config = buildDevnetConfig();
    // The funder's private key is always a secretRef per config/schema.ts —
    // simulate the case where the referenced env var happens to be set to a
    // real-looking key, and confirm the report never reads or echoes it.
    process.env.LOADTEST_TEST_FUNDER_KEY = PRIVATE_KEY;
    const configWithSecretRef: LoadtestConfig = {
      ...config,
      users: {
        ...config.users,
        funder: {
          ...config.users.funder,
          privateKeyRef: { env: 'LOADTEST_TEST_FUNDER_KEY' },
          gasPerChain: config.users.funder?.gasPerChain ?? {},
          maxTotalSpend: config.users.funder?.maxTotalSpend ?? {}
        } as LoadtestConfig['users']['funder']
      }
    };

    const collector = createCollector();
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: 'internal',
      message: `leak attempt ${PRIVATE_KEY}`
    });
    const results = buildResultsJson({
      snapshot: collector.snapshot(),
      config: configWithSecretRef
    });
    const summaryMd = renderSummaryMd(results, configWithSecretRef);

    const resultsText = JSON.stringify(results);
    expect(resultsText).not.toContain(PRIVATE_KEY);
    expect(resultsText).toContain('env:LOADTEST_TEST_FUNDER_KEY');
    expect(summaryMd).not.toContain(PRIVATE_KEY);

    delete process.env.LOADTEST_TEST_FUNDER_KEY;
  });
});

describe('writeReportFiles — disk I/O wrapper', () => {
  it('writes a parseable results.json and a summary.md with every heading', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 2, totalMemMb: 4096, platform: 'linux' }
    });
    collector.hopEnd({
      userId: 'u1',
      mode: 'headless',
      hopId: 'h1',
      lapId: 'l1',
      hopRoute: 'L1->L2A',
      outcome: 'hop_completed_auto'
    });
    collector.runEnd({ aborted: false, abortCause: null });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-report-test-'));
    try {
      const { resultsPath, summaryPath } = writeReportFiles({
        dir,
        snapshot: collector.snapshot(),
        config
      });
      const resultsOnDisk = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      expect(resultsOnDisk.schemaVersion).toBe(1);
      const summaryOnDisk = fs.readFileSync(summaryPath, 'utf8');
      SUMMARY_HEADINGS.forEach((heading) => expect(summaryOnDisk).toContain(heading));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

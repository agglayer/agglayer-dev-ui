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
import { classifyActivityWarning } from './errors';
import {
  buildResultsJson,
  checkThroughputIdentity,
  computeVerdict,
  failureRates,
  HARD_HOP_FAILURE_OUTCOMES,
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
  '## Environment',
  '## Claim gas and stage latency'
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

describe('redactConfigForReport — RPC URLs are masked to the host (S54)', () => {
  // Obviously fake: the host is a reserved .invalid name and the "key" spells out its purpose.
  const FAKE_KEY = 'FAKEKEYFAKEKEYFAKEKEY0123456789';

  it('keeps only scheme and host for a URL carrying a path token, a query or userinfo', () => {
    const input = {
      chains: [
        { key: 'A', rpcUrl: `https://rpc.example.invalid/${FAKE_KEY}` },
        { key: 'B', rpcUrl: `https://rpc.example.invalid/v3/${FAKE_KEY}` },
        { key: 'C', rpcUrl: `https://rpc.example.invalid:8443/?apikey=${FAKE_KEY}` },
        { key: 'D', rpcUrl: `https://user:${FAKE_KEY}@rpc.example.invalid` }
      ]
    };
    const out = JSON.stringify(redactConfigForReport(input));
    expect(out).not.toContain(FAKE_KEY);
    expect(redactConfigForReport(input)).toStrictEqual({
      chains: [
        { key: 'A', rpcUrl: 'https://rpc.example.invalid/<redacted>' },
        { key: 'B', rpcUrl: 'https://rpc.example.invalid/<redacted>' },
        { key: 'C', rpcUrl: 'https://rpc.example.invalid:8443/<redacted>' },
        { key: 'D', rpcUrl: 'https://rpc.example.invalid/<redacted>' }
      ]
    });
  });

  it('leaves a bare-origin RPC URL (a public node, no token) and an unset URL untouched', () => {
    const input = {
      chains: [
        { key: 'A', rpcUrl: 'http://127.0.0.1:8545' },
        { key: 'B', rpcUrl: 'https://rpc.example.invalid/' },
        { key: 'C', rpcUrl: '' }
      ]
    };
    expect(redactConfigForReport(input)).toStrictEqual(input);
  });

  it('masks an unparseable RPC URL instead of storing it', () => {
    expect(redactConfigForReport({ rpcUrl: `not a url ${FAKE_KEY}` })).toStrictEqual({
      rpcUrl: '<redacted url>'
    });
  });

  it('applies the display redaction to the other URL fields only when they hold a secret shape', () => {
    const out = redactConfigForReport({
      aggkitProxyUrl: 'http://proxy.example.invalid/aggkitapi',
      explorerUrl: `https://explorer.example.invalid/?apikey=${FAKE_KEY}`
    }) as Record<string, string>;
    expect(out.aggkitProxyUrl).toBe('http://proxy.example.invalid/aggkitapi');
    expect(out.explorerUrl).toBe('https://explorer.example.invalid/<redacted>');
  });

  it('never stores the key in the results.json a run writes', () => {
    const base = buildDevnetConfig();
    const keyed: LoadtestConfig = {
      ...base,
      chains: base.chains.map((chain, index) =>
        index === 0 ? { ...chain, rpcUrl: `https://rpc.example.invalid/${FAKE_KEY}` } : chain
      )
    };
    const collector = createCollector({ clock: { now: () => 1_000 } });
    collector.runStart({
      toolVersion: 't',
      sdkVersion: 's',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' },
      rampUpSeconds: 0
    });
    const results = buildResultsJson({ snapshot: collector.snapshot(), config: keyed });
    expect(JSON.stringify(results)).not.toContain(FAKE_KEY);
    expect(renderSummaryMd(results, keyed)).not.toContain(FAKE_KEY);
    const chains = (results.config as { chains: { rpcUrl: string }[] }).chains;
    expect(chains[0].rpcUrl).toBe('https://rpc.example.invalid/<redacted>');
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
    // A lap start must exist, else the headline is NO LAPS STARTED, not PASS.
    collector.tick('u1', 'headless');
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

  // S40 (finding C13): tracker sync warnings are their own non-failing class,
  // visible in summary.md, and never counted as proxy_5xx.
  it('renders activity_warning as its own error class, separate from proxy_5xx, without failing the run', () => {
    const config = buildDevnetConfig();
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 4, totalMemMb: 8192, platform: 'linux' }
    });
    collector.tick('u1', 'headless');
    const classified = classifyActivityWarning({
      networkId: 0,
      message:
        'bridge service for network 0 is not fully synchronized, some bridges may still be missing'
    });
    collector.error({
      userId: 'u1',
      mode: 'headless',
      errorClass: classified.errorClass,
      message: classified.message,
      endpointClass: 'tracker/activity'
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

    const snapshot = collector.snapshot();
    expect(snapshot.errors.byClass.activity_warning).toBe(1);
    expect(snapshot.errors.byClass.proxy_5xx).toBeUndefined();
    const results = buildResultsJson({ snapshot, config });
    expect(results.hops.byOutcome.hop_completed_auto).toBe(1);

    const summaryMd = renderSummaryMd(results, config);
    expect(summaryMd).toContain('activity_warning');
    expect(summaryMd).toContain('activity_warning[network_id=0]: bridge service for network 0');
    expect(summaryMd).not.toContain('proxy_5xx');
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
    collector.tick('u1', 'headless');
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
    collector.tick('u1', 'headless');
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

describe('measurements — results.json `measurements` key and the summary section (S45 C3/C4)', () => {
  const measured = (config: LoadtestConfig) => {
    const collector = createCollector();
    collector.runStart({
      toolVersion: 'v1',
      sdkVersion: 'sdk1',
      host: { cores: 1, totalMemMb: 1, platform: 'linux' }
    });
    collector.hopMeasurement({
      hopId: 'h1',
      lapId: 'l1',
      userId: 'u1',
      mode: 'headless',
      hopRoute: 'BALI_82->BALI_85',
      fromNetworkId: 82,
      toNetworkId: 85,
      assetKind: 'eth',
      assetIndex: 0,
      outcome: 'hop_completed_manual',
      depositCount: 1,
      bridge: { txHash: '0xb', blockNumber: '1', minedObservedAt: 1000, gas: null },
      stages: {
        l1InfoTreeIndexAt: 2000,
        l1InfoTreeIndex: 1,
        injectedLeafAt: 3000,
        injectedLeafIndex: 2,
        claimProofAt: 3000,
        polls: 4
      },
      readyObservedAt: 4000,
      claim: {
        txHash: '0xc',
        blockNumber: '2',
        sentAt: 5000,
        minedObservedAt: 6000,
        gas: { blockNumber: '2', gasUsed: '90000', effectiveGasPrice: '1000', l1Fee: '120' },
        claimKind: 'eth'
      }
    });
    collector.runEnd({ aborted: false, abortCause: null });
    return buildResultsJson({ snapshot: collector.snapshot(), config });
  };

  it('adds a `measurements` block with the per-hop records, gas rows and stage rows', () => {
    const config = parseLoadtestConfig({
      ...JSON.parse(JSON.stringify(buildDevnetConfig())),
      measurement: { stageProbeIntervalMs: 5000 }
    });
    const results = measured(config);

    expect(results.measurements?.probeIntervalMs).toBe(5000);
    expect(results.measurements?.hops).toHaveLength(1);
    expect(results.measurements?.claimGas[0]).toMatchObject({ toNetworkId: 85, claimKind: 'eth', n: 1 });
    expect(results.measurements?.stageLatency[0].deltas.claimProof).toStrictEqual({
      n: 1,
      min: 2000,
      median: 2000,
      max: 2000
    });
  });

  it('renders the new section LAST, after ## Environment, leaving the existing order unchanged', () => {
    const config = buildDevnetConfig();
    const summary = renderSummaryMd(measured(config), config);

    expect(summary.indexOf('## Claim gas and stage latency')).toBeGreaterThan(
      summary.indexOf('## Environment')
    );
    expect(summary).toContain('| 85 | eth | 1 |');
    expect(summary).toContain('T3b-T3 tracker READY lag after claim-proof | 1 / 1000 / 1000 / 1000');
  });

  it('regenerates byte-identically from results.json (the `report --dir` path)', () => {
    const config = buildDevnetConfig();
    const results = measured(config);
    const original = renderSummaryMd(results, config);
    const reloaded = JSON.parse(JSON.stringify(results)) as typeof results;
    expect(renderSummaryMd(reloaded, reloaded.config as LoadtestConfig)).toBe(original);
  });

  it('renders "No measurements recorded." and omits the key for a run/results with no hop measurements', () => {
    const config = buildDevnetConfig();
    const results = buildResultsJson({ snapshot: createCollector().snapshot(), config });
    expect('measurements' in results).toBe(false);
    expect(renderSummaryMd(results, config)).toMatch(
      /## Claim gas and stage latency\n\nNo measurements recorded\.\n$/
    );
  });
});

// S53 / heavy-load design F1 and §5: `summary.md` must not echo a provider key
// through the proxy URL line or through an `rpc/<segment>` endpoint class, and a
// keyless run must still render exactly as before. Every key below is fake.
describe('renderSummaryMd — redaction of URLs and endpoint classes (S53)', () => {
  const TOKEN = 'AbCdEf0123456789TokenXyz';

  const keyedRun = () => {
    const base = buildDevnetConfig();
    const config: LoadtestConfig = {
      ...base,
      aggkitProxyUrl: 'https://proxy.example.invalid/gw?apikey=SECRETQ',
      chains: base.chains.map((chain, index) =>
        index === 0 ? { ...chain, rpcUrl: `https://rpc.example.invalid/${TOKEN}` } : chain
      )
    };
    const collector = createCollector();
    for (const endpointClass of [`rpc/${TOKEN}/eth_call`, 'rpc/l2rpc-001/eth_getBalance']) {
      collector.recordHttpSample({
        userId: 'u0',
        mode: 'headless',
        endpointClass,
        method: 'POST',
        status: 200,
        durationMs: 5,
        attempt: 0
      });
    }
    collector.error({
      userId: 'u0',
      mode: 'headless',
      errorClass: 'rpc_error',
      message: 'RPC error: boom',
      endpointClass: `rpc/${TOKEN}/eth_call`
    });
    return { config, results: buildResultsJson({ snapshot: collector.snapshot(), config }) };
  };

  it('prints neither the proxy URL query nor the keyed endpoint segment', () => {
    const { config, results } = keyedRun();
    const summary = renderSummaryMd(results, config);
    expect(summary).not.toContain(TOKEN);
    expect(summary).not.toContain('SECRETQ');
    expect(summary).toContain('- aggkitProxyUrl: https://proxy.example.invalid/<redacted>');
    expect(summary).toContain('rpc/L1/eth_call');
  });

  it('leaves a short path name (`l2rpc-001`) and a secret-free proxy URL exactly as before', () => {
    const { config, results } = keyedRun();
    const summary = renderSummaryMd(results, {
      ...config,
      aggkitProxyUrl: 'http://127.0.0.1:8555/aggkitapi'
    });
    expect(summary).toContain('- aggkitProxyUrl: http://127.0.0.1:8555/aggkitapi\n');
    expect(summary).toContain('| rpc/l2rpc-001/eth_getBalance |');
  });

  it('regenerating from a keyed results.json (the `report --dir` path) also drops the key', () => {
    const { config, results } = keyedRun();
    const reloaded = JSON.parse(JSON.stringify(results)) as typeof results;
    const summary = renderSummaryMd(reloaded, reloaded.config as LoadtestConfig);
    expect(summary).not.toContain(TOKEN);
    expect(summary).not.toContain('SECRETQ');
    expect(config.chains[0].rpcUrl).toContain(TOKEN);
  });
});

// S53 (heavy-load design §1.3/§1.4): optional results.json keys and summary
// sections. Each exists only when its producer ran / was configured.
describe('buildResultsJson / renderSummaryMd — pump, wallet balances and L1 info tree (S53)', () => {
  const pumpStarted = {
    kind: 'state' as const,
    state: 'started' as const,
    sender: '0x00000000000000000000000000000000000000b1',
    intervalSeconds: 600,
    maxTotalSpendWei: '70000000000000000',
    maxGasPriceWei: '5000000000',
    destinationNetworkId: 1,
    amountWei: '0'
  };

  const configWith = (measurement: LoadtestConfig['measurement']): LoadtestConfig => ({
    ...buildDevnetConfig(),
    measurement
  });

  const heavyCollector = () => {
    const collector = createCollector();
    collector.pumpEvent(pumpStarted);
    collector.pumpEvent({
      kind: 'deposit',
      txHash: `0x${'ab'.repeat(32)}`,
      blockNumber: '123',
      depositCount: 7,
      status: 'success',
      gasUsed: '437125',
      effectiveGasPrice: '1000000',
      costWei: '437125000000',
      cumulativeSpendWei: '437125000000',
      sentAt: 1,
      minedObservedAt: 2
    });
    collector.pumpEvent({ kind: 'skipped', reason: 'gas_price', gasPriceWei: '6000000000', cumulativeSpendWei: '437125000000' });
    collector.pumpEvent({ ...pumpStarted, state: 'stopped', pendingAtStop: false, totalSpendWei: '437125000000' });
    collector.walletBalance({ chainKey: 'L2A', n: 2, minWei: '5', medianWei: '6', maxWei: '7', lowest: [{ userId: 'u0', wei: '5' }] });
    collector.l1InfoTreeStart({ gerManagerAddress: '0x00000000000000000000000000000000000000a1', baselineLeafCount: 500 });
    collector.l1InfoLeaf({ blockNumber: '124', leafCount: 501, txHash: `0x${'ab'.repeat(32)}`, minTimestamp: 9, fromPump: true });
    collector.l1InfoLeaf({ blockNumber: '130', leafCount: 502, txHash: `0x${'cd'.repeat(32)}`, minTimestamp: 10, fromPump: false });
    collector.runStart({ toolVersion: 't', sdkVersion: 's', host: { cores: 1, totalMemMb: 1, platform: 'linux' } });
    collector.runEnd({ aborted: false, abortCause: null });
    return collector;
  };

  it('adds pump, walletBalances and l1InfoTree to results.json when the run produced / configured them', () => {
    const config = configWith({
      walletBalanceIntervalMs: 300_000,
      l1InfoTree: { pollIntervalMs: 60_000 }
    });
    const results = buildResultsJson({ snapshot: heavyCollector().snapshot(), config });

    expect(results.pump).toMatchObject({
      enabled: true,
      sender: pumpStarted.sender,
      deposits: [{ depositCount: 7, status: 'success', blockNumber: '123' }],
      skipped: { gas_price: 1 },
      totalSpendWei: '437125000000',
      pendingAtStop: false
    });
    expect(results.walletBalances).toMatchObject({
      intervalMs: 300_000,
      samples: [{ chainKey: 'L2A', n: 2 }]
    });
    expect(results.l1InfoTree).toMatchObject({
      gerManagerAddress: '0x00000000000000000000000000000000000000a1',
      baselineLeafCount: 500,
      pollErrors: 0
    });
    expect(results.l1InfoTree?.leaves).toHaveLength(2);
  });

  it('a configured sampler that took no sample still yields an empty block, so "not sampled" is distinguishable from "not configured"', () => {
    const config = configWith({ walletBalanceIntervalMs: 300_000, l1InfoTree: { pollIntervalMs: 60_000 } });
    const results = buildResultsJson({ snapshot: createCollector().snapshot(), config });
    expect(results.walletBalances).toStrictEqual({ intervalMs: 300_000, samples: [] });
    expect(results.l1InfoTree).toStrictEqual({
      gerManagerAddress: null,
      baselineLeafCount: null,
      leaves: [],
      pollErrors: 0
    });
    expect('pump' in results).toBe(false);
  });

  it('adds none of the keys for a run without them (a measurement block with only the stage probe included)', () => {
    for (const config of [buildDevnetConfig(), configWith({ stageProbeIntervalMs: 5000 })]) {
      const results = buildResultsJson({ snapshot: createCollector().snapshot(), config });
      for (const key of ['pump', 'walletBalances', 'l1InfoTree']) {
        expect(key in results).toBe(false);
      }
    }
  });

  it('appends ## Pump and ## L1 info tree after the existing sections, only when present', () => {
    const config = configWith({ walletBalanceIntervalMs: 300_000, l1InfoTree: { pollIntervalMs: 60_000 } });
    const results = buildResultsJson({ snapshot: heavyCollector().snapshot(), config });
    const summary = renderSummaryMd(results, config);

    expect(summary.indexOf('## Pump')).toBeGreaterThan(summary.indexOf('## Claim gas and stage latency'));
    expect(summary.indexOf('## L1 info tree')).toBeGreaterThan(summary.indexOf('## Pump'));
    expect(summary).toContain('The L1 deposit pump was ON for this run');
    expect(summary).toContain(`| sender | ${pumpStarted.sender} |`);
    expect(summary).toContain('| total spend (ETH) | 0.000000437125 |');
    expect(summary).toContain('| spend cap (ETH) | 0.07 |');
    expect(summary).toContain('| max gas price (gwei) | 5 |');
    expect(summary).toContain('| deposits settled | 1 (0 reverted) |');
    expect(summary).toContain('| 7 | success | 437125 |');
    expect(summary).toContain('| leaves added during the run | 2 |');
    expect(summary).toContain('| from the pump / from other deposits | 1 / 1 |');

    const plain = renderSummaryMd(
      buildResultsJson({ snapshot: createCollector().snapshot(), config: buildDevnetConfig() }),
      buildDevnetConfig()
    );
    expect(plain).not.toContain('## Pump');
    expect(plain).not.toContain('## L1 info tree');
  });

  it('flags a deposit still pending at stop in the summary', () => {
    const collector = createCollector();
    collector.pumpEvent(pumpStarted);
    collector.pumpEvent({ ...pumpStarted, state: 'stopped', pendingAtStop: true, totalSpendWei: '2640000000000000' });
    const config = buildDevnetConfig();
    const summary = renderSummaryMd(buildResultsJson({ snapshot: collector.snapshot(), config }), config);
    expect(summary).toContain('a deposit was still pending at stop and is counted at its worst case');
    expect(summary).toContain('| pending at stop | yes |');
    expect(summary).toContain('No pump deposit settled.');
  });

  it('regenerates byte-identically from results.json (the `report --dir` path) with the new sections', () => {
    const config = configWith({ walletBalanceIntervalMs: 300_000, l1InfoTree: { pollIntervalMs: 60_000 } });
    const results = buildResultsJson({ snapshot: heavyCollector().snapshot(), config });
    const original = renderSummaryMd(results, config);
    const reloaded = JSON.parse(JSON.stringify(results)) as typeof results;
    expect(renderSummaryMd(reloaded, reloaded.config as LoadtestConfig)).toBe(original);
  });
});

// S53: the verdict helpers `report.ts` now exports for the HTML report (S54).
describe('computeVerdict / failureRates (S53)', () => {
  const resultsFor = (opts: {
    laps?: Partial<Record<'LAP_DONE' | 'LAP_FAILED' | 'LAP_ABORTED', number>>;
    hops?: Record<string, number>;
    aborted?: boolean;
    abortCause?: string | null;
    lapStarts?: number;
    inFlightAtStop?: number;
  }) => {
    const config = buildDevnetConfig();
    const results = buildResultsJson({ snapshot: createCollector().snapshot(), config });
    results.laps.byOutcome = { LAP_DONE: 0, LAP_FAILED: 0, LAP_ABORTED: 0, ...opts.laps };
    results.hops.byOutcome = opts.hops ?? {};
    results.run.aborted = opts.aborted ?? false;
    results.run.abortCause = opts.abortCause ?? null;
    results.achieved.lapStartsSubmitted = opts.lapStarts ?? 1;
    results.run.lapsInFlightAtStop = opts.inFlightAtStop ?? 0;
    return results;
  };

  it('keeps the exact verdict wording of the summary headline for every branch', () => {
    expect(computeVerdict(resultsFor({ laps: { LAP_DONE: 3 } }))).toBe('PASS');
    expect(computeVerdict(resultsFor({ laps: { LAP_DONE: 3 }, inFlightAtStop: 1 }))).toBe(
      'PASS (drained 1 in-flight lap)'
    );
    expect(computeVerdict(resultsFor({ laps: { LAP_DONE: 3 }, inFlightAtStop: 4 }))).toBe(
      'PASS (drained 4 in-flight laps)'
    );
    expect(computeVerdict(resultsFor({ lapStarts: 0 }))).toBe(
      'NO LAPS STARTED (0 lap starts — nothing was exercised)'
    );
    expect(computeVerdict(resultsFor({ aborted: true, abortCause: 'sigint' }))).toBe(
      'ABORTED (sigint)'
    );
    expect(computeVerdict(resultsFor({ aborted: true }))).toBe('ABORTED (unknown cause)');
    expect(
      computeVerdict(
        resultsFor({
          laps: { LAP_DONE: 2, LAP_FAILED: 1 },
          hops: { timeout_ready_to_claim: 1, hop_completed_manual: 2 }
        })
      )
    ).toBe('FAIL (1 of 3 lap(s) failed: timeout_ready_to_claim x1)');
    expect(
      computeVerdict(resultsFor({ laps: { LAP_DONE: 2, LAP_ABORTED: 2 }, hops: { aborted_drain: 2 } }))
    ).toBe('INCOMPLETE (2 of 4 lap(s) aborted: aborted_drain x2)');
    // FAIL wins when both are present.
    expect(computeVerdict(resultsFor({ laps: { LAP_FAILED: 1, LAP_ABORTED: 1 } }))).toMatch(/^FAIL /);
  });

  it('the summary headline is exactly computeVerdict', () => {
    const config = buildDevnetConfig();
    const results = resultsFor({ laps: { LAP_DONE: 2, LAP_FAILED: 1 }, hops: { proxy_5xx: 1 } });
    expect(renderSummaryMd(results, config).split('\n')[0]).toContain(
      ` — ${computeVerdict(results)} — users=`
    );
  });

  it('failureRates: lap failure rate and the hard hop-failure rate over the SC1 outcome set', () => {
    const rates = failureRates(
      resultsFor({
        laps: { LAP_DONE: 6, LAP_FAILED: 3, LAP_ABORTED: 1 },
        hops: {
          hop_completed_manual: 70,
          proxy_5xx: 4,
          rpc_error: 3,
          revert_claim: 2,
          internal: 1,
          // Not hard failures: stalls and drain aborts are watched by other criteria.
          timeout_ready_to_claim: 15,
          aborted_drain: 5
        }
      })
    );
    expect(rates).toStrictEqual({
      lapsFinished: 10,
      lapsFailed: 3,
      lapFailureRate: 0.3,
      hopsEnded: 100,
      hardHopFailures: 10,
      hardHopFailureRate: 0.1
    });
  });

  it('failureRates: null, never a false 0, when nothing finished', () => {
    expect(failureRates(resultsFor({}))).toStrictEqual({
      lapsFinished: 0,
      lapsFailed: 0,
      lapFailureRate: null,
      hopsEnded: 0,
      hardHopFailures: 0,
      hardHopFailureRate: null
    });
  });

  it('the hard-failure set is exactly the SC1 list: reverts, bridge_event_missing, activity_status_error, rpc and proxy errors, internal', () => {
    expect([...HARD_HOP_FAILURE_OUTCOMES].sort()).toStrictEqual(
      [
        'activity_status_error',
        'bridge_event_missing',
        'internal',
        'lbt_underflow',
        'proxy_4xx',
        'proxy_5xx',
        'revert_approve',
        'revert_bridge',
        'revert_claim',
        'rpc_error',
        'tx_revert'
      ].sort()
    );
  });
});

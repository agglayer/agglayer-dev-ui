// The report writer — DESIGN §6: `results.json` (§6.1) and `summary.md`
// (§6.3). `activity.ndjson` (§6.2) is NOT written here — `collector.ts` is
// its single writer, flushed as events occur, so a killed process still
// leaves a usable log. This module only ever READS a `CollectorSnapshot`
// (already-aggregated, in-memory data), never the live collector, so
// `report --dir` (S11) can regenerate `summary.md` byte-identically from a
// `results.json` already on disk without needing a collector at all —
// `renderSummaryMd` takes only a `ResultsJson`, `buildResultsJson` is the
// only place that also needs the `CollectorSnapshot` and the config.

import fs from 'node:fs';
import path from 'node:path';

import type { LoadtestAsset, LoadtestChain, LoadtestConfig } from '../config/schema';
import type { DriverMode } from '../core/userDriver';
import type {
  CollectorSnapshot,
  ErrorTopEntry,
  GateStats,
  HttpModeSplit,
  HttpStats,
  LapOutcome,
  ModeSplitStats,
  Stats
} from './collector';

export const RESULTS_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// `results.json` shape (DESIGN §6.1)
// ---------------------------------------------------------------------------

export interface RequestedLoad {
  users: number;
  browser: number;
  ratePerUserPerMin: number;
  minutes: number;
}

export interface AchievedLoad {
  ticksOffered: number;
  // S11 retry defect (1): the §5.5 invariant 1 identity term, in the SAME
  // unit as `ticksOffered`/`skippedBackpressure`/`ticksLostToRamp` (one per
  // lap-start opportunity) and the SAME unit `requested.ratePerUserPerMin`
  // is expressed in — see `metrics/collector.ts`'s `CollectorSnapshot.scheduler`
  // doc for why this replaces attempt #1's `bridgesSubmitted` (which counted
  // HOP-level bridge sends, `ring.length - 1` per lap start — a different
  // unit the identity could never hold against).
  lapStartsSubmitted: number;
  skippedBackpressure: number;
  ticksLostToRamp: number;
  // R29 (loadtest/REVIEW.md): an INDEPENDENT fourth term
  // (`users x rate x minutes`, from the config alone — never derived from
  // `ticksIssued`/`skippedBackpressure`/`ticksLostToRamp`), so a gap
  // between this and `ticksOffered` reveals demand the scheduler's token
  // bucket never offered in the first place — the one thing
  // `ticksOffered`'s own tautological definition (it IS the sum of those
  // three terms) can never show.
  ticksExpected: number;
  // Informational only — total per-hop bridge sends across the whole run
  // (NOT part of the identity check). Roughly `lapStartsSubmitted × (ring
  // hops per lap)`, less any lap that failed before reaching every hop.
  hopBridgesSubmitted: number;
  steadyStateRatePerUserPerMin: number;
  // A10 (VALIDATION-1.md): the blended rate above hides two modes behaving
  // completely differently (one run: browser ~1.79/user/min with zero
  // backpressure skips, headless ~0.61 with all skips) — reported per mode
  // so that is visible instead of averaged away. `null` for a mode with 0
  // configured users (no rate to report).
  steadyStateRatePerUserPerModeMin: { browser: number | null; headless: number | null };
}

export interface ResultsJson {
  schemaVersion: number;
  run: {
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    // S11 retry defect (2): `aborted` is true ONLY for abnormal termination
    // (SIGINT, a fatal error) — a run that served its full `--minutes` and
    // drained normally is `aborted: false`, even though a drain happened.
    aborted: boolean;
    abortCause: string | null;
    lapsInFlightAtStop: number;
    toolVersion: string | null;
    sdkVersion: string | null;
    host: { cores: number; totalMemMb: number; platform: string } | null;
  };
  config: unknown;
  requested: RequestedLoad;
  achieved: AchievedLoad;
  hops: {
    byOutcome: Partial<Record<string, number>>;
    byRoute: Record<string, { byOutcome: Partial<Record<string, number>>; phases: unknown }>;
  };
  laps: {
    byOutcome: Record<string, number>;
    // S27 (plans/bridge-loadtest-plan.md §7): per-mode "attempted vs
    // completed", extending the A10 achieved-rate-per-mode table (see
    // `AchievedLoad.steadyStateRatePerUserPerModeMin` above) alongside it
    // rather than duplicating it — that table answers "how often did a
    // mode START a lap", this answers "of the laps a mode started, how many
    // actually FINISHED". `attempted` is the sum of a mode's three
    // `lapsByOutcomeByMode` counts (every lap that reached `lapEnd` — i.e.
    // excludes only whatever was still `LAP_RUNNING`, in flight, when the
    // run stopped); `completed` is its `LAP_DONE` count;
    // `completionRate` is `completed / attempted`, or `null` when a mode
    // had zero laps reach `lapEnd` (never a false 0% — DESIGN §5.5
    // invariant 5's "never fill in a zero for absent data" rule, applied
    // here). This is the number the browser-mode collapse (pre-S25: 1 of
    // ~58 laps, ~2%) would have made visible on the FACE of `summary.md`
    // instead of requiring a reader to notice `activity.ndjson` error
    // classes.
    byMode: Record<DriverMode, LapReliability>;
  };
  phases: unknown;
  // R2 (loadtest/REVIEW.md): see `CollectorSnapshot.phaseCensoredCounts`'s
  // doc — how many MORE hops entered a phase and timed out rather than
  // completing it, kept separate from `phases`' percentile-bearing counts.
  phaseCensoredCounts: Partial<Record<string, number>>;
  // R11 (loadtest/REVIEW.md): see `CollectorSnapshot.uncontextedRequests`'s
  // doc — 0 means the `http` table below is complete.
  uncontextedRequests: number;
  // S24 / DESIGN §9.3 finding C16: each mode's HTTP samples are further
  // split by origin (`ui` = real UI-shaped load, the headline; `harness` =
  // the driver's own control-flow traffic, reported but not the headline).
  http: Record<string, HttpModeSplit<HttpStats>>;
  gates: Partial<Record<string, GateStats>>;
  errors: {
    byClass: Partial<Record<string, number>>;
    top: ErrorTopEntry[];
    // R7 (loadtest/REVIEW.md): counted, not silently dropped.
    suppressed: { notReady: number; benignExternalAsset: number };
  };
  policy: { autoclaimOverdue: number; unexpectedAutoclaim: number; claimRaceLost: number };
  resources: CollectorSnapshot['resources'];
}

// ---------------------------------------------------------------------------
// Config redaction — DESIGN §6.1: "the validated config, with every
// secretRef replaced by {"ref":"env:NAME"}". Structural (walks the parsed
// object for the `{env}` / `{file}` secretRef shape `config/schema.ts`
// defines), NOT a second free-text redactor — `wallets/redact.ts`'s
// `redactSecrets` remains the only text-pattern redactor (S07 constraint).
// ---------------------------------------------------------------------------

const isSecretRefShape = (value: unknown): value is { env: string } | { file: string } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return false;
  const [key] = keys;
  return (
    (key === 'env' || key === 'file') && typeof (value as Record<string, unknown>)[key] === 'string'
  );
};

export const redactConfigForReport = (value: unknown): unknown => {
  if (isSecretRefShape(value)) {
    const ref = 'env' in value ? `env:${value.env}` : `file:${value.file}`;
    return { ref };
  }
  if (Array.isArray(value)) return value.map(redactConfigForReport);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactConfigForReport(v)
      ])
    );
  }
  return value;
};

// ---------------------------------------------------------------------------
// `requested` / `achieved` derivation
// ---------------------------------------------------------------------------

export const requestedFromConfig = (config: LoadtestConfig): RequestedLoad => ({
  users: config.users.total,
  browser: config.users.browser,
  ratePerUserPerMin: config.load.bridgesPerMinutePerUser,
  minutes: config.load.durationMinutes
});

// R8 (loadtest/REVIEW.md): `steadyStateMinutes` used to be computed ONLY
// from the REQUESTED config (`durationMinutes - rampUpSeconds/60`) — so a
// run SIGINT-ed at t=4 of a requested 20 minutes still divided by ~19
// steady-state minutes, understating the achieved rate by ~5x versus what
// was actually achieved in the time the run actually ran. When the
// collector recorded a real elapsed `run.durationMs` (i.e. `runEnd()` was
// called — a live run, or a `report --dir` regenerating from a completed
// run's `results.json`), that ELAPSED duration is used instead of the
// requested one; the requested value remains the fallback for a
// `results.json` that never got that far (or an older schema).
const steadyStateMinutes = (config: LoadtestConfig, elapsedMs: number | null): number => {
  const totalMinutes = elapsedMs !== null ? elapsedMs / 60_000 : config.load.durationMinutes;
  return Math.max(0, totalMinutes - config.load.rampUpSeconds / 60);
};

export const achievedFromSnapshot = (
  snapshot: CollectorSnapshot,
  config: LoadtestConfig
): AchievedLoad => {
  const minutes = steadyStateMinutes(config, snapshot.run.durationMs);
  // S11 retry defect (1): `lapStartsSubmittedSteady` is in lap-starts/user,
  // the SAME unit `config.load.bridgesPerMinutePerUser` (`--rate`) requests
  // — unlike attempt #1's `bridgesSubmittedSteady`, which counted hop-level
  // sends and so reported an achieved rate ~(ring hops per lap)× too high.
  const rate =
    minutes > 0 && config.users.total > 0
      ? snapshot.scheduler.lapStartsSubmittedSteady / (config.users.total * minutes)
      : 0;

  // A10 (VALIDATION-1.md): the same division, per mode, against that
  // mode's OWN user count (`config.users.browser` / the remainder).
  const browserUsers = config.users.browser;
  const headlessUsers = config.users.total - config.users.browser;
  const rateForMode = (users: number, mode: 'browser' | 'headless'): number | null =>
    minutes > 0 && users > 0
      ? snapshot.scheduler.lapStartsSubmittedSteadyByMode[mode] / (users * minutes)
      : null;

  return {
    ticksOffered: snapshot.scheduler.ticksOffered,
    lapStartsSubmitted: snapshot.scheduler.lapStartsSubmitted,
    skippedBackpressure: snapshot.scheduler.skippedBackpressure,
    ticksLostToRamp: snapshot.scheduler.ticksLostToRamp,
    ticksExpected: snapshot.scheduler.ticksExpected,
    hopBridgesSubmitted: snapshot.scheduler.hopBridgesSubmitted,
    steadyStateRatePerUserPerMin: rate,
    steadyStateRatePerUserPerModeMin: {
      browser: rateForMode(browserUsers, 'browser'),
      headless: rateForMode(headlessUsers, 'headless')
    }
  };
};

/** DESIGN §5.5 invariant 1: `ticks_offered = lap_starts_submitted + skipped_backpressure + ticks_lost_to_ramp` — all four terms in the SAME unit (one per lap-start opportunity). */
export const checkThroughputIdentity = (achieved: AchievedLoad): boolean =>
  achieved.ticksOffered ===
  achieved.lapStartsSubmitted + achieved.skippedBackpressure + achieved.ticksLostToRamp;

// ---------------------------------------------------------------------------
// S27 (plans/bridge-loadtest-plan.md §7): per-mode lap reliability —
// "attempted vs completed", so a mode collapsing toward 0% completion is
// visible on the face of `summary.md` (see `ResultsJson.laps.byMode`'s doc
// above for the exact terms and why `completionRate` is `null`, never a
// false `0`, for a mode with zero laps reaching `lapEnd`).
// ---------------------------------------------------------------------------

export interface LapReliability {
  attempted: number;
  completed: number;
  completionRate: number | null;
}

const lapReliabilityForMode = (counts: Record<LapOutcome, number>): LapReliability => {
  const attempted = counts.LAP_DONE + counts.LAP_FAILED + counts.LAP_ABORTED;
  return {
    attempted,
    completed: counts.LAP_DONE,
    completionRate: attempted > 0 ? counts.LAP_DONE / attempted : null
  };
};

export const lapReliabilityByMode = (
  lapsByOutcomeByMode: CollectorSnapshot['lapsByOutcomeByMode']
): Record<DriverMode, LapReliability> => ({
  browser: lapReliabilityForMode(lapsByOutcomeByMode.browser),
  headless: lapReliabilityForMode(lapsByOutcomeByMode.headless)
});

// ---------------------------------------------------------------------------
// `results.json` assembly
// ---------------------------------------------------------------------------

export const buildResultsJson = (params: {
  snapshot: CollectorSnapshot;
  config: LoadtestConfig;
}): ResultsJson => {
  const { snapshot, config } = params;
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: {
      startedAt: snapshot.run.startedAt,
      endedAt: snapshot.run.endedAt,
      durationMs: snapshot.run.durationMs,
      aborted: snapshot.run.aborted,
      abortCause: snapshot.run.abortCause,
      lapsInFlightAtStop: snapshot.run.lapsInFlightAtStop,
      toolVersion: snapshot.run.toolVersion,
      sdkVersion: snapshot.run.sdkVersion,
      host: snapshot.run.host
    },
    config: redactConfigForReport(config),
    requested: requestedFromConfig(config),
    achieved: achievedFromSnapshot(snapshot, config),
    hops: {
      byOutcome: snapshot.hopsByOutcome,
      byRoute: snapshot.hopsByRoute
    },
    laps: {
      byOutcome: snapshot.lapsByOutcome,
      byMode: lapReliabilityByMode(snapshot.lapsByOutcomeByMode)
    },
    phases: snapshot.phases,
    phaseCensoredCounts: snapshot.phaseCensoredCounts,
    uncontextedRequests: snapshot.uncontextedRequests,
    http: snapshot.http,
    gates: snapshot.gates,
    errors: snapshot.errors,
    policy: snapshot.policy,
    resources: snapshot.resources
  };
};

// ---------------------------------------------------------------------------
// `summary.md` — fixed DESIGN §6.3 section order. `renderSummaryMd` is a
// pure function of `ResultsJson` (never the collector), so S11's
// `report --dir` can regenerate it byte-identically from a `results.json`
// already on disk.
// ---------------------------------------------------------------------------

const fmtStats = (stats: Stats | null): string =>
  stats === null
    ? 'n/a'
    : `n=${stats.n} p50=${stats.p50} p90=${stats.p90} p99=${stats.p99} max=${stats.max}`;

const mdTable = (headers: string[], rows: string[][]): string => {
  const headerLine = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerLine, separator, ...bodyLines].join('\n');
};

const chainLabel = (config: LoadtestConfig, key: string): string => {
  const chain = config.chains.find((c: LoadtestChain) => c.key === key);
  return chain === undefined ? key : `${key} (networkId ${chain.networkId})`;
};

const renderConfiguration = (config: LoadtestConfig): string => {
  const redacted = redactConfigForReport(config) as Record<string, unknown>;
  const ringLine = config.ring.map((key) => chainLabel(config, key)).join(' -> ');
  const assetsLines = config.assets.map(
    (asset: LoadtestAsset, index: number) => `- assets[${index}]: ${JSON.stringify(asset)}`
  );
  const autoclaimLines = Object.entries(config.autoclaim).map(
    ([hop, entry]) => `- ${hop}: ${JSON.stringify(entry)}`
  );
  const timeoutsLine = JSON.stringify(config.timeouts);

  return [
    `- env: ${config.env}`,
    `- aggkitProxyUrl: ${config.aggkitProxyUrl}`,
    `- ring: ${ringLine}`,
    '',
    '**Assets**',
    ...assetsLines,
    '',
    '**Autoclaim**',
    ...autoclaimLines,
    '',
    `**Timeouts**: ${timeoutsLine}`,
    '',
    '**Secrets** (shown as `env:NAME` / `file:PATH`, never resolved):',
    '```json',
    JSON.stringify(redacted.users ?? {}, null, 2),
    '```'
  ].join('\n');
};

const renderThroughput = (results: ResultsJson): string => {
  const identityOk = checkThroughputIdentity(results.achieved);
  // R29 (loadtest/REVIEW.md): `ticksOffered` is *defined* as the sum of the
  // other three terms, so it can never disagree with them — it cannot
  // reveal demand the token bucket silently dropped. `ticksExpected` is
  // computed independently, from the config alone; a gap beyond ordinary
  // ramp rounding means the tool never even OFFERED the requested load.
  const gap = results.achieved.ticksOffered - results.achieved.ticksExpected;
  const rows = [
    ['users (requested)', String(results.requested.users), '-'],
    ['browser users (requested)', String(results.requested.browser), '-'],
    ['rate per user/min (requested)', String(results.requested.ratePerUserPerMin), '-'],
    ['duration minutes (requested)', String(results.requested.minutes), '-'],
    [
      'ticksExpected',
      String(results.achieved.ticksExpected),
      'INDEPENDENT: users x rate x minutes, from config alone (R29)'
    ],
    [
      'ticksOffered',
      String(results.achieved.ticksOffered),
      'lap-start opportunities, all users (= lapStartsSubmitted + skippedBackpressure + ticksLostToRamp, by construction)'
    ],
    [
      'lapStartsSubmitted',
      String(results.achieved.lapStartsSubmitted),
      'same unit as ticksOffered/rate (requested)'
    ],
    ['skippedBackpressure', String(results.achieved.skippedBackpressure), '-'],
    ['ticksLostToRamp', String(results.achieved.ticksLostToRamp), '-'],
    [
      'hopBridgesSubmitted',
      String(results.achieved.hopBridgesSubmitted),
      'informational only — per-HOP bridge sends, not part of the identity'
    ],
    [
      'steadyStateRatePerUserPerMin (achieved)',
      results.achieved.steadyStateRatePerUserPerMin.toFixed(4),
      'same unit as rate per user/min (requested); divides by ELAPSED duration when known (R8), else requested'
    ]
  ];
  // A10 (VALIDATION-1.md): the blended rate above can hide two modes
  // behaving completely differently — reported per mode, never averaged.
  const byMode = results.achieved.steadyStateRatePerUserPerModeMin;
  const modeRows = [
    ['browser', results.requested.browser, byMode.browser],
    ['headless', results.requested.users - results.requested.browser, byMode.headless]
  ].map(([mode, users, rate]) => [
    String(mode),
    String(users),
    rate === null ? 'n/a (0 users)' : (rate as number).toFixed(4)
  ]);
  return [
    mdTable(['metric', 'value', 'note'], rows),
    '',
    `Identity check (\`ticksOffered = lapStartsSubmitted + skippedBackpressure + ticksLostToRamp\`): **${
      identityOk ? 'OK' : 'MISMATCH'
    }**`,
    '',
    `ticksOffered vs ticksExpected (\`ticksOffered - ticksExpected\`): **${gap}**${
      gap === 0
        ? ''
        : ' — a non-zero gap here means the scheduler never even offered some of the requested load (beyond ordinary ramp-up rounding); it is invisible to the identity check above, which is why this term exists (R29).'
    }`,
    '',
    '**Achieved rate per mode (A10, VALIDATION-1.md)** — the blended figure above can average two modes behaving completely differently; never quote it as "what a real user experiences" without checking this table too:',
    '',
    mdTable(['mode', 'users (requested)', 'steadyStateRatePerUserPerMin (achieved)'], modeRows),
    '',
    renderLapReliabilityByMode(results)
  ].join('\n');
};

/**
 * S27 (plans/bridge-loadtest-plan.md §7): extends the A10 table directly
 * above (which answers "how often does a mode START a lap") with the
 * question A10 does NOT answer: "of the laps a mode started, how many
 * actually FINISHED". This is the exact number the pre-S25 browser
 * regression hid — A10's achieved-rate figure can look unremarkable even
 * while `completionRate` has collapsed toward 0, because a fast-failing lap
 * still counts as an attempted lap-start.
 */
const renderLapReliabilityByMode = (results: ResultsJson): string => {
  const rows = (['browser', 'headless'] as const).map((mode) => {
    const r = results.laps.byMode[mode];
    return [
      mode,
      String(r.attempted),
      String(r.completed),
      r.completionRate === null ? 'n/a (0 attempted)' : `${(r.completionRate * 100).toFixed(1)}%`
    ];
  });
  return [
    "**Per-mode lap reliability — attempted vs completed (S27, plans/bridge-loadtest-plan.md §7)** — `attempted` is every lap that reached a final outcome (`LAP_DONE`/`LAP_FAILED`/`LAP_ABORTED`), `completed` is `LAP_DONE` only. This is the gate `tests/loadtest-e2e/run.spec.ts` enforces per mode so a mode collapsing toward 0% completion (browser: 1 of ~58 laps before S25's fix) fails CI instead of hiding behind the other mode's healthy aggregate:",
    '',
    mdTable(['mode', 'attempted', 'completed', 'completionRate'], rows)
  ].join('\n');
};

const renderHopOutcomes = (results: ResultsJson): string => {
  const routes = Object.keys(results.hops.byRoute).sort();
  const outcomeSet = new Set<string>();
  Object.keys(results.hops.byOutcome).forEach((o) => outcomeSet.add(o));
  routes.forEach((route) =>
    Object.keys(results.hops.byRoute[route].byOutcome).forEach((o) => outcomeSet.add(o))
  );
  const outcomes = [...outcomeSet].sort();

  if (outcomes.length === 0) return 'No hops recorded.';

  const rows = routes.map((route) => {
    const byOutcome = results.hops.byRoute[route].byOutcome;
    return [route, ...outcomes.map((o) => String(byOutcome[o] ?? 0))];
  });
  rows.push(['**all routes**', ...outcomes.map((o) => String(results.hops.byOutcome[o] ?? 0))]);

  return mdTable(['route', ...outcomes], rows);
};

const isModeSplit = (value: unknown): value is ModeSplitStats<Stats> =>
  typeof value === 'object' && value !== null && ('browser' in value || 'headless' in value);

// S16/A5 (VALIDATION-1.md): a report that can invalidate its own numbers is
// the only honest version of this measurement. 100 users sharing one Node
// event loop (`toolCpuPct` p50 101.4%, max 129.8% on a 64-core host)
// measured headless `tracker/activity` p50 5316ms against p50 1ms for the
// SAME endpoint in-browser in the SAME run — the difference is queueing
// delay on a saturated loop, not proxy latency. 100ms is a conservative
// "the loop is measurably backed up" threshold (well above ordinary GC/
// microtask jitter, far below the multi-second delay that actually
// contaminated that run) — not calibrated against a specific run, since
// this is the first run this measurement exists for; S17 may tighten it
// once it has real event-loop-lag data alongside real latency numbers.
const EVENT_LOOP_LAG_DISQUALIFY_THRESHOLD_MS = 100;

const worstEventLoopDelayP99Ms = (results: ResultsJson): number | null => {
  const values = results.resources.samples
    .map((sample) => sample.eventLoopDelayP99Ms)
    .filter((value): value is number => typeof value === 'number');
  return values.length === 0 ? null : Math.max(...values);
};

/**
 * Returns a caution banner to prepend to a latency-percentile section when
 * this run's own event loop was too backed up to trust those percentiles as
 * server/proxy latency — '' when the run recorded no event-loop-delay
 * samples (an older `results.json`, or a caller that never sampled it) or
 * every sample stayed under the threshold.
 */
const latencyDisqualificationNote = (results: ResultsJson): string => {
  const worstMs = worstEventLoopDelayP99Ms(results);
  if (worstMs === null || worstMs < EVENT_LOOP_LAG_DISQUALIFY_THRESHOLD_MS) return '';
  return (
    `> **Not usable as server/proxy latency (S16/A5).** This run's own event loop reached a p99 ` +
    `delay of ${worstMs.toFixed(1)}ms (threshold ${EVENT_LOOP_LAG_DISQUALIFY_THRESHOLD_MS}ms) — see ` +
    `the Resources section's \`eventLoopDelayP99Ms\`. The percentiles below include time spent waiting ` +
    `for a saturated loop to schedule a resolved promise's continuation, not just real request/response ` +
    `time (VALIDATION-1.md A5: one run measured headless \`tracker/activity\` p50 5316ms against p50 1ms ` +
    `for the same endpoint measured in-browser in the same run). Shard users across processes or reduce ` +
    `headless users per invocation and re-run before quoting these numbers as latency.\n`
  );
};

const renderPhaseLatencies = (results: ResultsJson): string => {
  const phases = results.phases as Record<string, ModeSplitStats<Stats>>;
  const censoredCounts = results.phaseCensoredCounts;
  const names = new Set<string>(Object.keys(phases));
  Object.keys(censoredCounts).forEach((name) => names.add(name));
  const sortedNames = [...names].sort();
  if (sortedNames.length === 0) return 'No phase samples recorded.';
  const anyCensored = Object.values(censoredCounts).some((count) => (count ?? 0) > 0);
  const rows = sortedNames.map((name) => {
    const entry = phases[name];
    const browser = isModeSplit(entry) ? entry.browser : null;
    const headless = isModeSplit(entry) ? entry.headless : null;
    const censored = censoredCounts[name] ?? 0;
    return [name, fmtStats(browser), fmtStats(headless), String(censored)];
  });
  // R2 (loadtest/REVIEW.md): a phase that times out contributes NO sample
  // to the percentiles above (they are computed over real completions
  // only, same as `hop_total`'s pre-existing note N5 rule) — `timedOut`
  // discloses how many MORE hops entered that phase and never finished it,
  // so a reader comparing this column against the percentiles can see the
  // tail that was excluded instead of it silently vanishing.
  const censorNote = anyCensored
    ? '> **Note (R2):** the `timedOut` column counts hops that entered a phase and TIMED OUT rather than completing it. Those samples are excluded from the percentiles to their left (a duration capped at the configured timeout is not a latency measurement) — a phase with a high `timedOut` count relative to its `n` has percentiles that describe only the hops that succeeded, not the whole population that attempted it.\n\n'
    : '';
  return (
    latencyDisqualificationNote(results) +
    censorNote +
    mdTable(['phase', 'browser', 'headless', 'timedOut'], rows)
  );
};

const describeHttpStats = (stats: HttpStats | null): string =>
  stats === null
    ? 'n/a'
    : `${fmtStats(stats)} retries=${stats.retries} status=${JSON.stringify(stats.byStatus)}`;

/**
 * S24 / DESIGN §9.3 finding C16: `tracker/activity` is the single
 * highest-volume endpoint class in the whole test, and the ONLY class where
 * browser mode's own control-flow poll (`origin: 'harness'`) runs alongside
 * real UI traffic (`origin: 'ui'`) to the exact same URL — so it gets a
 * dedicated headline callout ahead of the full per-class table below,
 * exactly as the plan requires: "the UI-originated figure as the
 * headline... The harness-originated figure must still be visible, not
 * hidden." Returns '' (nothing rendered) when the run recorded no
 * `tracker/activity` samples at all.
 */
const renderTrackerActivityHeadline = (results: ResultsJson): string => {
  const entry = results.http['tracker/activity'];
  if (entry === undefined) return '';
  return [
    '**Headline — `tracker/activity` origin split (DESIGN §9.3 C16):** the ' +
      "`ui` row is what a real user's browser (or, in headless mode, the " +
      "worker's single poll loop standing in for one) actually generates — " +
      'this is the number that answers "what load would real users create?" ' +
      "The `harness` row is browser mode's own control-flow poll and is " +
      '**not** real user traffic; it is shown, not hidden.',
    '',
    mdTable(
      ['origin', 'browser', 'headless'],
      [
        [
          'ui (headline)',
          describeHttpStats(entry.browser.ui),
          describeHttpStats(entry.headless.ui)
        ],
        [
          'harness',
          describeHttpStats(entry.browser.harness),
          describeHttpStats(entry.headless.harness)
        ]
      ]
    )
  ].join('\n');
};

const renderEndpointLatencies = (results: ResultsJson): string => {
  const classes = Object.keys(results.http).sort();
  if (classes.length === 0) return 'No HTTP samples recorded.';
  const rows = classes.map((endpointClass) => {
    const entry = results.http[endpointClass];
    return [
      endpointClass,
      describeHttpStats(entry.browser.ui),
      describeHttpStats(entry.browser.harness),
      describeHttpStats(entry.headless.ui),
      describeHttpStats(entry.headless.harness)
    ];
  });
  const table = mdTable(
    ['endpointClass', 'browser (ui)', 'browser (harness)', 'headless (ui)', 'headless (harness)'],
    rows
  );
  const headline = renderTrackerActivityHeadline(results);
  const body = headline === '' ? table : `${headline}\n\n${table}`;
  // R11 (loadtest/REVIEW.md): a request outside a `runWithFetchContext`
  // scope is performed but was previously invisible in this table — a
  // non-zero count here means the endpoint tables above are an
  // undisclosed lower bound of exactly this size.
  const uncontextedNote =
    results.uncontextedRequests > 0
      ? `\n\n> **Note (R11):** ${results.uncontextedRequests} request(s) were made outside a tracked fetch context and are NOT included in the table above — the endpoint counts are a lower bound by exactly this many requests.`
      : '';
  return latencyDisqualificationNote(results) + body + uncontextedNote;
};

const renderGateStalls = (results: ResultsJson): string => {
  const gates = Object.entries(results.gates) as [string, GateStats][];
  if (gates.length === 0) return 'No gate visits recorded.';
  gates.sort((a, b) => b[1].totalMs - a[1].totalMs);
  const rows = gates.map(([gate, stats]) => [
    gate,
    String(stats.hopsEntered),
    String(stats.totalMs),
    String(stats.p50),
    String(stats.p90),
    String(stats.p99),
    String(stats.blockedTicks),
    String(stats.timedOutVisits)
  ]);
  const anyTimedOut = gates.some(([, stats]) => stats.timedOutVisits > 0);
  // R6 (loadtest/REVIEW.md): unlike phases (R2), a gate visit's percentiles
  // ARE computed over every visit including timed-out ones (they always
  // were — a timed-out visit still closes the gate, `core/ring.ts`'s
  // `finish()` always calls `exitGate`). A visit that ended at the
  // configured timeout has a duration ≈ that timeout, so a p90/p99 sitting
  // at the budget is a CENSORING signal, not a latency measurement —
  // `timedOutVisits` is what makes that reading possible instead of a
  // reader mistaking the timeout value itself for a measured stall.
  const note = anyTimedOut
    ? "> **Note (R6):** `timedOutVisits` counts how many of `hopsEntered`'s visits ended at the configured timeout rather than a real resolution. A p50/p90/p99 at or near the timeout budget for a gate with a high `timedOutVisits` count is that budget, not a measured stall — do not raise the corresponding timeout from this number alone.\n\n"
    : '';
  return (
    note +
    mdTable(
      ['gate', 'hopsEntered', 'totalMs', 'p50', 'p90', 'p99', 'blockedTicks', 'timedOutVisits'],
      rows
    )
  );
};

const renderAutoclaimPolicy = (results: ResultsJson): string =>
  mdTable(
    ['counter', 'count'],
    [
      ['autoclaimOverdue', String(results.policy.autoclaimOverdue)],
      ['unexpectedAutoclaim', String(results.policy.unexpectedAutoclaim)],
      ['claimRaceLost', String(results.policy.claimRaceLost)]
    ]
  );

const renderErrors = (results: ResultsJson): string => {
  const { notReady, benignExternalAsset } = results.errors.suppressed;
  const suppressedTotal = notReady + benignExternalAsset;

  const byClass = Object.entries(results.errors.byClass) as [string, number][];
  const byClassTable =
    byClass.length === 0
      ? // R7 (loadtest/REVIEW.md): "No errors recorded." used to print here
        // even when `activity.ndjson` held a non-empty log of SUPPRESSED
        // errors (DESIGN §5.3's `not_ready`; S11 defect (3)'s benign-asset
        // `console_error` noise) — this now says which is true.
        suppressedTotal === 0
        ? 'No errors recorded.'
        : `No non-suppressed errors recorded (${suppressedTotal} suppressed — see below).`
      : mdTable(
          ['class', 'count'],
          byClass.map(([k, v]) => [k, String(v)])
        );

  const top = results.errors.top;
  const topTable =
    top.length === 0
      ? suppressedTotal === 0
        ? 'No errors recorded.'
        : `No non-suppressed errors recorded (${suppressedTotal} suppressed — see below).`
      : mdTable(
          ['class', 'count', 'firstSeen', 'lastSeen', 'endpointClass', 'sample'],
          top.map((e) => [
            e.class,
            String(e.count),
            e.firstSeen,
            e.lastSeen,
            e.endpointClass ?? '-',
            e.sample
          ])
        );

  const suppressedTable = mdTable(
    ['class', 'count', 'policy'],
    [
      [
        'not_ready',
        String(notReady),
        'DESIGN §5.3: a readiness gate, not an error — counted as a gate stall instead'
      ],
      [
        'console_error (benign external asset)',
        String(benignExternalAsset),
        'S11 defect (3): known-benign external asset-host noise (favicon/chain-icon fetches), unrelated to aggkit-proxy'
      ]
    ]
  );

  return [
    '**By class**',
    '',
    byClassTable,
    '',
    '**Top 10**',
    '',
    topTable,
    '',
    '**Suppressed (correct policy, not silently uncounted — R7)**',
    '',
    suppressedTable
  ].join('\n');
};

const renderResources = (results: ResultsJson): string => {
  const samples = results.resources.samples;
  if (samples.length === 0) return 'No resource samples recorded.';
  const rssValues = samples.map((s) => s.toolRssMb);
  const cpuValues = samples.map((s) => s.toolCpuPct);
  const peakRss = Math.max(...rssValues);
  const meanRss = rssValues.reduce((a, b) => a + b, 0) / rssValues.length;
  const peakCpu = Math.max(...cpuValues);
  const meanCpu = cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length;
  // S16/A5: undefined for a `results.json` from before this field existed,
  // or if `runner.ts` never sampled it — never fold a missing sample into
  // the peak/mean as a false zero.
  const eventLoopValues = samples
    .map((s) => s.eventLoopDelayP99Ms)
    .filter((value): value is number => typeof value === 'number');
  const eventLoopRow: string[][] =
    eventLoopValues.length === 0
      ? []
      : [
          [
            'eventLoopDelayP99Ms',
            Math.max(...eventLoopValues).toFixed(1),
            (eventLoopValues.reduce((a, b) => a + b, 0) / eventLoopValues.length).toFixed(1)
          ]
        ];

  const browserProcessRows = samples.flatMap((sample, sampleIndex) =>
    sample.browserProcesses.map((proc) => [
      String(sampleIndex),
      String(proc.pid),
      String(proc.rssMb)
    ])
  );

  return [
    mdTable(
      ['metric', 'peak', 'mean'],
      [
        ['toolRssMb', String(peakRss), meanRss.toFixed(1)],
        ['toolCpuPct', String(peakCpu), meanCpu.toFixed(1)],
        ...eventLoopRow
      ]
    ),
    '',
    '**Per-browser-process RSS**',
    '',
    browserProcessRows.length === 0
      ? 'No browser process samples recorded.'
      : mdTable(['sampleIndex', 'pid', 'rssMb'], browserProcessRows)
  ].join('\n');
};

const renderEnvironment = (results: ResultsJson): string =>
  mdTable(
    ['field', 'value'],
    [
      ['toolVersion', String(results.run.toolVersion ?? 'unknown')],
      ['sdkVersion', String(results.run.sdkVersion ?? 'unknown')],
      ['host.cores', String(results.run.host?.cores ?? 'unknown')],
      ['host.totalMemMb', String(results.run.host?.totalMemMb ?? 'unknown')],
      ['host.platform', String(results.run.host?.platform ?? 'unknown')]
    ]
  );

export const renderSummaryMd = (results: ResultsJson, config: LoadtestConfig): string => {
  // S11 retry defect (2): `aborted` now means ABNORMAL termination only
  // (SIGINT / fatal) — a run that served its full `--minutes` and drained
  // normally reads as `PASS`, optionally noting how many laps were still
  // in flight at the moment drain began.
  const statusLine = results.run.aborted
    ? `ABORTED (${results.run.abortCause ?? 'unknown cause'})`
    : results.run.lapsInFlightAtStop > 0
      ? `PASS (drained ${results.run.lapsInFlightAtStop} in-flight lap${results.run.lapsInFlightAtStop === 1 ? '' : 's'})`
      : 'PASS';
  // DESIGN §6.3 item 1: "one line stating pass/abort, users, rate,
  // duration" — the heading line ITSELF, not a separate line below it, so
  // §5.5 invariant 4 ("summary.md's first line") is literally satisfied.
  const header = `# Bridge load test — ${results.run.startedAt ?? 'unknown-start'} — ${statusLine} — users=${results.requested.users}, rate=${results.requested.ratePerUserPerMin}/user/min, duration=${results.requested.minutes}min`;

  const sections = [
    header,
    ['## Configuration', renderConfiguration(config)].join('\n\n'),
    ['## Throughput', renderThroughput(results)].join('\n\n'),
    ['## Hop outcomes', renderHopOutcomes(results)].join('\n\n'),
    ['## Phase latencies', renderPhaseLatencies(results)].join('\n\n'),
    ['## Endpoint latencies', renderEndpointLatencies(results)].join('\n\n'),
    ['## Gate stalls', renderGateStalls(results)].join('\n\n'),
    ['## Autoclaim policy', renderAutoclaimPolicy(results)].join('\n\n'),
    ['## Errors', renderErrors(results)].join('\n\n'),
    ['## Resources', renderResources(results)].join('\n\n'),
    ['## Environment', renderEnvironment(results)].join('\n\n')
  ];

  return `${sections.join('\n\n')}\n`;
};

// ---------------------------------------------------------------------------
// Disk I/O — thin wrapper so `buildResultsJson`/`renderSummaryMd` stay
// pure and testable without touching the filesystem.
// ---------------------------------------------------------------------------

export const writeReportFiles = (params: {
  dir: string;
  snapshot: CollectorSnapshot;
  config: LoadtestConfig;
}): { resultsPath: string; summaryPath: string; results: ResultsJson; summaryMd: string } => {
  const results = buildResultsJson({ snapshot: params.snapshot, config: params.config });
  const summaryMd = renderSummaryMd(results, params.config);

  fs.mkdirSync(params.dir, { recursive: true });
  const resultsPath = path.join(params.dir, 'results.json');
  const summaryPath = path.join(params.dir, 'summary.md');
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(summaryPath, summaryMd);

  return { resultsPath, summaryPath, results, summaryMd };
};

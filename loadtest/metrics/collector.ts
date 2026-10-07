// The metrics collector — DESIGN §5 (phase timers §5.1, HTTP samples §5.2,
// gate-stall accounting §5.4, honesty invariants §5.5) and the machine half
// of §6 (this module is the single writer of `activity.ndjson`, §6.2; its
// `snapshot()` is what `report.ts` renders into `results.json`, §6.1).
//
// This is the ONE place S08 (headless worker), S10 (browser worker) and S11
// (runner) all call into to report what happened — every method here is
// part of that shared contract, so its signatures are treated as frozen
// once other steps depend on them.
//
// Deliberately NOT in `loadtest/core/`: it performs I/O (the ndjson sink)
// and imports `wallets/redact.ts`. `core/ring.ts` and `core/scheduler.ts`
// never import this file — they emit pure `RingEmission`/`SchedulerDecision`
// values that a caller (S11) translates into calls here, enriched with the
// context (`mode`, `hopRoute`, `assetKind`) the pure core doesn't carry.
//
// Percentile method: nearest-rank on the sorted sample array,
// `index = ceil(p * n) - 1`, clamped to `[0, n-1]`. For `n = 1` every
// percentile equals the single sample (DESIGN §5.5 invariant 5). A key with
// zero samples is never emitted (DESIGN §5.5 invariant 5) — `computeStats`
// returns `null` and every aggregator below omits the key rather than
// filling in zeros, which would misreport an all-failures phase (DESIGN
// §5.1: `hop_total`/`lap_total` — mirroring `core/ring.ts` note N5 — and any
// other phase are recorded ONLY on the success path that reaches them, so a
// phase with zero occurrences is honestly "no data", not "0ms").

import fs from 'node:fs';

import type { AbortCause } from '../core/scheduler';
import type {
  AssetKind,
  ErrorClass,
  Gate,
  HopCounter,
  Outcome,
  Phase,
  TransitionId
} from '../core/types';
import type { DriverMode } from '../core/userDriver';

import { redactSecrets } from '../wallets/redact';
import { isBenignExternalAssetHost } from './errors';

// ---------------------------------------------------------------------------
// Percentile math
// ---------------------------------------------------------------------------

export interface Stats {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/** DESIGN §5.5 invariant 5: never called by an aggregator on an empty sample set — returns `null` instead of a zero-filled `Stats`. */
export const computeStats = (samples: readonly number[]): Stats | null => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  };
  return {
    n: sorted.length,
    p50: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]
  };
};

// ---------------------------------------------------------------------------
// activity.ndjson sink — swappable so tests never touch the filesystem.
// ---------------------------------------------------------------------------

export interface ActivitySink {
  write(line: string): void;
  close?(): void;
}

/** Append-only, flushed per line (DESIGN §6.2: "so a killed process still leaves a usable log") — one `fs.writeSync` per line, no buffered stream. */
export const createFileActivitySink = (path: string): ActivitySink => {
  const fd = fs.openSync(path, 'a');
  return {
    write(line) {
      fs.writeSync(fd, `${line}\n`);
    },
    close() {
      fs.closeSync(fd);
    }
  };
};

export interface MemoryActivitySink extends ActivitySink {
  readonly lines: readonly string[];
}

/** Test-only sink: captures lines in memory instead of writing a file. */
export const createMemoryActivitySink = (): MemoryActivitySink => {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    }
  };
};

// ---------------------------------------------------------------------------
// Public input / snapshot shapes
// ---------------------------------------------------------------------------

export interface HostInfo {
  cores: number;
  totalMemMb: number;
  platform: string;
}

export interface RunInfo {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  // S11 retry defect (2): reserved for ABNORMAL termination (SIGINT, a
  // fatal error) — never set for a run that served its full requested
  // `--minutes` and then drained normally (`abortCause: 'duration_elapsed'`
  // is NOT abnormal; see `runLoadTest`'s `runEnd` call).
  aborted: boolean;
  abortCause: AbortCause | null;
  // How many laps were still `LAP_RUNNING` at the instant drain began
  // (0 if nothing was in flight, e.g. a normal run with a short
  // `--minutes` against long hop timeouts). Populated regardless of
  // `aborted`, so a passing run can still note "drained N in-flight laps".
  lapsInFlightAtStop: number;
  toolVersion: string | null;
  sdkVersion: string | null;
  host: HostInfo | null;
}

export interface PhaseInput {
  phase: Phase;
  mode: DriverMode;
  hopRoute: string;
  assetKind: AssetKind;
  durationMs: number;
  // R2 (loadtest/REVIEW.md): true for a sample recorded on a TIMEOUT path
  // (`core/ring.ts`'s `recordCensoredTimeoutPhase`) — kept OUT of the
  // percentile arrays (a duration bounded by the configured timeout is not
  // a latency measurement) but counted separately so
  // `metrics/report.ts` can disclose how many hops entered a phase and
  // never finished it, instead of the timed-out tail silently vanishing.
  censored?: boolean;
}

// S24 / DESIGN §9.3 finding C16: which side actually generated this
// request. `'ui'` = traffic the app itself would generate (the real
// browser's own background polling, or — in headless mode — the worker's
// single poll loop, which per DESIGN §9.4 literally IS the P1 replay, so
// headless has no `'harness'` component at all). `'harness'` = traffic the
// DRIVER generated purely for its own control flow (browser mode's
// `observeActivity()`/`readState()` poll, and the browser driver's Node-side
// bookkeeping calls — wrapped-token-address resolution, the bridge tx's own
// receipt fetch — none of which the real UI ever issues). Defaults to
// `'ui'` (see `recordHttpSample` below) so every pre-existing call site
// that never mentions origin keeps reporting real UI-shaped load.
export type HttpOrigin = 'ui' | 'harness';

export interface HttpSampleInput {
  userId: string;
  mode: DriverMode;
  endpointClass: string;
  method: string;
  status: number;
  durationMs: number;
  // DESIGN §5.2 / §9.5: > 0 marks an SDK-internal retry (`fetchRawText`
  // retries a transport failure up to 3x). Carried through so retries are
  // visible instead of silently inflating the apparent request count.
  attempt: number;
  /** S24: see `HttpOrigin` doc above. Optional, defaults to `'ui'`. */
  origin?: HttpOrigin;
}

export interface GateVisitInput {
  gate: Gate;
  durationMs: number;
  // R6 (loadtest/REVIEW.md): true when this visit closed BECAUSE its phase
  // timed out — its duration is ≈ the configured timeout, a censoring
  // signal rather than a real stall measurement. Optional/defaults to
  // `false` so an existing caller that never set it keeps reporting exactly
  // as it did before (every visit read as a real resolution).
  timedOut?: boolean;
}

export interface ErrorInput {
  userId: string;
  mode: DriverMode;
  errorClass: ErrorClass;
  message: string;
  endpointClass?: string;
  hopId?: string;
}

export interface HopEndInput {
  userId: string;
  mode: DriverMode;
  hopId: string;
  lapId: string;
  hopRoute: string;
  outcome: Outcome;
}

export type LapOutcome = 'LAP_DONE' | 'LAP_FAILED' | 'LAP_ABORTED';

export interface LapEndInput {
  userId: string;
  mode: DriverMode;
  lapId: string;
  outcome: LapOutcome;
}

export interface ResourceSampleInput {
  toolRssMb: number;
  toolCpuPct: number;
  browserProcesses: readonly { pid: number; rssMb: number }[];
  // S16/A5 (VALIDATION-1.md): `perf_hooks.monitorEventLoopDelay`'s p99, in
  // ms, over the interval since the previous sample. Optional so every
  // existing caller/test that builds a `ResourceSampleInput` without it
  // keeps compiling — `runner.ts` is the only real producer and always
  // supplies it. This is the measurement `metrics/report.ts` uses to
  // self-disqualify its own latency percentiles when the tool's own event
  // loop was too backed up to trust them as server/proxy latency (A5's
  // root cause: 100 users sharing one Node event loop, `toolCpuPct` p50
  // 101.4%, invalidating that run's headless HTTP percentiles).
  eventLoopDelayP99Ms?: number;
}

export interface HopStateInput {
  userId: string;
  mode: DriverMode;
  hopId: string;
  lapId: string;
  from: string;
  to: string;
  transition: TransitionId;
}

export interface TxEventInput {
  userId: string;
  mode: DriverMode;
  hopId: string;
  step: 'approve' | 'bridge' | 'claim';
  txHash: string;
}

export interface TxReceiptInput {
  userId: string;
  mode: DriverMode;
  hopId: string;
  step: 'approve' | 'bridge' | 'claim';
  status: 'success' | 'reverted';
}

export interface ActivityRowInput {
  userId: string;
  mode: DriverMode;
  hopId: string;
  hash: string;
  status: string;
  trackingStep?: string;
}

export interface ClaimAttemptInput {
  userId: string;
  mode: DriverMode;
  hopId: string;
  claimable: boolean;
  reason?: string;
}

export interface SchedulerCountersInput {
  ticksOffered: number;
  skippedBackpressure: number;
  ticksLostToRamp: number;
  // R29 (loadtest/REVIEW.md): an independent fourth term — see
  // `core/scheduler.ts`'s `SchedulerCounters.ticksExpected` doc. Optional
  // (defaults to 0) so a test/caller that predates this field is unaffected.
  ticksExpected?: number;
}

export interface ModeSplitStats<T> {
  browser: T | null;
  headless: T | null;
}

export interface HttpStats extends Stats {
  byStatus: Record<string, number>;
  // Not in the DESIGN §6.1 jsonc example verbatim, but required by §5.2's
  // "attempt > 0 ... so retries are visible instead of inflating the
  // apparent request count silently" — the count of samples with
  // `attempt > 0` for this (endpointClass, mode).
  retries: number;
}

/**
 * S24 / DESIGN §9.3 finding C16: the origin-axis counterpart of
 * `ModeSplitStats` — `null` (not a zero-filled `HttpStats`) when that origin
 * had no samples, per the same DESIGN §5.5 invariant 5 `computeStats`
 * already follows. `ui` is the headline (real UI-shaped load); `harness` is
 * reported alongside, never hidden, but is not real user traffic.
 */
export interface OriginSplitStats<T> {
  ui: T | null;
  harness: T | null;
}

/**
 * S24: the HTTP-specific mode split. Deliberately NOT `ModeSplitStats<T>`
 * (which types `browser`/`headless` themselves as `T | null` — the "no
 * samples for this whole mode" case `phases`/`gates` use): every
 * `endpointClass` bucket always HAS a `browser` and a `headless`
 * `OriginSplitStats` object (constructed unconditionally in `snapshot()`
 * below) — it is the `ui`/`harness` fields INSIDE each that are nullable
 * when that origin had no samples. Reusing `ModeSplitStats<T>` here would
 * make `browser`/`headless` themselves nullable for a shape that, in
 * practice, never is.
 */
export interface HttpModeSplit<T> {
  browser: OriginSplitStats<T>;
  headless: OriginSplitStats<T>;
}

export interface GateStats {
  hopsEntered: number;
  totalMs: number;
  p50: number;
  p90: number;
  p99: number;
  blockedTicks: number;
  // R6 (loadtest/REVIEW.md): how many of `hopsEntered`'s visits ended at
  // the configured timeout rather than a real resolution — the p50/p90/p99
  // above are computed over ALL visits including these (unlike phases,
  // R2), so this is the number that makes a percentile piled up at the
  // timeout budget interpretable instead of read as a latency measurement.
  timedOutVisits: number;
}

export interface ErrorTopEntry {
  class: ErrorClass;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sample: string;
  endpointClass?: string;
}

export interface CollectorSnapshot {
  run: RunInfo;
  phases: Partial<Record<Phase, ModeSplitStats<Stats>>>;
  // R2 (loadtest/REVIEW.md): how many CENSORED samples (a phase that timed
  // out rather than completed — `core/ring.ts`'s `recordCensoredTimeoutPhase`)
  // were recorded per phase, GLOBAL only (not split by route/mode — kept
  // simple since this is a disclosure count, not a measurement). These are
  // NOT included in `phases` above, so `phases[x].n` stays a real-latency
  // sample count; `phaseCensoredCounts[x]` is how many MORE hops entered
  // that phase and never finished it.
  phaseCensoredCounts: Partial<Record<Phase, number>>;
  // R11 (loadtest/REVIEW.md): count of fetches made OUTSIDE a
  // `runWithFetchContext` scope — the endpoint tables in `http` above are
  // a lower bound of exactly this tightness (0 = tables are complete).
  uncontextedRequests: number;
  hopsByOutcome: Partial<Record<Outcome, number>>;
  hopsByRoute: Record<
    string,
    {
      byOutcome: Partial<Record<Outcome, number>>;
      // S30 (plans/bridge-loadtest-plan.md §7/§8): the same per-route
      // outcome counts as `byOutcome` above, split further by `DriverMode`
      // — the dimension S27's per-mode LAP gate could not see (a specific
      // hop degrading in exactly one mode, e.g. S26/S29's headless-only
      // `rpc_error`s on `L2B->L1`, was invisible in the mode-blind
      // `byOutcome` aggregate). Mirrors `lapsByOutcomeByMode`'s per-mode
      // split of `lapsByOutcome`, one dimension further (route AND mode
      // instead of just mode).
      byOutcomeByMode: Record<DriverMode, Partial<Record<Outcome, number>>>;
      phases: Partial<Record<Phase, ModeSplitStats<Stats>>>;
    }
  >;
  lapsByOutcome: Record<LapOutcome, number>;
  // S27 (plans/bridge-loadtest-plan.md §7): the same counts as
  // `lapsByOutcome` above, split by `DriverMode`. This is what lets
  // `metrics/report.ts` compute an "attempted vs completed" figure PER
  // MODE — `attempted` is the sum of a mode's three outcome counts (every
  // lap that reached `lapEnd`, i.e. every `tick()` that didn't stay
  // in-flight at run end), `completed` is its `LAP_DONE` count. Added
  // because the pre-S27 suite only asserted `laps.byOutcome.LAP_DONE >= 1`
  // in aggregate — a mode collapsing to near-zero completion (browser: 1 of
  // ~58 laps, pre-S25) was invisible as long as the OTHER mode kept the
  // aggregate above zero. See run.spec.ts's per-mode threshold assertions.
  lapsByOutcomeByMode: Record<DriverMode, Record<LapOutcome, number>>;
  // S24: each mode's samples are further split by `HttpOrigin` — see
  // `OriginSplitStats` doc above.
  http: Record<string, HttpModeSplit<HttpStats>>;
  gates: Partial<Record<Gate, GateStats>>;
  errors: {
    byClass: Partial<Record<ErrorClass, number>>;
    top: ErrorTopEntry[];
    // R7 (loadtest/REVIEW.md): `error()` deliberately suppresses two
    // classes from `byClass`/`top` (DESIGN §5.3 `not_ready`; S11 defect (3)
    // benign external-asset `console_error` noise) — correct policy, but
    // neither used to be counted ANYWHERE, so a run whose only errors were
    // suppressed rendered "No errors recorded." over a non-empty
    // `activity.ndjson`. Both raw lines are still written to
    // `activity.ndjson` regardless (unaffected by this).
    suppressed: { notReady: number; benignExternalAsset: number };
  };
  policy: { autoclaimOverdue: number; unexpectedAutoclaim: number; claimRaceLost: number };
  scheduler: {
    ticksOffered: number;
    skippedBackpressure: number;
    ticksLostToRamp: number;
    // R29 (loadtest/REVIEW.md): see `core/scheduler.ts`'s
    // `SchedulerCounters.ticksExpected` doc — an INDEPENDENT term
    // (`users x rate x minutes`, from config alone) so a gap between it
    // and `ticksOffered` reveals demand the token bucket never offered,
    // which `ticksOffered`'s own tautological definition cannot.
    ticksExpected: number;
    // S11 retry defect (1): `ticksOffered`/`skippedBackpressure`/
    // `ticksLostToRamp` above are all counted in SCHEDULER-TICK units (one
    // per lap-start opportunity — `core/scheduler.ts`'s own
    // `ticksOffered = ticksIssued + skippedBackpressure + ticksLostToRamp`
    // identity is true by construction). `lapStartsSubmitted` is this
    // collector's OWN independent count of the same event — incremented by
    // `tick()`, called by the runner exactly once per `start_lap` decision
    // the scheduler actually issues (never for a `skipped_backpressure`
    // one) — so DESIGN §5.5 invariant 1's identity
    // (`ticksOffered = lapStartsSubmitted + skippedBackpressure +
    // ticksLostToRamp`) is a genuine cross-check between two independently
    // derived counters of the SAME unit, not two counters of DIFFERENT
    // units (attempt #1's bug: it compared tick-count fields against
    // `bridgesSubmitted`, a HOP-level count that is 1-per-hop, i.e.
    // `ring.length - 1` per lap — those can never satisfy the identity and
    // are not the number `--rate` requests). `steadyStateRatePerUserPerMin`
    // is derived from `lapStartsSubmittedSteady`, the SAME unit `--rate`
    // requests (lap starts per user per minute), so achieved is finally
    // comparable to requested.
    lapStartsSubmitted: number;
    lapStartsSubmittedRamp: number;
    lapStartsSubmittedSteady: number;
    // A10 (VALIDATION-1.md): steady-state lap starts, split by mode — the
    // per-mode achieved rate `metrics/report.ts` derives from this.
    lapStartsSubmittedSteadyByMode: Record<DriverMode, number>;
    // Informational only — NOT part of the §5.5 identity. One per hop's
    // `bridge_submit` phase sample (`ring.length - 1` hops per lap), so a
    // 3-hop ring reports ~3× `lapStartsSubmitted`'s count. Kept under its
    // own name (previously misleadingly called `bridgesSubmitted`, which
    // attempt #1's identity check compared against tick-unit counters) so
    // a reader cannot mistake it for the achieved lap-start rate.
    hopBridgesSubmitted: number;
    hopBridgesSubmittedRamp: number;
    hopBridgesSubmittedSteady: number;
  };
  resources: { samples: (ResourceSampleInput & { ts: string })[] };
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface CollectorOptions {
  clock?: Clock;
  activitySink?: ActivitySink | null;
}

export interface RunStartInput {
  toolVersion: string;
  sdkVersion: string;
  host: HostInfo;
  // Needed to split `lapStartsSubmitted`/`hopBridgesSubmitted` into ramp vs.
  // steady-state (DESIGN §5.5 invariant 3). Omit for a collector that
  // doesn't need the split (e.g. a unit test feeding synthetic events
  // directly).
  rampUpSeconds?: number;
}

export interface RunEndInput {
  aborted: boolean;
  abortCause: AbortCause | null;
  // Optional/defaults to 0 so existing callers (and tests) that don't
  // track this need not pass it — see `RunInfo.lapsInFlightAtStop`.
  lapsInFlightAtStop?: number;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface Collector {
  // Run lifecycle (§6.2 `run_start` / `run_end`).
  runStart(input: RunStartInput): void;
  runEnd(input: RunEndInput): void;

  // §6.2 per-event ndjson kinds. Each both appends a line to the activity
  // sink (when one is configured) AND updates the in-memory aggregates
  // `snapshot()` returns.
  userReady(userId: string, mode: DriverMode): void;
  tick(userId: string, mode: DriverMode): void;
  tickSkipped(userId: string, mode: DriverMode, gate: Gate | null): void;
  hopState(input: HopStateInput): void;
  txSent(input: TxEventInput): void;
  txReceipt(input: TxReceiptInput): void;
  activityRow(input: ActivityRowInput): void;
  claimAttempt(input: ClaimAttemptInput): void;
  error(input: ErrorInput): void;
  hopEnd(input: HopEndInput): void;
  lapEnd(input: LapEndInput): void;
  resourceSample(input: ResourceSampleInput): void;

  // §5.1 phase timers. Not an ndjson kind of its own — DESIGN §6.2's kind
  // list is closed and phase samples would be by far the highest-volume
  // event, so they are aggregated into `results.json`'s `phases` /
  // `hops.byRoute[route].phases` only, never logged per-sample.
  recordPhase(input: PhaseInput): void;

  // §5.2 HTTP samples. Same reasoning as `recordPhase`: aggregated into
  // `results.json`'s `http` section, not logged per-request.
  recordHttpSample(input: HttpSampleInput): void;

  // R11 (loadtest/REVIEW.md): a request made outside a
  // `runWithFetchContext` scope (`workers/headless/uiCallset.ts`'s
  // `installTimingFetch`) is performed but was previously not recorded AT
  // ALL — no sample, no counter, no warning — so the endpoint tables were
  // an undisclosed lower bound of unknown tightness. This makes the gap
  // visible and testable.
  recordUncontextedRequest(): void;

  // §5.4 gate-stall accounting.
  recordGateVisit(input: GateVisitInput): void;
  /** A `skipped_backpressure` scheduler tick, attributed to the gate the oldest in-flight hop was sitting on (`null` when no hop was in flight to blame). */
  recordGateBlocked(gate: Gate | null): void;

  // §3.4 policy counters (the `HopCounter` subset DESIGN §6.1's `policy`
  // section surfaces: `autoclaim_overdue`, `unexpected_autoclaim`,
  // `claim_race_lost`. `not_yet_claimable` is still tallied internally for
  // completeness but has no dedicated report slot per §6.1's schema).
  recordHopCounter(counter: HopCounter): void;

  // §5.5 invariant 1's other three terms (the fourth, `lapStartsSubmitted`,
  // is derived from `tick()`'s own call count so it can never drift from
  // what the runner actually launched — see the `CollectorSnapshot.scheduler`
  // doc above for why this is `tick()`-derived and not `recordPhase`-derived).
  setSchedulerCounters(input: SchedulerCountersInput): void;

  snapshot(): CollectorSnapshot;
  close(): void;
}

const emptyLapCounts = (): Record<LapOutcome, number> => ({
  LAP_DONE: 0,
  LAP_FAILED: 0,
  LAP_ABORTED: 0
});

interface PhaseBucket {
  global: Map<Phase, { browser: number[]; headless: number[] }>;
  byRoute: Map<string, Map<Phase, { browser: number[]; headless: number[] }>>;
}

const emptyModeSamples = (): { browser: number[]; headless: number[] } => ({
  browser: [],
  headless: []
});

const getOrCreate = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = make();
  map.set(key, created);
  return created;
};

const nowIso = (clock: Clock): string => new Date(clock.now()).toISOString();

export const createCollector = (options: CollectorOptions = {}): Collector => {
  const clock = options.clock ?? systemClock;
  const sink = options.activitySink ?? null;

  const run: RunInfo = {
    startedAt: null,
    endedAt: null,
    durationMs: null,
    aborted: false,
    abortCause: null,
    lapsInFlightAtStop: 0,
    toolVersion: null,
    sdkVersion: null,
    host: null
  };
  let startedAtMs: number | null = null;
  let rampEndsAtMs: number | null = null;

  const phases: PhaseBucket = { global: new Map(), byRoute: new Map() };

  const hopsByOutcome = new Map<Outcome, number>();
  const hopRouteOutcomes = new Map<string, Map<Outcome, number>>();
  // S30: per-route outcome counts, split further by mode — see
  // `CollectorSnapshot.hopsByRoute[route].byOutcomeByMode`'s doc above.
  const hopRouteOutcomesByMode = new Map<string, Record<DriverMode, Map<Outcome, number>>>();
  const lapsByOutcome = emptyLapCounts();
  // S27: per-mode counterpart of `lapsByOutcome` — see its `CollectorSnapshot`
  // doc above.
  const lapsByOutcomeByMode: Record<DriverMode, Record<LapOutcome, number>> = {
    browser: emptyLapCounts(),
    headless: emptyLapCounts()
  };

  interface HttpSampleRecord {
    durationMs: number;
    status: number;
    attempt: number;
    origin: HttpOrigin;
  }
  const httpSamples = new Map<
    string,
    { browser: HttpSampleRecord[]; headless: HttpSampleRecord[] }
  >();

  // R6 (loadtest/REVIEW.md): each visit carries `timedOut` alongside its
  // duration — see `GateStats.timedOutVisits`'s doc.
  const gateVisits = new Map<Gate, { durationMs: number; timedOut: boolean }[]>();
  const gateBlocked = new Map<Gate, number>();

  interface ErrorAgg {
    count: number;
    firstSeen: string;
    lastSeen: string;
    sample: string;
    endpointClass?: string;
  }
  const errorsByClass = new Map<ErrorClass, ErrorAgg>();
  // R7 (loadtest/REVIEW.md): counts for the two suppressed error classes —
  // see `error()`'s doc.
  let suppressedNotReady = 0;
  let suppressedBenignAsset = 0;
  // R11 (loadtest/REVIEW.md): see `recordUncontextedRequest`'s doc.
  let uncontextedRequests = 0;
  // R2 (loadtest/REVIEW.md): global-only censored-phase counts — see
  // `CollectorSnapshot.phaseCensoredCounts`'s doc.
  const phaseCensoredCounts = new Map<Phase, number>();

  const hopCounters: Record<HopCounter, number> = {
    autoclaim_overdue: 0,
    unexpected_autoclaim: 0,
    claim_race_lost: 0,
    not_yet_claimable: 0
  };

  let schedulerCounters: SchedulerCountersInput = {
    ticksOffered: 0,
    skippedBackpressure: 0,
    ticksLostToRamp: 0,
    ticksExpected: 0
  };

  // S11 retry defect (1): two SEPARATE ramp/steady splits, in two different
  // units — see the `CollectorSnapshot.scheduler` doc above.
  let lapStartsRamp = 0;
  let lapStartsSteady = 0;
  let hopBridgesSubmittedRamp = 0;
  let hopBridgesSubmittedSteady = 0;
  // VALIDATION-1.md A10: `steadyStateRatePerUserPerMin` blends browser and
  // headless into ONE number, hiding exactly the fact that matters when the
  // two modes behave completely differently (one run: browser ~1.79
  // lap-starts/user/min with ZERO backpressure skips, headless ~0.61 with
  // ALL skips). Tracked per-mode, steady-state only (mirrors the overall
  // figure), so `metrics/report.ts` can report an achieved rate PER MODE
  // rather than one blended headline.
  let lapStartsSteadyByMode: Record<DriverMode, number> = { browser: 0, headless: 0 };

  const resourceSamples: (ResourceSampleInput & { ts: string })[] = [];

  const writeLine = (
    kind: string,
    userId: string | null,
    mode: DriverMode | null,
    extra: Record<string, unknown>
  ): void => {
    if (sink === null) return;
    sink.write(JSON.stringify({ ts: nowIso(clock), kind, userId, mode, ...extra }));
  };

  const aggregateModeSplit = (samples: {
    browser: number[];
    headless: number[];
  }): ModeSplitStats<Stats> => ({
    browser: computeStats(samples.browser),
    headless: computeStats(samples.headless)
  });

  const snapshotPhases = (
    map: Map<Phase, { browser: number[]; headless: number[] }>
  ): Partial<Record<Phase, ModeSplitStats<Stats>>> => {
    const out: Partial<Record<Phase, ModeSplitStats<Stats>>> = {};
    for (const [phase, samples] of map) {
      if (samples.browser.length === 0 && samples.headless.length === 0) continue;
      out[phase] = aggregateModeSplit(samples);
    }
    return out;
  };

  const collector: Collector = {
    runStart(input) {
      startedAtMs = clock.now();
      run.startedAt = nowIso(clock);
      run.toolVersion = input.toolVersion;
      run.sdkVersion = input.sdkVersion;
      run.host = input.host;
      run.aborted = false;
      run.abortCause = null;
      run.lapsInFlightAtStop = 0;
      rampEndsAtMs =
        input.rampUpSeconds !== undefined ? startedAtMs + input.rampUpSeconds * 1000 : null;
      writeLine('run_start', null, null, {
        toolVersion: input.toolVersion,
        sdkVersion: input.sdkVersion,
        host: input.host
      });
    },

    runEnd(input) {
      const endedAtMs = clock.now();
      run.endedAt = nowIso(clock);
      run.durationMs = startedAtMs !== null ? Math.max(0, endedAtMs - startedAtMs) : null;
      run.aborted = input.aborted;
      run.abortCause = input.abortCause;
      run.lapsInFlightAtStop = input.lapsInFlightAtStop ?? 0;
      writeLine('run_end', null, null, {
        aborted: input.aborted,
        abortCause: input.abortCause,
        lapsInFlightAtStop: run.lapsInFlightAtStop,
        durationMs: run.durationMs
      });
    },

    userReady(userId, mode) {
      writeLine('user_ready', userId, mode, {});
    },

    tick(userId, mode) {
      writeLine('tick', userId, mode, {});
      // S11 retry defect (1): this is the collector's OWN independent count
      // of a lap actually being started — the runner calls `tick()` exactly
      // once per `start_lap` scheduler decision (never for a
      // `skipped_backpressure` one), so this count is expected to equal the
      // scheduler's own `ticksIssued` (pushed in via `setSchedulerCounters`'s
      // `ticksOffered` term) — two independent measurements of the same
      // event, which is what makes §5.5 invariant 1 a genuine check rather
      // than a tautology.
      const isSteady = rampEndsAtMs === null || clock.now() >= rampEndsAtMs;
      if (isSteady) {
        lapStartsSteady += 1;
        lapStartsSteadyByMode = {
          ...lapStartsSteadyByMode,
          [mode]: lapStartsSteadyByMode[mode] + 1
        };
      } else {
        lapStartsRamp += 1;
      }
    },

    tickSkipped(userId, mode, gate) {
      writeLine('tick_skipped', userId, mode, { gate });
    },

    hopState(input) {
      writeLine('hop_state', input.userId, input.mode, {
        hopId: input.hopId,
        lapId: input.lapId,
        from: input.from,
        to: input.to,
        transition: input.transition
      });
    },

    txSent(input) {
      writeLine('tx_sent', input.userId, input.mode, {
        hopId: input.hopId,
        step: input.step,
        txHash: input.txHash
      });
    },

    txReceipt(input) {
      writeLine('tx_receipt', input.userId, input.mode, {
        hopId: input.hopId,
        step: input.step,
        status: input.status
      });
    },

    activityRow(input) {
      writeLine('activity_row', input.userId, input.mode, {
        hopId: input.hopId,
        hash: input.hash,
        status: input.status,
        trackingStep: input.trackingStep
      });
    },

    claimAttempt(input) {
      writeLine('claim_attempt', input.userId, input.mode, {
        hopId: input.hopId,
        claimable: input.claimable,
        reason: input.reason
      });
    },

    error(input) {
      // DESIGN §5.3: `not_ready` is "Not an error" — counted as a gate
      // stall (§5.4) and explicitly "excluded from the error report".
      // Guarded here too (not just at the call site) so a caller mistake
      // can never leak it into `results.json`'s error tables.
      //
      // R7 (loadtest/REVIEW.md): both suppressions below are correct
      // policy, but NEITHER used to be counted anywhere — so a run whose
      // only errors were suppressed rendered "No errors recorded." over a
      // non-empty `activity.ndjson`. `suppressedNotReady`/
      // `suppressedBenignAsset` make that visible.
      if (input.errorClass === 'not_ready') {
        suppressedNotReady += 1;
        return;
      }

      // Defensive redaction (§2.2 / this module's own invariant): every
      // classifier in `errors.ts` already redacts, but `error()` is also a
      // valid direct entry point, so no secret can reach `activity.ndjson`
      // or the error aggregates through it unredacted.
      const message = redactSecrets(input.message);
      const ts = nowIso(clock);

      writeLine('error', input.userId, input.mode, {
        errorClass: input.errorClass,
        message,
        endpointClass: input.endpointClass,
        hopId: input.hopId
      });

      // S11 retry defect (3): known-benign EXTERNAL asset-host noise (see
      // `errors.ts`'s `isBenignExternalAssetHost` doc) is written to
      // `activity.ndjson` above (so the URL stays auditable) but excluded
      // from the aggregate tables below — the SAME treatment `not_ready`
      // gets above, and for the same reason: at S14/S17 scale this noise
      // would otherwise swamp genuine findings.
      if (input.errorClass === 'console_error' && isBenignExternalAssetHost(input.endpointClass)) {
        suppressedBenignAsset += 1;
        return;
      }

      const existing = errorsByClass.get(input.errorClass);
      if (existing === undefined) {
        errorsByClass.set(input.errorClass, {
          count: 1,
          firstSeen: ts,
          lastSeen: ts,
          sample: message,
          endpointClass: input.endpointClass
        });
      } else {
        existing.count += 1;
        existing.lastSeen = ts;
      }
    },

    hopEnd(input) {
      hopsByOutcome.set(input.outcome, (hopsByOutcome.get(input.outcome) ?? 0) + 1);
      const routeOutcomes = getOrCreate(
        hopRouteOutcomes,
        input.hopRoute,
        () => new Map<Outcome, number>()
      );
      routeOutcomes.set(input.outcome, (routeOutcomes.get(input.outcome) ?? 0) + 1);

      const routeOutcomesByMode = getOrCreate(hopRouteOutcomesByMode, input.hopRoute, () => ({
        browser: new Map<Outcome, number>(),
        headless: new Map<Outcome, number>()
      }));
      const modeOutcomes = routeOutcomesByMode[input.mode];
      modeOutcomes.set(input.outcome, (modeOutcomes.get(input.outcome) ?? 0) + 1);

      writeLine('hop_end', input.userId, input.mode, {
        hopId: input.hopId,
        lapId: input.lapId,
        hopRoute: input.hopRoute,
        outcome: input.outcome
      });
    },

    lapEnd(input) {
      lapsByOutcome[input.outcome] += 1;
      lapsByOutcomeByMode[input.mode][input.outcome] += 1;
      writeLine('lap_end', input.userId, input.mode, {
        lapId: input.lapId,
        outcome: input.outcome
      });
    },

    resourceSample(input) {
      const sample = { ...input, ts: nowIso(clock) };
      resourceSamples.push(sample);
      writeLine('resource_sample', null, null, {
        toolRssMb: input.toolRssMb,
        toolCpuPct: input.toolCpuPct,
        browserProcesses: input.browserProcesses,
        ...(input.eventLoopDelayP99Ms !== undefined
          ? { eventLoopDelayP99Ms: input.eventLoopDelayP99Ms }
          : {})
      });
    },

    recordPhase(input) {
      // R2 (loadtest/REVIEW.md): a CENSORED sample (a phase that timed out)
      // is counted separately, never mixed into the percentile arrays — a
      // duration capped at the configured timeout is not a latency
      // measurement, and mixing it in would (re-)introduce exactly the
      // optimistic-bias-from-duplication failure mode R28 fixed for
      // `ready_to_claim` specifically. `bridge_submit`'s
      // `hopBridgesSubmitted*` accounting below is unaffected either way —
      // a censored `bridge_submit` sample cannot occur (that phase only
      // times out via `timeout_bridge_submit`, recorded on BRIDGE_BUILD,
      // never on a sample already tagged `bridge_submit`).
      if (input.censored === true) {
        phaseCensoredCounts.set(input.phase, (phaseCensoredCounts.get(input.phase) ?? 0) + 1);
        return;
      }

      const globalBucket = getOrCreate(phases.global, input.phase, emptyModeSamples);
      globalBucket[input.mode].push(input.durationMs);

      const routeMap = getOrCreate(
        phases.byRoute,
        input.hopRoute,
        () => new Map<Phase, { browser: number[]; headless: number[] }>()
      );
      const routeBucket = getOrCreate(routeMap, input.phase, emptyModeSamples);
      routeBucket[input.mode].push(input.durationMs);

      if (input.phase === 'bridge_submit') {
        // Informational only (§5.5 identity uses `lapStartsSubmitted`,
        // tallied by `tick()` above, not this) — one sample per HOP's
        // bridge send, so `ring.length - 1` of these per lap start.
        const isSteady = rampEndsAtMs === null || clock.now() >= rampEndsAtMs;
        if (isSteady) hopBridgesSubmittedSteady += 1;
        else hopBridgesSubmittedRamp += 1;
      }
    },

    recordHttpSample(input) {
      const bucket = getOrCreate(httpSamples, input.endpointClass, () => ({
        browser: [],
        headless: []
      }));
      bucket[input.mode].push({
        durationMs: input.durationMs,
        status: input.status,
        attempt: input.attempt,
        // S24: defaults to 'ui' — see `HttpOrigin` doc.
        origin: input.origin ?? 'ui'
      });
    },

    recordUncontextedRequest() {
      uncontextedRequests += 1;
    },

    recordGateVisit(input) {
      const list = getOrCreate(gateVisits, input.gate, () => []);
      list.push({ durationMs: input.durationMs, timedOut: input.timedOut === true });
    },

    recordGateBlocked(gate) {
      if (gate === null) return;
      gateBlocked.set(gate, (gateBlocked.get(gate) ?? 0) + 1);
    },

    recordHopCounter(counter) {
      hopCounters[counter] += 1;
    },

    setSchedulerCounters(input) {
      schedulerCounters = { ...input };
    },

    snapshot() {
      const httpOut: Record<string, HttpModeSplit<HttpStats>> = {};
      const toHttpStats = (samples: HttpSampleRecord[]): HttpStats | null => {
        const stats = computeStats(samples.map((s) => s.durationMs));
        if (stats === null) return null;
        const byStatus: Record<string, number> = {};
        let retries = 0;
        for (const sample of samples) {
          const key = String(sample.status);
          byStatus[key] = (byStatus[key] ?? 0) + 1;
          if (sample.attempt > 0) retries += 1;
        }
        return { ...stats, byStatus, retries };
      };
      // S24: split each mode's samples by origin BEFORE computing stats, so
      // a `harness`-tagged sample can never contribute to the `ui` figure
      // (or vice versa) — the split happens once, here, not by filtering an
      // already-merged stat.
      const toOriginSplit = (samples: HttpSampleRecord[]): OriginSplitStats<HttpStats> => ({
        ui: toHttpStats(samples.filter((s) => s.origin === 'ui')),
        harness: toHttpStats(samples.filter((s) => s.origin === 'harness'))
      });
      for (const [endpointClass, bucket] of httpSamples) {
        httpOut[endpointClass] = {
          browser: toOriginSplit(bucket.browser),
          headless: toOriginSplit(bucket.headless)
        };
      }

      const gatesOut: Partial<Record<Gate, GateStats>> = {};
      const allGateNames = new Set<Gate>([...gateVisits.keys(), ...gateBlocked.keys()]);
      for (const gate of allGateNames) {
        const visits = gateVisits.get(gate) ?? [];
        const durations = visits.map((v) => v.durationMs);
        const stats = computeStats(durations);
        gatesOut[gate] = {
          hopsEntered: durations.length,
          totalMs: durations.reduce((sum, d) => sum + d, 0),
          p50: stats?.p50 ?? 0,
          p90: stats?.p90 ?? 0,
          p99: stats?.p99 ?? 0,
          blockedTicks: gateBlocked.get(gate) ?? 0,
          timedOutVisits: visits.filter((v) => v.timedOut).length
        };
      }

      const errorsByClassOut: Partial<Record<ErrorClass, number>> = {};
      const top: ErrorTopEntry[] = [];
      for (const [errorClass, agg] of errorsByClass) {
        errorsByClassOut[errorClass] = agg.count;
        top.push({
          class: errorClass,
          count: agg.count,
          firstSeen: agg.firstSeen,
          lastSeen: agg.lastSeen,
          sample: agg.sample,
          endpointClass: agg.endpointClass
        });
      }
      top.sort((a, b) => b.count - a.count);

      const hopsByRouteOut: CollectorSnapshot['hopsByRoute'] = {};
      const routeKeys = new Set<string>([
        ...hopRouteOutcomes.keys(),
        ...phases.byRoute.keys(),
        ...hopRouteOutcomesByMode.keys()
      ]);
      for (const route of routeKeys) {
        const outcomesMap = hopRouteOutcomes.get(route);
        const byOutcome: Partial<Record<Outcome, number>> = {};
        if (outcomesMap !== undefined) {
          for (const [outcome, count] of outcomesMap) byOutcome[outcome] = count;
        }
        const outcomesByModeMap = hopRouteOutcomesByMode.get(route);
        const byOutcomeByMode: Record<DriverMode, Partial<Record<Outcome, number>>> = {
          browser: {},
          headless: {}
        };
        if (outcomesByModeMap !== undefined) {
          for (const mode of ['browser', 'headless'] as const) {
            for (const [outcome, count] of outcomesByModeMap[mode]) {
              byOutcomeByMode[mode][outcome] = count;
            }
          }
        }
        const routePhaseMap = phases.byRoute.get(route);
        hopsByRouteOut[route] = {
          byOutcome,
          byOutcomeByMode,
          phases: routePhaseMap !== undefined ? snapshotPhases(routePhaseMap) : {}
        };
      }

      const hopsByOutcomeOut: Partial<Record<Outcome, number>> = {};
      for (const [outcome, count] of hopsByOutcome) hopsByOutcomeOut[outcome] = count;

      return {
        run: { ...run },
        phases: snapshotPhases(phases.global),
        phaseCensoredCounts: Object.fromEntries(phaseCensoredCounts),
        uncontextedRequests,
        hopsByOutcome: hopsByOutcomeOut,
        hopsByRoute: hopsByRouteOut,
        lapsByOutcome: { ...lapsByOutcome },
        lapsByOutcomeByMode: {
          browser: { ...lapsByOutcomeByMode.browser },
          headless: { ...lapsByOutcomeByMode.headless }
        },
        http: httpOut,
        gates: gatesOut,
        errors: {
          byClass: errorsByClassOut,
          top: top.slice(0, 10),
          suppressed: { notReady: suppressedNotReady, benignExternalAsset: suppressedBenignAsset }
        },
        policy: {
          autoclaimOverdue: hopCounters.autoclaim_overdue,
          unexpectedAutoclaim: hopCounters.unexpected_autoclaim,
          claimRaceLost: hopCounters.claim_race_lost
        },
        scheduler: {
          ticksOffered: schedulerCounters.ticksOffered,
          skippedBackpressure: schedulerCounters.skippedBackpressure,
          ticksLostToRamp: schedulerCounters.ticksLostToRamp,
          ticksExpected: schedulerCounters.ticksExpected ?? 0,
          lapStartsSubmitted: lapStartsRamp + lapStartsSteady,
          lapStartsSubmittedRamp: lapStartsRamp,
          lapStartsSubmittedSteady: lapStartsSteady,
          lapStartsSubmittedSteadyByMode: { ...lapStartsSteadyByMode },
          hopBridgesSubmitted: hopBridgesSubmittedRamp + hopBridgesSubmittedSteady,
          hopBridgesSubmittedRamp,
          hopBridgesSubmittedSteady
        },
        resources: { samples: [...resourceSamples] }
      };
    },

    close() {
      sink?.close?.();
    }
  };

  return collector;
};

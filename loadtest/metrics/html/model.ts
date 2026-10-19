// The report view model (S54, heavy-load design §4.4): `buildReportModel` is a
// pure function from `results.json`, an `activity.ndjson` digest and the optional
// `meta.txt` values to everything the renderer draws. Numbers are raw here; the
// renderer only formats them. Nothing in the model is the unredacted config:
// `config` is the allowlisted view, endpoint classes are rewritten through
// `redactEndpointClass`, and free text passes through `redactSecrets`.
import { formatEther } from 'viem';

import type { Outcome } from '../../core/types';
import type { HopMeasurementRecord } from '../measurement';
import type { ResultsJson } from '../report';
import type { CriterionResult } from '../stopCriteria';
import type { Bucket } from './downsample';
import type { Digest } from './ndjsonDigest';

import { isSuccessOutcome } from '../../core/types';
import { redactSecrets } from '../../wallets/redact';
import { allowlistedConfigView, redactEndpointClass } from '../redactReport';
import { checkThroughputIdentity, computeVerdict, failureRates } from '../report';
import { evaluateStopCriteria, routeOfHop } from '../stopCriteria';
import { bucketCounts, bucketSeries, MAX_HOP_POINTS, thin } from './downsample';
import { clip } from './escape';

export const REPORT_GENERATOR_VERSION = 1;

/** Wrapped-token claim gas reference points from S51 (repeat claim, supply and balance nonzero / zero). */
export const REPEAT_CLAIM_GAS_NONZERO = 177_166;
export const REPEAT_CLAIM_GAS_ZERO = 228_454;
/** One zero-to-nonzero SSTORE adds this much gas (S51). */
export const SSTORE_ZERO_TO_NONZERO_GAS = 17_100;

export interface RunMeta {
  ring?: string;
  users?: string;
  minutes?: string;
  rate?: string;
  devUi?: string;
}

export interface Dist {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
}

/** min, true median, nearest-rank p90, max. */
export const dist = (values: readonly number[]): Dist | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p90 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1))];
  return { n: sorted.length, min: sorted[0], median, p90, max: sorted[sorted.length - 1] };
};

export type VerdictLevel = 'pass' | 'fail' | 'incomplete' | 'aborted' | 'nolaps';

export interface Kpi {
  /** Stable key used for `data-metric` (tests read it). */
  metric: string;
  label: string;
  value: string;
  /** Raw number behind the value, when there is one. */
  raw: number | null;
  sub: string;
  tone: 'good' | 'bad' | 'neutral';
  na: boolean;
  /** Reason shown on hover when `na`. */
  why?: string;
}

export interface RouteInfo {
  key: string;
  label: string;
  /** Colour slot. */
  slot: number;
  fromNetworkId: number | null;
  toNetworkId: number | null;
}

export interface LatencyRoute {
  route: string;
  completed: number;
  failedExcluded: number;
  ready: Dist | null;
  endToEnd: Dist | null;
  claimTx: Dist | null;
  /** Per-segment medians (ms) for the stage breakdown bar; `null` when the stage probe was off. */
  segments: { name: string; median: number }[] | null;
  stageRows: { name: string; dist: Dist | null }[];
  points: { ready: number[]; failedReady: number[] };
  pointsSampled: boolean;
}

export interface PhaseRow {
  phase: string;
  mode: 'browser' | 'headless';
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  censored: number;
}

export interface TimelineModel {
  mode: 'rows' | 'area' | 'none';
  reason: string;
  spanMs: number;
  rows: {
    label: string;
    tip: string;
    failed: boolean;
    segments: { from: number; to: number; slot: number | 'crit'; open: boolean }[];
  }[];
  area: { route: string; slot: number; buckets: Bucket[] }[];
  laps: number;
  rowsShown: number;
  leaves: number[];
  pumps: number[];
  plannedStopAt: number | null;
}

export interface ErrorsModel {
  rows: { class: string; count: number; own: boolean }[];
  suppressed: { notReady: number; benignExternalAsset: number };
  top: {
    class: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    sample: string;
    endpointClass: string;
  }[];
  perMinute: {
    starts: number[];
    widthMs: number;
    stacks: { name: string; slot: number | 'muted'; values: number[] }[];
  } | null;
  nonSuppressedTotal: number;
}

export interface HttpRow {
  endpointClass: string;
  mode: 'browser' | 'headless';
  origin: 'ui' | 'harness';
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  byStatus: Record<string, number>;
  retries: number;
}

export interface WalletRow {
  userId: string;
  walletIndex: number | null;
  ticks: number;
  lapsDone: number;
  lapsFailed: number;
  lapsAborted: number;
  hopsOk: number;
  hopsFailed: number;
  lastMinBalanceWei: string | null;
}

export interface ReportModel {
  schema: 1;
  generator: { version: number; generatedAt: string };
  identity: {
    runName: string;
    env: string;
    ringPath: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    requested: ResultsJson['requested'];
    toolVersion: string | null;
    meta: RunMeta;
    neverStarted: boolean;
  };
  verdict: {
    text: string;
    level: VerdictLevel;
    lapFailureRate: number | null;
    hardHopFailureRate: number | null;
    lapsFinished: number;
    lapsFailed: number;
    hopsEnded: number;
    hardHopFailures: number;
    aborted: boolean;
    abortCause: string | null;
    lapsInFlightAtStop: number;
    pumpOn: boolean;
  };
  routes: RouteInfo[];
  kpis: Kpi[];
  throughput: {
    requested: ResultsJson['requested'];
    achieved: ResultsJson['achieved'];
    identityOk: boolean;
    gap: number;
    lapsByMode: ResultsJson['laps']['byMode'];
    lapsStarted: number;
  };
  hopOutcomes: {
    byOutcome: Record<string, number>;
    byRoute: { route: string; byOutcome: Record<string, number> }[];
    byRouteMode: {
      route: string;
      mode: string;
      attempted: number;
      completed: number;
      completionRate: number | null;
    }[];
    outcomeOrder: string[];
  };
  latency: {
    hasMeasurements: boolean;
    probeIntervalMs: number | null;
    routes: LatencyRoute[];
    phases: PhaseRow[];
    eventLoopDisqualifiedAt: number | null;
    fallbackRoutes: {
      route: string;
      ready: { n: number; p50: number; p90: number; p99: number; max: number } | null;
    }[];
  };
  timeline: TimelineModel;
  claimGas: {
    hasMeasurements: boolean;
    rows: {
      toNetworkId: number;
      claimKind: string;
      n: number;
      gasMin: string;
      gasMedian: string;
      gasMax: string;
      priceMedian: string;
      feeMedian: string;
    }[];
    mintGas: number[];
    mintPreState: { label: string; n: number; min: number; median: number; max: number }[] | null;
    mintBuckets: { k: number; n: number; min: number; max: number }[];
    mintMin: number | null;
    firstClaims: number;
    repeatClaims: number;
    bridgeGas: {
      route: string;
      n: number;
      min: number;
      median: number;
      max: number;
      priceMedian: string;
    }[];
    approveGas: {
      networkId: number;
      n: number;
      gasMin: string;
      gasMedian: string;
      gasMax: string;
    }[];
  };
  gates: {
    gate: string;
    hopsEntered: number;
    totalMs: number;
    p50: number;
    p90: number;
    p99: number;
    blockedTicks: number;
    timedOutVisits: number;
  }[];
  errors: ErrorsModel;
  http: {
    rows: HttpRow[];
    uncontextedRequests: number;
    windows: {
      p90: { name: string; slot: number; buckets: Bucket[] }[];
      statuses: {
        starts: number[];
        widthMs: number;
        stacks: { name: string; slot: number | 'crit' | 'muted'; values: number[] }[];
      } | null;
    } | null;
  };
  resources: {
    rss: Bucket[];
    cpu: Bucket[];
    eventLoop: Bucket[];
    browserRss: Bucket[] | null;
    samples: number;
    peakRssMb: number | null;
    worstEventLoopMs: number | null;
    spanMs: number;
  };
  pump: {
    state: 'on' | 'off';
    note: string;
    sender: string | null;
    destinationNetworkId: number | null;
    amountWei: string | null;
    intervalSeconds: number | null;
    maxTotalSpendWei: string | null;
    maxGasPriceWei: string | null;
    totalSpendWei: string | null;
    pendingAtStop: boolean | null;
    deposits: {
      txHash: string;
      blockNumber: string;
      depositCount: number | null;
      status: string;
      gasUsed: string;
      effectiveGasPrice: string;
      costWei: string;
      cumulativeWei: string;
    }[];
    skipped: Record<string, number>;
    leavesInWindow: number | null;
    leavesFromPump: number | null;
    leavesOther: number | null;
  };
  stop: CriterionResult[];
  wallets: {
    balanceCharts: { chainKey: string; min: Bucket[]; median: Bucket[]; floorEth: number | null }[];
    rows: WalletRow[];
    totalWallets: number;
    rowsTruncated: boolean;
  };
  config: Record<string, unknown>;
  environment: {
    toolVersion: string | null;
    sdkVersion: string | null;
    host: { cores: number; totalMemMb: number; platform: string } | null;
    gasTokenChains: string[];
    schemaVersion: number;
    ndjson: { present: boolean; lines: number; malformed: number; truncatedTail: boolean };
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const wei = (value: string | undefined | null): bigint | null => {
  if (value === undefined || value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const weiToEth = (value: string): number => {
  try {
    return Number(formatEther(BigInt(value)));
  } catch {
    return 0;
  }
};

export const levelOfVerdict = (text: string): VerdictLevel =>
  text.startsWith('PASS')
    ? 'pass'
    : text.startsWith('FAIL')
      ? 'fail'
      : text.startsWith('INCOMPLETE')
        ? 'incomplete'
        : text.startsWith('ABORTED')
          ? 'aborted'
          : 'nolaps';

const STATE_SLOT: Record<string, number> = {
  PLANNED: 0,
  APPROVE_BUILD: 0,
  APPROVE_PENDING: 0,
  BRIDGE_BUILD: 0,
  BRIDGE_PENDING: 0,
  AWAITING_ACTIVITY: 1,
  AWAITING_READY: 2,
  AWAITING_AUTOCLAIM: 2,
  CLAIM_BUILD: 3,
  CLAIM_PENDING: 3,
  AWAITING_CLAIMED: 4
};

/** Slot names shown in the timeline legend (index = slot). */
export const TIMELINE_STAGES = [
  'Bridge tx',
  'Awaiting activity',
  'Awaiting ready',
  'Claim tx',
  'Awaiting claimed'
];

/** Stable error-class order, so a class keeps its colour across runs and filters. */
export const ERROR_CLASS_ORDER = [
  'proxy_5xx',
  'proxy_4xx',
  'rpc_error',
  'nonce_conflict',
  'tx_revert',
  'tracker_not_ready',
  'activity_warning'
];

const OUTCOME_ORDER = [
  'hop_completed_auto',
  'hop_completed_manual',
  'hop_completed_escalated',
  'hop_completed_raced'
];

export const SEGMENT_NAMES = [
  'T0 to T1: l1-info-tree-index available',
  'T1 to T2: injected leaf available',
  'T2 to T3: claim proof available',
  'T3 to T3b: tracker READY lag',
  'T3b to T4: claim submit',
  'T4 to T5: claim tx mined'
];

export const STAGE_ROW_NAMES: [string, string][] = [
  ['l1InfoTreeIndex', 'T1-T0 l1-info-tree-index available'],
  ['injectedLeaf', 'T2-T0 injected-l1-info-leaf available'],
  ['claimProof', 'T3-T0 claim-proof available'],
  ['trackerLag', 'T3b-T3 tracker READY lag after claim-proof'],
  ['claimTx', 'T5-T4 claim tx sent to mined'],
  ['endToEnd', 'T5-T0 end to end (includes tracker lag)']
];

const diff = (
  later: number | null | undefined,
  earlier: number | null | undefined
): number | null =>
  later === null || later === undefined || earlier === null || earlier === undefined
    ? null
    : later - earlier;

const nonNeg = (v: number | null): number | null => (v !== null && v >= 0 ? v : null);

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

export interface BuildModelInput {
  results: ResultsJson;
  digest: Digest;
  meta: RunMeta;
  runName: string;
  generatedAt: string;
}

export const buildReportModel = (input: BuildModelInput): ReportModel => {
  const { results, digest, meta } = input;
  const config = (results.config ?? {}) as Record<string, unknown>;
  const chains = (Array.isArray(config.chains) ? config.chains : []) as {
    key: string;
    networkId: number;
    rpcUrl?: string;
  }[];
  const ring = (Array.isArray(config.ring) ? config.ring : []) as string[];
  const netOf = (key: string): number | null =>
    chains.find((c) => c.key === key)?.networkId ?? null;
  const redactCfg = { chains: chains.map((c) => ({ key: c.key, rpcUrl: c.rpcUrl ?? '' })) };
  const safe = (text: string): string => clip(redactSecrets(text));

  // ---- time origin ----
  const startedMs = results.run.startedAt === null ? null : Date.parse(results.run.startedAt);
  const t0 =
    digest.runStartTs ??
    (startedMs !== null && !Number.isNaN(startedMs) ? startedMs : digest.firstTs);
  const spanMs = Math.max(
    results.run.durationMs ?? 0,
    t0 !== null && digest.lastTs !== null ? digest.lastTs - t0 : 0,
    1
  );
  const rel = (ts: number): number => (t0 === null ? 0 : ts - t0);

  // ---- routes ----
  const ringRoutes = ring.slice(0, -1).map((key, i) => `${key}->${ring[i + 1]}`);
  const extraRoutes = Object.keys(results.hops.byRoute).filter((r) => !ringRoutes.includes(r));
  const routeKeys = [...ringRoutes, ...extraRoutes];
  const routes: RouteInfo[] = routeKeys.map((key, slot) => {
    const [from, to] = key.split('->');
    const f = netOf(from);
    const t = netOf(to);
    return {
      key,
      label: `${from} to ${to}${f !== null && t !== null ? ` (${f}>${t})` : ''}`,
      slot,
      fromNetworkId: f,
      toNetworkId: t
    };
  });

  // ---- verdict ----
  const verdictText = computeVerdict(results);
  const rates = failureRates(results);
  const pumpOn = results.pump !== undefined && results.pump.enabled === true;
  const verdict: ReportModel['verdict'] = {
    text: safe(verdictText),
    level: levelOfVerdict(verdictText),
    lapFailureRate: rates.lapFailureRate,
    hardHopFailureRate: rates.hardHopFailureRate,
    lapsFinished: rates.lapsFinished,
    lapsFailed: rates.lapsFailed,
    hopsEnded: rates.hopsEnded,
    hardHopFailures: rates.hardHopFailures,
    aborted: results.run.aborted,
    abortCause: results.run.abortCause === null ? null : safe(results.run.abortCause),
    lapsInFlightAtStop: results.run.lapsInFlightAtStop,
    pumpOn
  };

  // ---- measurements ----
  const msr = results.measurements;
  const mHops: HopMeasurementRecord[] = msr?.hops ?? [];
  const hasMeasurements = msr !== undefined && mHops.length > 0;
  const hopsOfRoute = (route: string): HopMeasurementRecord[] =>
    mHops.filter((h) => h.hopRoute === route);
  const readyWait = (h: HopMeasurementRecord): number | null =>
    nonNeg(diff(h.readyObservedAt, h.bridge.minedObservedAt));

  const readyWaitByRoute: Record<string, number[]> = {};
  const latencyRoutes: LatencyRoute[] = [];
  if (hasMeasurements) {
    const perRouteCap = Math.max(200, Math.floor(MAX_HOP_POINTS / Math.max(1, routeKeys.length)));
    for (const route of routeKeys) {
      const all = hopsOfRoute(route);
      if (all.length === 0) continue;
      const ok = all.filter((h) => isSuccessOutcome(h.outcome));
      const bad = all.filter((h) => !isSuccessOutcome(h.outcome));
      const ready = ok.map(readyWait).filter((v): v is number => v !== null);
      readyWaitByRoute[route] = ready;
      const e2e = ok
        .map((h) => nonNeg(diff(h.claim.minedObservedAt, h.bridge.minedObservedAt)))
        .filter((v): v is number => v !== null);
      const claimTx = ok
        .map((h) => nonNeg(diff(h.claim.minedObservedAt, h.claim.sentAt)))
        .filter((v): v is number => v !== null);
      const failedReady = bad.map(readyWait).filter((v): v is number => v !== null);
      // Stage breakdown from the per-hop segments (hops with every timestamp).
      const segs: number[][] = SEGMENT_NAMES.map(() => []);
      let segHops = 0;
      for (const h of ok) {
        const t = h.bridge.minedObservedAt;
        const s = h.stages;
        const parts = [
          diff(s?.l1InfoTreeIndexAt, t),
          diff(s?.injectedLeafAt, s?.l1InfoTreeIndexAt),
          diff(s?.claimProofAt, s?.injectedLeafAt),
          diff(h.readyObservedAt, s?.claimProofAt),
          diff(h.claim.sentAt, h.readyObservedAt),
          diff(h.claim.minedObservedAt, h.claim.sentAt)
        ];
        if (parts.some((p) => p === null || p < 0)) continue;
        segHops += 1;
        parts.forEach((p, i) => segs[i].push(p as number));
      }
      const segments =
        segHops > 0
          ? SEGMENT_NAMES.map((name, i) => ({ name, median: dist(segs[i])?.median ?? 0 }))
          : null;
      const stageValues: Record<string, number[]> = {};
      for (const [key] of STAGE_ROW_NAMES) stageValues[key] = [];
      for (const h of ok) {
        const t = h.bridge.minedObservedAt;
        const s = h.stages;
        const pairs: Record<string, number | null> = {
          l1InfoTreeIndex: diff(s?.l1InfoTreeIndexAt, t),
          injectedLeaf: diff(s?.injectedLeafAt, t),
          claimProof: diff(s?.claimProofAt, t),
          trackerLag: diff(h.readyObservedAt, s?.claimProofAt),
          claimTx: diff(h.claim.minedObservedAt, h.claim.sentAt),
          endToEnd: diff(h.claim.minedObservedAt, t)
        };
        for (const [k, v] of Object.entries(pairs)) if (v !== null) stageValues[k].push(v);
      }
      const thinned = thin(ready, perRouteCap);
      latencyRoutes.push({
        route,
        completed: ok.length,
        failedExcluded: bad.length,
        ready: dist(ready),
        endToEnd: dist(e2e),
        claimTx: dist(claimTx),
        segments,
        stageRows: STAGE_ROW_NAMES.map(([key, name]) => ({ name, dist: dist(stageValues[key]) })),
        points: { ready: thinned.items, failedReady: failedReady.slice(0, perRouteCap) },
        pointsSampled: thinned.sampled
      });
    }
  }

  const phases: PhaseRow[] = [];
  const phaseData = (results.phases ?? {}) as Record<
    string,
    Record<string, { n: number; p50: number; p90: number; p99: number; max: number } | null>
  >;
  for (const [phase, split] of Object.entries(phaseData)) {
    for (const mode of ['browser', 'headless'] as const) {
      const s = split?.[mode];
      if (s === null || s === undefined) continue;
      phases.push({
        phase,
        mode,
        n: s.n,
        p50: s.p50,
        p90: s.p90,
        p99: s.p99,
        max: s.max,
        censored: results.phaseCensoredCounts?.[phase] ?? 0
      });
    }
  }

  const fallbackRoutes = routeKeys.map((route) => {
    const p = (results.hops.byRoute[route]?.phases ?? {}) as Record<
      string,
      | { headless?: { n: number; p50: number; p90: number; p99: number; max: number } | null }
      | undefined
    >;
    return { route, ready: p.ready_to_claim?.headless ?? null };
  });

  // SC7 disqualification time
  const resourceSamples = (results.resources?.samples ?? []) as unknown as {
    ts: string;
    toolRssMb: number;
    toolCpuPct: number;
    eventLoopDelayP99Ms?: number;
    browserProcesses?: { rssMb: number }[];
  }[];
  const stop = evaluateStopCriteria({
    digest,
    ring,
    chains,
    gasPerChain: (config.users as { funder?: { gasPerChain?: Record<string, string> } } | undefined)
      ?.funder?.gasPerChain,
    pump:
      results.pump === undefined
        ? null
        : {
            maxTotalSpendWei: results.pump.maxTotalSpendWei,
            totalSpendWei: results.pump.totalSpendWei
          },
    readyWaitByRoute
  });
  const sc7 = stop.find((c) => c.id === 'SC7');
  const eventLoopDisqualifiedAt =
    sc7?.fired === true && sc7.firstFiredAt !== null && t0 !== null ? rel(sc7.firstFiredAt) : null;

  // ---- timeline ----
  const timeline = buildTimeline({ digest, ring, routeKeys, t0, spanMs, results, rel });

  // ---- claim gas ----
  const claimGas = buildClaimGas(results, mHops);

  // ---- errors ----
  const errorByClass = (results.errors?.byClass ?? {}) as Record<string, number>;
  const ownRow = new Set(['tracker_not_ready', 'activity_warning']);
  const errorRows = Object.entries(errorByClass)
    .map(([cls, count]) => ({ class: cls, count: count ?? 0, own: ownRow.has(cls) }))
    .sort(
      (a, b) => Number(a.own) - Number(b.own) || b.count - a.count || a.class.localeCompare(b.class)
    );
  const nonSuppressedTotal = errorRows.filter((r) => !r.own).reduce((s, r) => s + r.count, 0);
  let perMinute: ErrorsModel['perMinute'] = null;
  if (digest.present && digest.errorMinutes.size > 0 && t0 !== null) {
    const events: { t: number; key: string; count: number }[] = [];
    for (const [minute, bucket] of digest.errorMinutes) {
      for (const [cls, count] of Object.entries(bucket))
        events.push({ t: minute * 60_000, key: cls, count });
    }
    const bc = bucketCounts(
      events.map((e) => ({ ...e, t: e.t })),
      t0,
      t0 + spanMs,
      240
    );
    const known = ERROR_CLASS_ORDER.filter((c) => bc.byKey[c] !== undefined);
    const other = Object.keys(bc.byKey).filter((c) => !ERROR_CLASS_ORDER.includes(c));
    const len = bc.starts.length;
    const stacks: NonNullable<ErrorsModel['perMinute']>['stacks'] = known.map((c) => ({
      name: c,
      slot: ERROR_CLASS_ORDER.indexOf(c),
      values: bc.byKey[c]
    }));
    if (other.length > 0) {
      const values = new Array<number>(len).fill(0);
      for (const c of other) bc.byKey[c].forEach((v, i) => (values[i] += v));
      stacks.push({ name: 'other', slot: 'muted', values });
    }
    perMinute = { starts: bc.starts.map(rel), widthMs: bc.widthMs, stacks };
  }
  const errors: ErrorsModel = {
    rows: errorRows,
    suppressed: results.errors?.suppressed ?? { notReady: 0, benignExternalAsset: 0 },
    top: (results.errors?.top ?? []).slice(0, 10).map((e) => ({
      class: e.class,
      count: e.count,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      sample: safe(e.sample),
      endpointClass:
        e.endpointClass === undefined ? '' : redactEndpointClass(e.endpointClass, redactCfg)
    })),
    perMinute,
    nonSuppressedTotal
  };

  // ---- http ----
  const httpRows: HttpRow[] = [];
  for (const [cls, split] of Object.entries(results.http ?? {})) {
    for (const mode of ['browser', 'headless'] as const) {
      for (const origin of ['ui', 'harness'] as const) {
        const s = split?.[mode]?.[origin];
        if (s === null || s === undefined) continue;
        httpRows.push({
          endpointClass: redactEndpointClass(cls, redactCfg),
          mode,
          origin,
          n: s.n,
          p50: s.p50,
          p90: s.p90,
          p99: s.p99,
          max: s.max,
          byStatus: s.byStatus,
          retries: s.retries
        });
      }
    }
  }
  httpRows.sort(
    (a, b) =>
      Number(b.endpointClass.startsWith('tracker/')) -
        Number(a.endpointClass.startsWith('tracker/')) ||
      a.endpointClass.localeCompare(b.endpointClass) ||
      a.mode.localeCompare(b.mode) ||
      a.origin.localeCompare(b.origin)
  );
  let httpWindows: ReportModel['http']['windows'] = null;
  if (digest.httpWindows.length > 0 && t0 !== null) {
    const totals = new Map<string, number>();
    for (const w of digest.httpWindows) {
      for (const [group, byOrigin] of Object.entries(w.classes)) {
        totals.set(group, (totals.get(group) ?? 0) + (byOrigin.ui?.n ?? 0));
      }
    }
    const top = [...totals.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([g]) => g);
    const p90 = top.map((group, slot) => ({
      name: redactEndpointClass(group, redactCfg),
      slot,
      buckets: bucketSeries(
        digest.httpWindows
          .filter((w) => w.classes[group]?.ui !== undefined)
          .map((w) => ({ t: rel(w.ts), v: w.classes[group].ui.p90 }))
      )
    }));
    const events: { t: number; key: string; count: number }[] = [];
    for (const w of digest.httpWindows) {
      for (const byOrigin of Object.values(w.classes)) {
        for (const stats of Object.values(byOrigin)) {
          for (const [status, count] of Object.entries(stats.byStatus)) {
            const code = Number.parseInt(status, 10);
            if (code >= 500) events.push({ t: w.ts, key: '5xx', count });
            else if (code === 429) events.push({ t: w.ts, key: '429', count });
            else if (code >= 400) events.push({ t: w.ts, key: '4xx', count });
          }
        }
      }
    }
    const bc = bucketCounts(events, t0, t0 + spanMs, 240);
    const order: [string, number | 'crit' | 'muted'][] = [
      ['5xx', 'crit'],
      ['429', 1],
      ['4xx', 3]
    ];
    const stacks = order
      .filter(([k]) => bc.byKey[k] !== undefined)
      .map(([k, slot]) => ({ name: k, slot, values: bc.byKey[k] }));
    httpWindows = {
      p90,
      statuses:
        stacks.length > 0 ? { starts: bc.starts.map(rel), widthMs: bc.widthMs, stacks } : null
    };
  }

  // ---- resources ----
  const resPoints = (
    pick: (s: (typeof resourceSamples)[number]) => number
  ): { t: number; v: number }[] =>
    resourceSamples.map((s) => ({ t: t0 === null ? 0 : Date.parse(s.ts) - t0, v: pick(s) }));
  const browserSeries = resourceSamples.some((s) => (s.browserProcesses ?? []).length > 0)
    ? bucketSeries(
        resPoints((s) => (s.browserProcesses ?? []).reduce((sum, p) => sum + p.rssMb, 0))
      )
    : null;
  const resources: ReportModel['resources'] = {
    rss: bucketSeries(resPoints((s) => s.toolRssMb)),
    cpu: bucketSeries(resPoints((s) => s.toolCpuPct)),
    eventLoop: bucketSeries(resPoints((s) => s.eventLoopDelayP99Ms ?? 0)),
    browserRss: browserSeries,
    samples: resourceSamples.length,
    peakRssMb:
      resourceSamples.length === 0 ? null : Math.max(...resourceSamples.map((s) => s.toolRssMb)),
    worstEventLoopMs: resourceSamples.some((s) => s.eventLoopDelayP99Ms !== undefined)
      ? Math.max(...resourceSamples.map((s) => s.eventLoopDelayP99Ms ?? 0))
      : null,
    spanMs
  };

  // ---- pump ----
  const cfgPump = config.pump as { enabled?: boolean } | undefined;
  const leaves = results.l1InfoTree?.leaves ?? null;
  const leavesInWindow =
    leaves !== null ? leaves.length : digest.leaves.length > 0 ? digest.leaves.length : null;
  const leavesFromPump =
    leaves !== null
      ? leaves.filter((l) => l.fromPump).length
      : digest.leaves.length > 0
        ? digest.leaves.filter((l) => l.fromPump).length
        : null;
  const rp = results.pump;
  const pump: ReportModel['pump'] = {
    state: pumpOn ? 'on' : 'off',
    note: pumpOn
      ? 'The L1 deposit pump ran beside the users.'
      : cfgPump !== undefined
        ? 'Pump: OFF (configured with enabled=false).'
        : 'Pump: OFF (not configured).',
    sender: rp?.sender ?? null,
    destinationNetworkId: rp?.destinationNetworkId ?? null,
    amountWei: rp?.amountWei ?? null,
    intervalSeconds: rp?.intervalSeconds ?? null,
    maxTotalSpendWei: rp?.maxTotalSpendWei ?? null,
    maxGasPriceWei: rp?.maxGasPriceWei ?? null,
    totalSpendWei: rp?.totalSpendWei ?? null,
    pendingAtStop: rp?.pendingAtStop ?? null,
    deposits: (rp?.deposits ?? []).map((d) => {
      const nd = digest.pump.deposits.find((x) => x.txHash === d.txHash);
      return {
        txHash: abbreviateHash(d.txHash),
        blockNumber: d.blockNumber,
        depositCount: d.depositCount,
        status: d.status,
        gasUsed: d.gasUsed,
        effectiveGasPrice: d.effectiveGasPrice,
        costWei: d.costWei,
        cumulativeWei: nd?.cumulativeSpendWei ?? ''
      };
    }),
    skipped: rp?.skipped ?? { gas_price: 0, cap_reached: 0, previous_pending: 0, send_error: 0 },
    leavesInWindow,
    leavesFromPump,
    leavesOther:
      leavesInWindow !== null && leavesFromPump !== null ? leavesInWindow - leavesFromPump : null
  };

  // ---- wallets ----
  const balSamples =
    results.walletBalances?.samples.map((s) => ({ ...s, t: Date.parse(s.ts) })) ??
    digest.walletBalances.map((s) => ({ ...s, t: s.ts }));
  const gasPerChain = (
    config.users as { funder?: { gasPerChain?: Record<string, string> } } | undefined
  )?.funder?.gasPerChain;
  const chainKeysSeen = [...new Set(balSamples.map((s) => s.chainKey))].slice(0, 4);
  const balanceCharts = chainKeysSeen.map((chainKey) => {
    const mine = balSamples.filter((s) => s.chainKey === chainKey);
    const floorEth =
      gasPerChain?.[chainKey] === undefined ? null : Number.parseFloat(gasPerChain[chainKey]) * 0.2;
    return {
      chainKey,
      min: bucketSeries(
        mine.map((s) => ({ t: t0 === null ? 0 : s.t - t0, v: weiToEth(s.minWei) }))
      ),
      median: bucketSeries(
        mine.map((s) => ({ t: t0 === null ? 0 : s.t - t0, v: weiToEth(s.medianWei) }))
      ),
      floorEth
    };
  });
  const startIndex =
    (config.users as { wallets?: { startIndex?: number } } | undefined)?.wallets?.startIndex ?? 0;
  const lastLow = new Map<string, string>();
  for (const s of balSamples) for (const l of s.lowest) lastLow.set(l.userId, l.wei);
  const walletRowsAll: WalletRow[] = [...digest.wallets.values()]
    .sort((a, b) => userNumber(a.userId) - userNumber(b.userId))
    .map((w) => {
      const n = userNumber(w.userId);
      return {
        userId: w.userId,
        walletIndex: Number.isFinite(n) ? startIndex + n : null,
        ticks: w.ticks,
        lapsDone: w.lapsDone,
        lapsFailed: w.lapsFailed,
        lapsAborted: w.lapsAborted,
        hopsOk: w.hopsOk,
        hopsFailed: w.hopsFailed,
        lastMinBalanceWei: lastLow.get(w.userId) ?? null
      };
    });
  const WALLET_ROW_CAP = 200;

  // ---- KPI cards ----
  const lapDone = results.laps.byOutcome.LAP_DONE ?? 0;
  const lapFailed = results.laps.byOutcome.LAP_FAILED ?? 0;
  const lapAborted = results.laps.byOutcome.LAP_ABORTED ?? 0;
  const hopOutcomes = Object.entries(results.hops.byOutcome).map(
    ([k, v]) => [k, v ?? 0] as [string, number]
  );
  const hopsAttempted = hopOutcomes.reduce((s, [, v]) => s + v, 0);
  const hopsCompleted = hopOutcomes
    .filter(([k]) => isSuccessOutcome(k as Outcome))
    .reduce((s, [, v]) => s + v, 0);
  const identityOk = checkThroughputIdentity(results.achieved);
  const offered = results.achieved.ticksOffered;
  const bpPct = offered > 0 ? (results.achieved.skippedBackpressure / offered) * 100 : null;
  const kpis: Kpi[] = [
    {
      metric: 'laps.done',
      label: 'Laps done',
      value: String(lapDone),
      raw: lapDone,
      sub: `failed ${lapFailed} · aborted ${lapAborted} · in flight at stop ${results.run.lapsInFlightAtStop}`,
      tone: lapFailed > 0 ? 'bad' : 'neutral',
      na: false
    },
    {
      metric: 'hops.completed',
      label: 'Hops completed',
      value: String(hopsCompleted),
      raw: hopsCompleted,
      sub: `of ${hopsAttempted} that reached an outcome`,
      tone: 'neutral',
      na: false
    },
    {
      metric: 'rate.achieved',
      label: 'Achieved rate',
      value: results.achieved.steadyStateRatePerUserPerMin.toFixed(3),
      raw: results.achieved.steadyStateRatePerUserPerMin,
      sub: `per user per min · requested ${results.requested.ratePerUserPerMin} · identity ${identityOk ? 'OK' : 'MISMATCH'}`,
      tone: identityOk ? 'neutral' : 'bad',
      na: false
    },
    bpPct === null
      ? {
          metric: 'backpressure.pct',
          label: 'Backpressure',
          value: 'n/a',
          raw: null,
          sub: 'no lap-start opportunities',
          tone: 'neutral',
          na: true,
          why: 'ticksOffered is 0'
        }
      : {
          metric: 'backpressure.pct',
          label: 'Backpressure',
          value: `${bpPct.toFixed(1)}%`,
          raw: bpPct,
          sub: `${results.achieved.skippedBackpressure} of ${offered} ticks skipped (SC13 gate 25%)`,
          tone: bpPct >= 25 ? 'bad' : 'neutral',
          na: false
        }
  ];
  for (const r of routes) {
    const lr = latencyRoutes.find((x) => x.route === r.key);
    const fb = fallbackRoutes.find((x) => x.route === r.key)?.ready ?? null;
    if (lr?.ready !== undefined && lr.ready !== null) {
      kpis.push({
        metric: `ready.p90.${r.key}`,
        label: `Ready wait p90, ${r.fromNetworkId ?? '?'}>${r.toNetworkId ?? '?'}`,
        value: fmtMsShort(lr.ready.p90),
        raw: lr.ready.p90,
        sub: `median ${fmtMsShort(lr.ready.median)} · n ${lr.ready.n}`,
        tone: 'neutral',
        na: false
      });
    } else if (fb !== null) {
      kpis.push({
        metric: `ready.p90.${r.key}`,
        label: `Ready wait p90, ${r.fromNetworkId ?? '?'}>${r.toNetworkId ?? '?'}`,
        value: fmtMsShort(fb.p90),
        raw: fb.p90,
        sub: `nearest-rank · n ${fb.n} (phases)`,
        tone: 'neutral',
        na: false
      });
    } else {
      kpis.push({
        metric: `ready.p90.${r.key}`,
        label: `Ready wait p90, ${r.fromNetworkId ?? '?'}>${r.toNetworkId ?? '?'}`,
        value: 'n/a',
        raw: null,
        sub: 'no completed hop on this route',
        tone: 'neutral',
        na: true,
        why: 'no completed hops on this route'
      });
    }
  }
  kpis.push(
    resources.peakRssMb === null
      ? {
          metric: 'rss.peak',
          label: 'Peak tool RSS',
          value: 'n/a',
          raw: null,
          sub: 'no resource samples',
          tone: 'neutral',
          na: true,
          why: 'no resource samples'
        }
      : {
          metric: 'rss.peak',
          label: 'Peak tool RSS',
          value: `${resources.peakRssMb.toFixed(0)} MB`,
          raw: resources.peakRssMb,
          sub: `${resources.samples} samples`,
          tone: 'neutral',
          na: false
        },
    resources.worstEventLoopMs === null
      ? {
          metric: 'eventloop.worst',
          label: 'Worst event-loop p99',
          value: 'n/a',
          raw: null,
          sub: 'not recorded',
          tone: 'neutral',
          na: true,
          why: 'no event-loop samples'
        }
      : {
          metric: 'eventloop.worst',
          label: 'Worst event-loop p99',
          value: `${resources.worstEventLoopMs.toFixed(0)} ms`,
          raw: resources.worstEventLoopMs,
          sub:
            eventLoopDisqualifiedAt === null
              ? 'SC7 not fired'
              : 'SC7 fired: tool-side latencies unreliable',
          tone: eventLoopDisqualifiedAt === null ? 'neutral' : 'bad',
          na: false
        },
    {
      metric: 'errors.total',
      label: 'Errors',
      value: String(nonSuppressedTotal),
      raw: nonSuppressedTotal,
      sub: 'non-suppressed, excluding warnings and tracker_not_ready',
      tone: nonSuppressedTotal > 0 ? 'bad' : 'good',
      na: false
    },
    leavesInWindow === null
      ? {
          metric: 'l1.leaves',
          label: 'L1 leaves in window',
          value: 'n/a',
          raw: null,
          sub: 'not sampled',
          tone: 'neutral',
          na: true,
          why: 'measurement.l1InfoTree was not configured'
        }
      : {
          metric: 'l1.leaves',
          label: 'L1 leaves in window',
          value: String(leavesInWindow),
          raw: leavesInWindow,
          sub: leavesFromPump === null ? '' : `${leavesFromPump} from the pump`,
          tone: 'neutral',
          na: false
        },
    rp === undefined
      ? {
          metric: 'pump.deposits',
          label: 'Pump deposits',
          value: 'OFF',
          raw: null,
          sub: 'not configured',
          tone: 'neutral',
          na: true,
          why: 'no pump block'
        }
      : {
          metric: 'pump.deposits',
          label: 'Pump deposits',
          value: String(rp.deposits.length),
          raw: rp.deposits.length,
          sub: `${weiToEth(rp.totalSpendWei).toFixed(6)} of ${weiToEth(rp.maxTotalSpendWei).toFixed(3)} ETH cap`,
          tone: 'neutral',
          na: false
        }
  );

  // ---- hop outcomes ----
  const byOutcome = Object.fromEntries(hopOutcomes);
  const allOutcomes = [
    ...new Set([
      ...hopOutcomes.map(([k]) => k),
      ...Object.values(results.hops.byRoute).flatMap((r) => Object.keys(r.byOutcome))
    ])
  ];
  const outcomeOrder = [
    ...OUTCOME_ORDER.filter((o) => allOutcomes.includes(o)),
    ...allOutcomes.filter((o) => !OUTCOME_ORDER.includes(o)).sort()
  ];
  const byRouteMode: ReportModel['hopOutcomes']['byRouteMode'] = [];
  for (const [route, modes] of Object.entries(results.hops.byRouteMode ?? {})) {
    for (const [mode, rel2] of Object.entries(modes)) {
      byRouteMode.push({
        route,
        mode,
        attempted: rel2.attempted,
        completed: rel2.completed,
        completionRate: rel2.completionRate
      });
    }
  }

  return {
    schema: 1,
    generator: { version: REPORT_GENERATOR_VERSION, generatedAt: input.generatedAt },
    identity: {
      runName: safe(input.runName),
      env: safe(String(config.env ?? 'unknown')),
      ringPath: ring.map((k) => `${k}${netOf(k) !== null ? ` (${netOf(k)})` : ''}`).join(' > '),
      startedAt: results.run.startedAt,
      endedAt: results.run.endedAt,
      durationMs: results.run.durationMs,
      requested: results.requested,
      toolVersion: results.run.toolVersion,
      meta: Object.fromEntries(
        Object.entries(meta).map(([k, v]) => [k, safe(String(v))])
      ) as RunMeta,
      neverStarted: results.run.startedAt === null
    },
    verdict,
    routes,
    kpis,
    throughput: {
      requested: results.requested,
      achieved: results.achieved,
      identityOk,
      gap: results.achieved.ticksOffered - results.achieved.ticksExpected,
      lapsByMode: results.laps.byMode,
      lapsStarted: results.achieved.lapStartsSubmitted
    },
    hopOutcomes: {
      byOutcome,
      byRoute: routeKeys
        .filter((r) => results.hops.byRoute[r] !== undefined)
        .map((route) => ({
          route,
          byOutcome: Object.fromEntries(
            Object.entries(results.hops.byRoute[route].byOutcome).map(([k, v]) => [k, v ?? 0])
          )
        })),
      byRouteMode,
      outcomeOrder
    },
    latency: {
      hasMeasurements,
      probeIntervalMs: msr?.probeIntervalMs ?? null,
      routes: latencyRoutes,
      phases,
      eventLoopDisqualifiedAt,
      fallbackRoutes
    },
    timeline,
    claimGas,
    gates: Object.entries(results.gates ?? {})
      .filter(([, g]) => g !== undefined)
      .map(([gate, g]) => ({ gate, ...(g as NonNullable<typeof g>) }))
      .sort((a, b) => b.totalMs - a.totalMs),
    errors,
    http: {
      rows: httpRows,
      uncontextedRequests: results.uncontextedRequests ?? 0,
      windows: httpWindows
    },
    resources,
    pump,
    stop,
    wallets: {
      balanceCharts,
      rows: walletRowsAll.slice(0, WALLET_ROW_CAP),
      totalWallets: walletRowsAll.length,
      rowsTruncated: walletRowsAll.length > WALLET_ROW_CAP
    },
    config: allowlistedConfigView(config, { pumpSender: results.pump?.sender }),
    environment: {
      toolVersion: results.run.toolVersion,
      sdkVersion: results.run.sdkVersion,
      host: results.run.host,
      gasTokenChains: Object.keys(results.gasTokenChains ?? {}),
      schemaVersion: results.schemaVersion,
      ndjson: {
        present: digest.present,
        lines: digest.lines,
        malformed: digest.malformed,
        truncatedTail: digest.truncatedTail
      }
    }
  };
};

/** A full 0x + 64 hex string has the shape of a private key, so the report only ever shows an abbreviation (the full hash is in results.json). */
export const abbreviateHash = (hash: string): string =>
  hash.length > 24 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;

const userNumber = (userId: string): number => {
  const m = /(\d+)$/.exec(userId);
  return m === null ? Number.NaN : Number.parseInt(m[1], 10);
};

export const fmtMsShort = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
  }
  return `${Math.floor(ms / 3_600_000)}h ${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`;
};

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set(['DONE', 'FAILED', 'ABORTED', 'TIMED_OUT']);
const MAX_LAP_ROWS = 400;
const MAX_DETAIL_ROWS = 200;
const SLOWEST_HOPS = 100;

const buildTimeline = (p: {
  digest: Digest;
  ring: string[];
  routeKeys: string[];
  t0: number | null;
  spanMs: number;
  results: ResultsJson;
  rel: (ts: number) => number;
}): TimelineModel => {
  const { digest, ring, routeKeys, t0, spanMs, results, rel } = p;
  const leaves =
    results.l1InfoTree?.leaves.map((l) => rel(Date.parse(l.ts))) ??
    digest.leaves.map((l) => rel(l.ts));
  const pumps =
    results.pump?.deposits.map((d) => rel(d.sentAt)) ?? digest.pump.deposits.map((d) => rel(d.ts));
  const plannedStop = results.requested.minutes * 60_000;
  const base = {
    spanMs,
    leaves,
    pumps,
    plannedStopAt: plannedStop > 0 && plannedStop < spanMs ? plannedStop : null
  };
  if (!digest.present) {
    return {
      mode: 'none',
      reason: 'activity.ndjson not found (output.activityLog false, or the file was not kept).',
      rows: [],
      area: [],
      laps: 0,
      rowsShown: 0,
      ...base
    };
  }
  if (digest.hops.size === 0 || t0 === null) {
    return {
      mode: 'none',
      reason: 'activity.ndjson holds no hop_state lines, so there is no timeline.',
      rows: [],
      area: [],
      laps: 0,
      rowsShown: 0,
      ...base
    };
  }
  const now = digest.lastTs ?? t0;
  const hops = [...digest.hops.values()].sort((a, b) => a.startTs - b.startTs);
  const lapsOrdered = [...digest.laps.values()].sort((a, b) => a.startTs - b.startTs);

  const hopSegments = (
    hop: (typeof hops)[number]
  ): { from: number; to: number; slot: number | 'crit'; open: boolean }[] => {
    const failed =
      hop.endTs !== null && hop.outcome !== null && !isSuccessOutcome(hop.outcome as Outcome);
    const segs: { from: number; to: number; slot: number | 'crit'; open: boolean }[] = [];
    hop.states.forEach(([ts, name], i) => {
      if (TERMINAL_STATES.has(name)) return;
      const next = hop.states[i + 1]?.[0] ?? hop.endTs ?? now;
      const slot = STATE_SLOT[name] ?? 0;
      segs.push({
        from: rel(ts),
        to: rel(Math.max(next, ts)),
        slot,
        open: hop.endTs === null && i === hop.states.length - 1
      });
    });
    if (failed && segs.length > 0) segs[segs.length - 1].slot = 'crit';
    return segs;
  };

  if (lapsOrdered.length <= MAX_LAP_ROWS) {
    const byLap = new Map<string, typeof hops>();
    for (const hop of hops) byLap.set(hop.lapId, [...(byLap.get(hop.lapId) ?? []), hop]);
    const rows: TimelineModel['rows'] = lapsOrdered.map((lap) => {
      const lapHops = (byLap.get(lap.lapId) ?? []).sort(
        (a, b) => (a.hopIndex ?? 0) - (b.hopIndex ?? 0) || a.startTs - b.startTs
      );
      const segments = lapHops.flatMap(hopSegments);
      const failed =
        lap.outcome === 'LAP_FAILED' ||
        lapHops.some(
          (h) => h.endTs !== null && h.outcome !== null && !isSuccessOutcome(h.outcome as Outcome)
        );
      const end = lap.endTs ?? now;
      return {
        label: lap.lapId,
        tip: safeTip(
          `${lap.lapId} (${lap.userId}) ${lap.outcome ?? 'in flight'}, ${Math.round((end - lap.startTs) / 1000)} s`
        ),
        failed,
        segments
      };
    });
    return {
      mode: 'rows',
      reason: '',
      rows,
      area: [],
      laps: lapsOrdered.length,
      rowsShown: rows.length,
      ...base
    };
  }

  // Above 400 laps: in-flight per route over time plus individual rows for failed and the slowest hops.
  const bin = Math.max(60_000, Math.ceil(spanMs / MAX_LAP_ROWS / 60_000) * 60_000);
  const bins = Math.max(1, Math.ceil(spanMs / bin) + 1);
  const area = routeKeys
    .map((route, slot) => {
      const diffs = new Array<number>(bins + 1).fill(0);
      for (const hop of hops) {
        if (routeOfHop(hop, ring) !== route) continue;
        const a = Math.min(bins, Math.max(0, Math.floor(rel(hop.startTs) / bin)));
        const b = Math.min(bins, Math.max(0, Math.floor(rel(hop.endTs ?? now) / bin)));
        diffs[a] += 1;
        diffs[b + 1] -= 1;
      }
      let level = 0;
      const buckets: Bucket[] = [];
      for (let i = 0; i < bins; i += 1) {
        level += diffs[i];
        buckets.push({ t: i * bin, min: level, max: level, mean: level, n: 1 });
      }
      return { route, slot, buckets };
    })
    .filter((a) => a.buckets.some((b) => b.max > 0));
  const failedHops = hops.filter(
    (h) => h.endTs !== null && h.outcome !== null && !isSuccessOutcome(h.outcome as Outcome)
  );
  const slowest = [...hops]
    .filter((h) => !failedHops.includes(h))
    .sort((a, b) => (b.endTs ?? now) - b.startTs - ((a.endTs ?? now) - a.startTs))
    .slice(0, SLOWEST_HOPS);
  const detail = [...failedHops, ...slowest]
    .slice(0, MAX_DETAIL_ROWS)
    .sort((a, b) => a.startTs - b.startTs);
  const rows: TimelineModel['rows'] = detail.map((hop) => ({
    label: hop.hopId,
    tip: safeTip(
      `${hop.hopId} ${hop.outcome ?? 'in flight'}, ${Math.round(((hop.endTs ?? now) - hop.startTs) / 1000)} s`
    ),
    failed: failedHops.includes(hop),
    segments: hopSegments(hop)
  }));
  return {
    mode: 'area',
    reason: `${lapsOrdered.length} laps (more than ${MAX_LAP_ROWS}): in-flight hops per route over time, plus every failed hop and the ${SLOWEST_HOPS} slowest.`,
    rows,
    area,
    laps: lapsOrdered.length,
    rowsShown: rows.length,
    ...base
  };
};

const safeTip = (text: string): string => clip(redactSecrets(text), 200);

// ---------------------------------------------------------------------------
// claim gas
// ---------------------------------------------------------------------------

const buildClaimGas = (
  results: ResultsJson,
  mHops: HopMeasurementRecord[]
): ReportModel['claimGas'] => {
  const msr = results.measurements;
  const hasMeasurements = msr !== undefined && mHops.length > 0;
  const rows = (msr?.claimGas ?? []).map((r) => ({
    toNetworkId: r.toNetworkId,
    claimKind: r.claimKind,
    n: r.n,
    gasMin: r.gasUsed.min,
    gasMedian: r.gasUsed.median,
    gasMax: r.gasUsed.max,
    priceMedian: r.effectiveGasPrice.median,
    feeMedian: r.totalFeeWei.median
  }));
  const mints = mHops.filter(
    (h) =>
      isSuccessOutcome(h.outcome) &&
      h.claim.claimKind === 'erc20_wrapped_mint' &&
      h.claim.gas !== null
  );
  const mintGas = mints.map((h) => Number(h.claim.gas?.gasUsed ?? 0)).filter((g) => g > 0);
  const mintMin = mintGas.length > 0 ? Math.min(...mintGas) : null;
  const withPre = mints.filter((h) => h.claim.preState !== undefined);
  let mintPreState: ReportModel['claimGas']['mintPreState'] = null;
  if (withPre.length > 0) {
    const groups = new Map<string, number[]>();
    for (const h of withPre) {
      const supplyZero = wei(h.claim.preState?.wrappedSupplyBefore) === BigInt(0);
      const balZero = wei(h.claim.preState?.recipientBalanceBefore) === BigInt(0);
      const label = `supply ${supplyZero ? 'zero' : 'nonzero'}, recipient balance ${balZero ? 'zero' : 'nonzero'} (observed)`;
      groups.set(label, [...(groups.get(label) ?? []), Number(h.claim.gas?.gasUsed ?? 0)]);
    }
    mintPreState = [...groups.entries()].map(([label, gas]) => {
      const d = dist(gas) as Dist;
      return { label, n: d.n, min: d.min, median: d.median, max: d.max };
    });
  }
  const buckets = new Map<number, number[]>();
  if (mintMin !== null) {
    for (const g of mintGas) {
      const k = Math.round((g - mintMin) / SSTORE_ZERO_TO_NONZERO_GAS);
      buckets.set(k, [...(buckets.get(k) ?? []), g]);
    }
  }
  const mintBuckets = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([k, g]) => ({ k, n: g.length, min: Math.min(...g), max: Math.max(...g) }));

  const bridgeByRoute = new Map<string, HopMeasurementRecord[]>();
  for (const h of mHops) {
    if (h.bridge.gas === null || !isSuccessOutcome(h.outcome)) continue;
    bridgeByRoute.set(h.hopRoute, [...(bridgeByRoute.get(h.hopRoute) ?? []), h]);
  }
  const bridgeGas = [...bridgeByRoute.entries()].map(([route, hs]) => {
    const gas = dist(hs.map((h) => Number(h.bridge.gas?.gasUsed ?? 0))) as Dist;
    const prices = hs.map((h) => Number(h.bridge.gas?.effectiveGasPrice ?? 0));
    return {
      route,
      n: gas.n,
      min: gas.min,
      median: gas.median,
      max: gas.max,
      priceMedian: String((dist(prices) as Dist).median)
    };
  });
  return {
    hasMeasurements,
    rows,
    mintGas,
    mintPreState,
    mintBuckets,
    mintMin,
    firstClaims: rows
      .filter((r) => r.claimKind === 'erc20_wrapper_deploy')
      .reduce((s, r) => s + r.n, 0),
    repeatClaims: rows
      .filter((r) => r.claimKind === 'erc20_wrapped_mint')
      .reduce((s, r) => s + r.n, 0),
    bridgeGas,
    approveGas: (msr?.approveGas ?? []).map((r) => ({
      networkId: r.networkId,
      n: r.n,
      gasMin: r.gasUsed.min,
      gasMedian: r.gasUsed.median,
      gasMax: r.gasUsed.max
    }))
  };
};

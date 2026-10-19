import type { Address, Hex } from 'viem';

// The `run` orchestrator — DESIGN's component map (§1) wired end to end:
// load+validate → preflight → (fund) → serve UI → build the user set →
// the scheduler (`core/scheduler.ts`) drives each user's `UserDriver`
// through the pure ring engine (`core/ring.ts`) → the collector
// (`metrics/collector.ts`) → the report (`metrics/report.ts`).
//
// `core/` stays pure and I/O-free (per its own module docs): this file is
// the ONE place that translates `core/ring.ts`'s `RingEmission`s and
// `Hop.phases`/`Hop.outcome` into `metrics/collector.ts` calls — the
// worked S08 throwaway harness
// (`/tmp/.../scratchpad/s08_retired_harness/__s08_manual_run.ts`) proved the
// phase/outcome half of this translation for one sequential lap per user;
// this file generalizes it to the real scheduler (concurrent laps per
// user, per asset, with backpressure) and adds the transition/gate/counter
// half DESIGN §6.2's ndjson kinds and §5.4's gate-stall table need.
//
// `cli.ts`'s `run` command owns ALL argv parsing (config path, --users/
// --browser/--rate/--minutes/--assets overrides, --fund,
// --i-know-this-is-mainnet, --out) and hands this module a single
// already-validated, already-overridden `LoadtestConfig` plus the asset
// indices to actually run rings for — this module is argv-agnostic.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { formatEther } from 'viem';

import type { LoadtestAsset, LoadtestConfig } from './config/schema';
import type { Clock, RingEmission, RingEngine } from './core/ring';
import type { AbortCause, InflightLookup, SchedulerDecision } from './core/scheduler';
import type { AssetKind, ErrorClass, Gate, Hop, HopSpec, Lap, ObservedRow } from './core/types';
import type {
  ClaimStageProbeResult,
  ClaimSubmission,
  DriverError,
  DriverMode,
  StageProbingDriver,
  TxStepResult,
  UserDriver
} from './core/userDriver';
import type { Collector, HostInfo, LapOutcome } from './metrics/collector';
import type { CorsRelayHandle } from './ui/corsRelay';
import type { ServeUiHandle } from './ui/serve';
import type { ChainClientFactory } from './wallets/chainClients';
import type { DerivedWallet } from './wallets/derive';
import type { GasTokenIdentity } from './wallets/preflight';
import type { L1Pump } from './workers/pump/l1Pump';

import { pumpWalletOverlap } from './config/schema';
import { createRingEngine, eventsFromBridge, eventsFromClaim, systemClock } from './core/ring';
import { createScheduler } from './core/scheduler';
import { createCollector, createFileActivitySink } from './metrics/collector';
import { ClassifiedFetchError, classifyError } from './metrics/errors';
import { deriveClaimKind } from './metrics/measurement';
import { writeReportFiles } from './metrics/report';
import {
  createL1InfoTreePoller,
  createPeriodicTask,
  createWalletBalanceSampler,
  l1InfoTreeClientFromViem
} from './metrics/samplers';
import { buildUi } from './ui/build';
import { startCorsRelay } from './ui/corsRelay';
import { serveUi } from './ui/serve';
import { defaultChainClientFactory } from './wallets/chainClients';
import { derivePumpAccount, deriveWallets } from './wallets/derive';
import { fundWallets } from './wallets/fund';
import { PreflightError, runPreflight } from './wallets/preflight';
import { redactError } from './wallets/redact';
import {
  BrowserCrashError,
  BrowserUser,
  WalletIdentityMismatchError
} from './workers/browser/browserUser';
import { BrowserPool } from './workers/browser/pool';
import { HeadlessUser } from './workers/headless/headlessUser';
import {
  buildChainKeyResolver,
  installTimingFetch,
  NON_TERMINAL_INTERVAL_MS
} from './workers/headless/uiCallset';
import { createL1Pump, pumpClientsFromViem } from './workers/pump/l1Pump';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Options / result
// ---------------------------------------------------------------------------

export interface RunLoadTestOptions {
  config: LoadtestConfig;
  // Indices into `config.assets` to actually run a ring for — S11's
  // `--assets eth,erc20` filter, computed by `cli.ts` (this module stays
  // argv-agnostic). Never empty.
  activeAssetIndices: readonly number[];
  // The ORIGINAL config file path (pre `--users`/`--rate`/... overrides) —
  // `buildUi` re-reads and re-parses it itself; none of the CLI overrides
  // this module accepts touch the fields `buildUi` cares about
  // (uiBaseUrl/aggkitProxyUrl/chains/ring/autoclaim), so the mismatch is
  // harmless.
  configPath: string;
  repoRoot: string;
  fund: boolean;
  mainnetConfirmed: boolean;
  outDir: string;
  logger?: (line: string) => void;
  /**
   * S53: viem client factory for the harness-side pump and samplers (the L1
   * deposit pump, wallet balances, L1 info tree). Defaults to the real one; a
   * test injects fakes. Preflight and the users keep their own wiring.
   */
  chainClientFactory?: ChainClientFactory;
}

export interface RunLoadTestResult {
  outDir: string;
  resultsPath: string;
  summaryPath: string;
  activityPath: string;
  aborted: boolean;
  abortCause: AbortCause | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const getToolVersion = (repoRoot: string): string => {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        version?: string;
      };
      return pkg.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
};

const getSdkVersion = (repoRoot: string): string => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.['@agglayer/sdk'] ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const getHostInfo = (): HostInfo => ({
  cores: os.cpus().length,
  totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
  platform: process.platform
});

const isUrlReachable = async (url: string): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const readProcRssMb = (pid: number): number => {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s*(\d+)\s*kB$/m.exec(status);
    return match ? Number(match[1]) / 1024 : 0;
  } catch {
    return 0;
  }
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const buildHopSpecs = (
  config: LoadtestConfig,
  assetIndex: number,
  gasTokenChains: Record<string, GasTokenIdentity> = {}
): HopSpec[] => {
  const asset = config.assets[assetIndex];
  if (asset === undefined) throw new Error(`buildHopSpecs: no asset at index ${assetIndex}`);
  const chainByKey = new Map(config.chains.map((chain) => [chain.key, chain]));
  const hops: HopSpec[] = [];
  for (let i = 0; i < config.ring.length - 1; i += 1) {
    const fromKey = config.ring[i];
    const toKey = config.ring[i + 1];
    const from = chainByKey.get(fromKey);
    const to = chainByKey.get(toKey);
    if (from === undefined || to === undefined) {
      throw new Error(
        `buildHopSpecs: ring references an unknown chain key ("${fromKey}"/"${toKey}")`
      );
    }
    const hopRoute = `${fromKey}->${toKey}`;
    const autoclaimEntry = config.autoclaim[hopRoute];
    if (autoclaimEntry === undefined) {
      throw new Error(`buildHopSpecs: no autoclaim entry for hop "${hopRoute}"`);
    }
    const fromGas = gasTokenChains[fromKey];
    const toGas = gasTokenChains[toKey];
    hops.push({
      hopIndex: i,
      hopRoute,
      fromChainKey: fromKey,
      toChainKey: toKey,
      fromNetworkId: from.networkId,
      toNetworkId: to.networkId,
      assetIndex,
      assetKind: asset.kind,
      assetAddress: asset.kind === 'erc20' ? (asset.address as Address) : undefined,
      ...(asset.kind === 'eth' && fromGas !== undefined
        ? { fromWethToken: fromGas.wethToken as Hex }
        : {}),
      ...(fromGas !== undefined || toGas !== undefined
        ? {
            expectedOrigin:
              asset.kind === 'eth'
                ? { networkId: 0, address: ZERO_ADDRESS as Hex }
                : {
                    networkId: asset.originNetworkId as number,
                    address: asset.address as Hex
                  }
          }
        : {}),
      amount: asset.amount,
      decimals: asset.decimals,
      autoclaim: autoclaimEntry.expected
        ? { expected: true, waitMs: autoclaimEntry.waitMs }
        : { expected: false }
    });
  }
  return hops;
};

// ---------------------------------------------------------------------------
// Emission / hop-completion translation (core/ring.ts -> metrics/collector.ts)
// ---------------------------------------------------------------------------

export interface LapRunCtx {
  engine: RingEngine;
  driver: UserDriver;
  userId: string;
  mode: DriverMode;
  clock: Clock;
  collector: Collector;
  getDrainDeadline: () => number | null;
  logger: (line: string) => void;
  /** S45: `config.assets` (to resolve a hop's token origin network). */
  assets: readonly LoadtestAsset[];
  /** S45 C2: `measurement.stageProbeIntervalMs`, or null when the probe is off. */
  stageProbeIntervalMs: number | null;
  /**
   * S53: true when `config.measurement` is present. Gates everything the heavy-load
   * measurements add to a hop (`tx_sent`/`tx_receipt` lines, the approve gas record),
   * so a config without it keeps byte-identical ndjson and `results.json`.
   */
  measurementEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Measurement (S45 C2/C3) — per-hop stash the runner fills while driving a hop
// and turns into one `hop_measurement` record at hop end. Observation only:
// nothing here feeds back into `core/` state transitions.
// ---------------------------------------------------------------------------

export interface HopMeasureState {
  /** S53 M8: the ERC-20 approve of this hop, when `driver.bridge` sent one. */
  approve?: TxStepResult | null;
  bridge: TxStepResult | null;
  depositCount: number | null;
  claim: ClaimSubmission | null;
  stages: ClaimStageProbeResult | null;
  probeAbort: AbortController | null;
}

const endTime = (step: TxStepResult | null | undefined): number | null =>
  step?.receipt != null ? step.receipt.timing.startedAt + step.receipt.timing.durationMs : null;

const sentTime = (step: TxStepResult | null | undefined): number | null =>
  step != null && step.txHash !== null ? step.submit.startedAt + step.submit.durationMs : null;

export const hopMeasurementRecord = (
  ctx: LapRunCtx,
  hop: Hop,
  lapId: string,
  st: HopMeasureState
) => {
  const spec = hop.spec;
  const asset = ctx.assets[spec.assetIndex];
  const tokenOriginNetworkId =
    spec.assetKind === 'erc20' && asset?.kind === 'erc20' ? asset.originNetworkId : undefined;
  const claimStep = st.claim?.claim ?? null;
  const claimGas = claimStep?.receipt?.gas ?? null;
  return {
    hopId: hop.id,
    lapId,
    userId: ctx.userId,
    mode: ctx.mode,
    hopRoute: spec.hopRoute,
    fromNetworkId: spec.fromNetworkId,
    toNetworkId: spec.toNetworkId,
    assetKind: spec.assetKind,
    assetIndex: spec.assetIndex,
    ...(tokenOriginNetworkId !== undefined ? { tokenOriginNetworkId } : {}),
    outcome: hop.outcome as NonNullable<Hop['outcome']>,
    depositCount: hop.depositCount ?? st.depositCount,
    bridge: {
      txHash: st.bridge?.txHash ?? hop.bridgeTxHash ?? null,
      blockNumber: st.bridge?.receipt?.gas?.blockNumber ?? null,
      minedObservedAt: endTime(st.bridge),
      gas: st.bridge?.receipt?.gas ?? null
    },
    ...(ctx.measurementEnabled === true && st.approve != null
      ? { approve: { txHash: st.approve.txHash, gas: st.approve.receipt?.gas ?? null } }
      : {}),
    stages: st.stages,
    readyObservedAt: hop.readyAt,
    claim: {
      txHash: claimStep?.txHash ?? hop.claimTxHash ?? null,
      blockNumber: claimGas?.blockNumber ?? null,
      sentAt: sentTime(claimStep),
      minedObservedAt: endTime(claimStep),
      gas: claimGas,
      claimKind: deriveClaimKind({
        assetKind: spec.assetKind,
        toNetworkId: spec.toNetworkId,
        tokenOriginNetworkId,
        claimStatus: claimStep?.receipt?.status ?? null,
        wrapperDeployed: claimGas?.wrapperDeployed,
        alreadyClaimed: st.claim?.isClaimedBefore === true || st.claim?.isClaimedRecheck === true
      }),
      ...(st.claim?.preState !== undefined ? { preState: st.claim.preState } : {})
    }
  };
};

/**
 * What the runner does with a failed `observeActivity()` poll. A transient
 * failure never fails the hop (the UI's own background poll would just retry
 * on its next interval) — only the ring timeouts can end a hop stuck polling.
 *
 * S53 (design F3): a failure that kept its class (`ClassifiedFetchError` — a
 * tracker non-2xx) is reported under THAT class, and the retry waits the UI's
 * own non-terminal cadence (5 s) instead of 1 s: at 1 s (plus the poller's own
 * 300 ms retries) a wallet whose poll is being refused polled several times
 * faster than a real user, exactly when the tracker was struggling.
 */
export const OBSERVE_ACTIVITY_DEFAULT_RETRY_MS = 1000;

export const classifyActivityPollError = (
  error: unknown
): { classified: { errorClass: ErrorClass; message: string }; retryAfterMs: number } => {
  if (error instanceof ClassifiedFetchError) {
    return {
      classified: { errorClass: error.errorClass, message: error.message },
      retryAfterMs: NON_TERMINAL_INTERVAL_MS
    };
  }
  return {
    classified: classifyError({ source: 'unknown', error }),
    retryAfterMs: OBSERVE_ACTIVITY_DEFAULT_RETRY_MS
  };
};

const reportDriverError = (
  ctx: Pick<LapRunCtx, 'collector' | 'userId' | 'mode'>,
  hopId: string,
  error: Pick<DriverError, 'message'> & Partial<Pick<DriverError, 'errorClass'>>
): void => {
  if (error.errorClass === undefined) return;
  ctx.collector.error({
    userId: ctx.userId,
    mode: ctx.mode,
    errorClass: error.errorClass,
    message: error.message,
    hopId
  });
};

// S58a M2: `SingleFlightPoller` rejects EVERY joined caller with the same error object, so
// one failed tracker fetch reached `reportDriverError` once per waiting hop of that wallet
// (16 laps in flight -> 16 `proxy_5xx` records, SC4 inflated). Remember the error instances
// already written; a joined hop still backs off, it just does not write the record again.
const reportedPollFailures = new WeakSet<object>();

/** Classifies a failed activity poll, writes ONE error record per failed fetch, returns the back-off. */
export const reportActivityPollError = (
  ctx: Pick<LapRunCtx, 'collector' | 'userId' | 'mode'>,
  hopId: string,
  error: unknown
): number => {
  const { classified, retryAfterMs } = classifyActivityPollError(error);
  const isObject = typeof error === 'object' && error !== null;
  if (!(isObject && reportedPollFailures.has(error))) {
    if (isObject) reportedPollFailures.add(error);
    reportDriverError(ctx, hopId, classified);
  }
  return retryAfterMs;
};

const reportEmbeddedErrors = (
  ctx: LapRunCtx,
  hopId: string,
  errors: readonly (DriverError | undefined)[]
): void => {
  for (const error of errors) {
    if (error !== undefined) reportDriverError(ctx, hopId, error);
  }
};

// S53 M7: `tx_sent` / `tx_receipt` ndjson lines from a driver result the runner
// already holds. Only called when `config.measurement` is present, so the SC5
// denominator (`count(tx_sent)`) exists for campaign runs and a config without a
// measurement block keeps byte-identical ndjson.
const emitTxEvents = (
  ctx: LapRunCtx,
  hopId: string,
  steps: readonly (readonly ['approve' | 'bridge' | 'claim', TxStepResult | null | undefined])[]
): void => {
  if (ctx.measurementEnabled !== true) return;
  for (const [step, result] of steps) {
    if (result === null || result === undefined || result.txHash === null) continue;
    ctx.collector.txSent({
      userId: ctx.userId,
      mode: ctx.mode,
      hopId,
      step,
      txHash: result.txHash
    });
    if (result.receipt !== null) {
      ctx.collector.txReceipt({
        userId: ctx.userId,
        mode: ctx.mode,
        hopId,
        step,
        status: result.receipt.status
      });
    }
  }
};

// Forwards one `advanceLap` step's emissions to the collector. `preHop` is
// the hop the emissions pertain to (captured BEFORE the call that produced
// them) — safe because `advanceLap` only ever advances ONE hop per call
// (§3.2's L1 only creates hop i+1 AFTER hop i reaches DONE, in the SAME
// call whose emissions still describe hop i).
const applyEmissions = (
  ctx: LapRunCtx,
  preHop: Hop,
  lapId: string,
  assetKind: AssetKind,
  emissions: readonly RingEmission[]
): void => {
  for (const emission of emissions) {
    switch (emission.type) {
      case 'transition':
        ctx.collector.hopState({
          userId: ctx.userId,
          mode: ctx.mode,
          hopId: preHop.id,
          lapId,
          from: emission.from,
          to: emission.to,
          transition: emission.transition
        });
        break;
      case 'phase':
        ctx.collector.recordPhase({
          phase: emission.phase,
          mode: ctx.mode,
          hopRoute: preHop.spec.hopRoute,
          assetKind,
          durationMs: emission.durationMs,
          censored: emission.censored
        });
        break;
      case 'counter':
        ctx.collector.recordHopCounter(emission.counter);
        break;
      case 'gate_exit':
        ctx.collector.recordGateVisit({
          gate: emission.gate,
          durationMs: emission.durationMs,
          timedOut: emission.timedOut
        });
        break;
      case 'gate_enter':
      case 'outcome':
      case 'secondary_timeout':
      case 'lap_transition':
        break;
      default:
        break;
    }
  }
};

// ---------------------------------------------------------------------------
// Browser-mode extras (`notifyLapCompleted`/`recover`) — not part of the
// mode-agnostic `UserDriver` interface, so accessed only via this guard.
// ---------------------------------------------------------------------------

interface BrowserCapableDriver extends UserDriver {
  notifyLapCompleted(recycleAfterLaps: number): Promise<void>;
  recover(): Promise<void>;
}

const isBrowserDriver = (mode: DriverMode, _driver: UserDriver): _driver is BrowserCapableDriver =>
  mode === 'browser';

const tryRecoverBrowser = async (
  mode: DriverMode,
  driver: UserDriver,
  userId: string,
  logger: (line: string) => void
): Promise<void> => {
  if (!isBrowserDriver(mode, driver)) return;
  try {
    await driver.recover();
  } catch (error) {
    logger(`recover() failed for ${userId}: ${redactError(error)}`);
  }
};

// ---------------------------------------------------------------------------
// Deadline racing — "race the driver promise against `hopDeadline`"
// ---------------------------------------------------------------------------

const effectiveDeadline = (
  lap: Lap,
  engine: RingEngine,
  drainDeadlineAt: number | null
): number => {
  const hop = lap.hops[lap.currentHopIndex];
  const phaseAt = engine.deadline(lap)?.at ?? Number.POSITIVE_INFINITY;
  const hopAt =
    hop !== undefined ? hop.startedAt + engine.timeouts.hopMs : Number.POSITIVE_INFINITY;
  const drainAt = drainDeadlineAt ?? Number.POSITIVE_INFINITY;
  return Math.min(phaseAt, hopAt, drainAt);
};

type RaceResult<T> = { timedOut: true } | { timedOut: false; value: T };

// Races `promise` against `deadlineAt`. If the deadline wins, the promise is
// abandoned (not cancelled — its eventual settlement is simply dropped by
// the caller, safe because `advanceLap`/`advanceHop` no-op on a terminal
// hop/lap). If `promise` rejects, the rejection propagates.
const raceOrTimeout = <T>(
  promise: Promise<T>,
  deadlineAt: number,
  clock: Clock
): Promise<RaceResult<T>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const msLeft = Math.max(0, deadlineAt - clock.now());
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, msLeft);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });

// ---------------------------------------------------------------------------
// Per-lap execution — drives ONE lap (one user, one asset ring, one
// traversal) from PLANNED to a terminal `Lap.state`, applying every
// `RingAction` `core/ring.ts` asks for and translating every emission.
// `core/` owns every transition and timeout; this loop holds none.
// ---------------------------------------------------------------------------

interface Cell {
  lap: Lap;
}

const runLapToCompletion = async (params: { ctx: LapRunCtx; cell: Cell }): Promise<Lap> => {
  const { ctx, cell } = params;
  const { engine, driver, userId, mode, clock, collector } = ctx;
  let lap = cell.lap;

  const lastRowByHopId = new Map<string, ObservedRow>();
  const reportedHopIds = new Set<string>();
  const measureByHopId = new Map<string, HopMeasureState>();
  const measureState = (hopId: string): HopMeasureState => {
    let st = measureByHopId.get(hopId);
    if (st === undefined) {
      st = { bridge: null, depositCount: null, claim: null, stages: null, probeAbort: null };
      measureByHopId.set(hopId, st);
    }
    return st;
  };

  // S45 C2: background stage probe, headless only, started right after a
  // successful bridge receipt. Stops at claim-proof available, hop terminal,
  // or the hop deadline.
  const startStageProbe = (hop: Hop, depositCount: number): void => {
    const intervalMs = ctx.stageProbeIntervalMs;
    const probing = driver as Partial<StageProbingDriver>;
    if (intervalMs === null || mode !== 'headless') return;
    if (typeof probing.probeClaimStages !== 'function') return;
    const st = measureState(hop.id);
    if (st.probeAbort !== null) return;
    const abort = new AbortController();
    st.probeAbort = abort;
    void probing
      .probeClaimStages({
        sourceNetwork: hop.spec.fromNetworkId,
        destinationNetwork: hop.spec.toNetworkId,
        depositCount,
        intervalMs,
        deadlineAt: hop.startedAt + engine.timeouts.hopMs,
        signal: abort.signal,
        onProgress: (partial) => {
          st.stages = partial;
        }
      })
      .catch(() => undefined);
  };

  const applyStep = (step: { lap: Lap; emissions: RingEmission[] }, preHop: Hop): void => {
    lap = step.lap;
    cell.lap = lap;
    applyEmissions(ctx, preHop, lap.id, preHop.spec.assetKind, step.emissions);
    for (const h of lap.hops) {
      if (h.outcome !== null && !reportedHopIds.has(h.id)) {
        collector.hopEnd({
          userId,
          mode,
          hopId: h.id,
          lapId: lap.id,
          hopRoute: h.spec.hopRoute,
          outcome: h.outcome
        });
        reportedHopIds.add(h.id);
        const st = measureState(h.id);
        st.probeAbort?.abort();
        collector.hopMeasurement(hopMeasurementRecord(ctx, h, lap.id, st));
      }
    }
  };

  while (lap.state === 'LAP_RUNNING') {
    const drainDeadlineAt = ctx.getDrainDeadline();
    const drainArg = drainDeadlineAt !== null ? { deadlineAt: drainDeadlineAt } : undefined;

    const preTickHop = lap.hops[lap.currentHopIndex];
    if (preTickHop === undefined) break;

    // Tick-check first on every iteration: this is what catches phase/hop/
    // drain timeouts even while no driver call is in flight (DESIGN §3.2's
    // T28/T29 and every per-phase timeout are pure clock advances).
    applyStep(engine.apply(lap, { kind: 'tick' }, drainArg), preTickHop);
    if (lap.state !== 'LAP_RUNNING') break;

    const action = engine.action(lap);
    const hop = lap.hops[lap.currentHopIndex];
    if (hop === undefined) break;

    switch (action.kind) {
      case 'bridge': {
        const deadlineAt = effectiveDeadline(lap, engine, drainDeadlineAt);
        try {
          const raced = await raceOrTimeout(driver.bridge(hop.spec), deadlineAt, clock);
          if (raced.timedOut) break; // next loop's tick-check catches the real timeout
          // VALIDATION-1.md A8: `bridgeEventDecodeError` is a DIAGNOSTIC
          // only — it does not change `eventsFromBridge`'s ring processing
          // below (T11 still fires exactly as it did), it just makes sure
          // the underlying cause is reported instead of silently swallowed.
          reportEmbeddedErrors(ctx, hop.id, [
            raced.value.approve?.error,
            raced.value.bridge?.error,
            raced.value.bridgeEventDecodeError
          ]);
          {
            const st = measureState(hop.id);
            st.approve = raced.value.approve;
            st.bridge = raced.value.bridge;
            st.depositCount = raced.value.depositCount;
            emitTxEvents(ctx, hop.id, [
              ['approve', raced.value.approve],
              ['bridge', raced.value.bridge]
            ]);
            if (
              raced.value.bridge?.receipt?.status === 'success' &&
              raced.value.depositCount !== null
            ) {
              startStageProbe(hop, raced.value.depositCount);
            }
          }
          applyStep(engine.applyAll(lap, eventsFromBridge(raced.value), drainArg), hop);
        } catch (error) {
          if (error instanceof BrowserCrashError) {
            reportDriverError(ctx, hop.id, { errorClass: 'browser_crash', message: error.message });
            applyStep(
              engine.apply(
                lap,
                {
                  kind: 'browser_crash',
                  error: { message: error.message, errorClass: 'browser_crash' }
                },
                drainArg
              ),
              hop
            );
            void tryRecoverBrowser(mode, driver, userId, ctx.logger);
          } else {
            const classified = classifyError({ source: 'unknown', error });
            reportDriverError(ctx, hop.id, classified);
            applyStep(
              engine.apply(
                lap,
                { kind: 'submit_error', step: 'bridge', error: classified },
                drainArg
              ),
              hop
            );
          }
        }
        break;
      }
      case 'claim': {
        const row = lastRowByHopId.get(hop.id);
        if (row === undefined) {
          // Should never happen — CLAIM_BUILD is only entered once a row has
          // already been matched via `observe_activity`. Defensive: fail
          // this hop with a classified internal error rather than letting
          // an exception escape the lap task.
          const classified = classifyError({
            source: 'unknown',
            error: new Error(`no observed row cached for hop ${hop.id} at claim time`)
          });
          reportDriverError(ctx, hop.id, classified);
          applyStep(
            engine.apply(lap, { kind: 'submit_error', step: 'claim', error: classified }, drainArg),
            hop
          );
          break;
        }
        const deadlineAt = effectiveDeadline(lap, engine, drainDeadlineAt);
        try {
          const raced = await raceOrTimeout(driver.claim(hop.spec, row), deadlineAt, clock);
          if (raced.timedOut) break;
          reportEmbeddedErrors(ctx, hop.id, [raced.value.claim?.error]);
          {
            const st = measureState(hop.id);
            if (raced.value.claim !== null || st.claim === null) st.claim = raced.value;
            emitTxEvents(ctx, hop.id, [['claim', raced.value.claim]]);
          }
          applyStep(engine.applyAll(lap, eventsFromClaim(raced.value), drainArg), hop);
        } catch (error) {
          if (error instanceof BrowserCrashError) {
            reportDriverError(ctx, hop.id, { errorClass: 'browser_crash', message: error.message });
            applyStep(
              engine.apply(
                lap,
                {
                  kind: 'browser_crash',
                  error: { message: error.message, errorClass: 'browser_crash' }
                },
                drainArg
              ),
              hop
            );
            void tryRecoverBrowser(mode, driver, userId, ctx.logger);
          } else {
            const classified = classifyError({ source: 'unknown', error });
            reportDriverError(ctx, hop.id, classified);
            applyStep(
              engine.apply(
                lap,
                { kind: 'submit_error', step: 'claim', error: classified },
                drainArg
              ),
              hop
            );
          }
        }
        break;
      }
      case 'observe_activity': {
        const deadlineAt = effectiveDeadline(lap, engine, drainDeadlineAt);
        try {
          const raced = await raceOrTimeout(driver.observeActivity(), deadlineAt, clock);
          if (raced.timedOut) break;
          const rows = raced.value;
          if (hop.rowKey !== null) {
            const match = rows.find((row) => row.rowKey === hop.rowKey);
            if (match) lastRowByHopId.set(hop.id, match);
          }
          applyStep(engine.apply(lap, { kind: 'activity', rows }, drainArg), hop);
        } catch (error) {
          if (error instanceof BrowserCrashError) {
            reportDriverError(ctx, hop.id, { errorClass: 'browser_crash', message: error.message });
            applyStep(
              engine.apply(
                lap,
                {
                  kind: 'browser_crash',
                  error: { message: error.message, errorClass: 'browser_crash' }
                },
                drainArg
              ),
              hop
            );
            void tryRecoverBrowser(mode, driver, userId, ctx.logger);
          } else {
            // A transient poll failure does not fail the hop (the UI's own
            // background poll would just retry on its next interval too) —
            // only the existing ring timeouts (checked every loop iteration
            // above) can end a hop that is stuck polling.
            await sleep(reportActivityPollError(ctx, hop.id, error));
          }
        }
        break;
      }
      case 'awaiting_driver':
      case 'none':
      default:
        await sleep(200);
        break;
    }
  }

  for (const st of measureByHopId.values()) st.probeAbort?.abort();
  return lap;
};

/**
 * ` pump=on(<settled>/<planned>,<spend>ETH)` for the status line. The plan is the deposits the
 * run duration allows; the pump keeps firing during the drain (S58a L9), so once more have settled
 * than planned the plan follows the count instead of reading e.g. `20/13`.
 */
export const pumpStatusSuffix = (
  settledDeposits: number,
  committedWei: bigint,
  durationMinutes: number,
  intervalSeconds: number
): string => {
  const planned = Math.max(
    Math.floor((durationMinutes * 60) / intervalSeconds) + 1,
    settledDeposits
  );
  return ` pump=on(${settledDeposits}/${planned},${formatEther(committedWei)}ETH)`;
};

// ---------------------------------------------------------------------------
// S53: harness-side workers (heavy-load design §1.3/§1.4) — the L1 deposit pump
// and the periodic samplers. All optional: with no `pump` block and no matching
// `measurement` field nothing is created, nothing is scheduled and the run is
// exactly what it was before.
// ---------------------------------------------------------------------------

interface HarnessWorkers {
  /** Starts the L1 poller (baseline first), then the pump, then the periodic samplers. */
  start(): Promise<void>;
  /** Normal end: stops the pump (bounded receipt wait) and the samplers, then takes a last L1 poll and HTTP window. */
  stop(): Promise<void>;
  /** Failure path: stops everything without waiting for a receipt or taking final samples. */
  abort(): Promise<void>;
  /** ` pump=on(<settled>/<planned>,<spend>ETH)` for the status line, or '' when there is no pump. */
  statusSuffix(): string;
}

const createHarnessWorkers = (params: {
  config: LoadtestConfig;
  wallets: readonly DerivedWallet[];
  collector: Collector;
  clock: Clock;
  logger: (line: string) => void;
  chainClientFactory: ChainClientFactory;
}): HarnessWorkers => {
  const { config, wallets, collector, clock, logger, chainClientFactory } = params;
  const measurement = config.measurement;
  type RunChain = LoadtestConfig['chains'][number];
  const chainByKey = new Map(config.chains.map((chain) => [chain.key, chain]));
  const l1Chain = config.chains.find((chain) => chain.networkId === 0);
  const clientSets = new Map<string, ReturnType<ChainClientFactory>>();
  const setFor = (chain: RunChain) => {
    let set = clientSets.get(chain.key);
    if (set === undefined) {
      set = chainClientFactory(chain);
      clientSets.set(chain.key, set);
    }
    return set;
  };

  let pump: L1Pump | null = null;
  if (config.pump?.enabled === true) {
    const pumpConfig = config.pump;
    const chain = chainByKey.get(pumpConfig.chainKey);
    if (chain === undefined) {
      throw new Error(`pump.chainKey "${pumpConfig.chainKey}" is not a chain`);
    }
    const account = derivePumpAccount(config);
    pump = createL1Pump({
      chain,
      sender: account.address,
      pump: pumpConfig,
      clients: pumpClientsFromViem(setFor(chain), account),
      collector,
      clock,
      receiptTimeoutMs: config.timeouts.txReceiptMs,
      logger
    });
  }

  const tasks: ReturnType<typeof createPeriodicTask>[] = [];
  let l1Poller: ReturnType<typeof createL1InfoTreePoller> | null = null;
  let lastWindowAt = clock.now();
  let finished = false;

  const flushWindow = (): void => {
    const now = clock.now();
    collector.flushHttpWindow(now - lastWindowAt);
    lastWindowAt = now;
  };

  return {
    async start() {
      lastWindowAt = clock.now();
      if (measurement?.l1InfoTree !== undefined && l1Chain !== undefined) {
        const { pollIntervalMs, gerManagerAddress } = measurement.l1InfoTree;
        const poller = createL1InfoTreePoller({
          bridgeAddress: l1Chain.bridgeAddress as Address,
          ...(gerManagerAddress !== undefined
            ? { gerManagerAddress: gerManagerAddress as Address }
            : {}),
          client: l1InfoTreeClientFromViem(setFor(l1Chain).public),
          collector,
          isPumpTx: (txHash) => pump?.isPumpTx(txHash) ?? false,
          logger
        });
        l1Poller = poller;
        // The baseline (GER manager, leaf count, head) is taken BEFORE the pump's
        // first deposit, so that deposit's leaf cannot fall before the cursor.
        await poller.pollOnce();
        tasks.push(
          createPeriodicTask({
            intervalMs: pollIntervalMs,
            run: poller.pollOnce,
            label: 'l1 info tree poller',
            logger
          })
        );
      }
      pump?.start();
      if (measurement?.walletBalanceIntervalMs !== undefined) {
        const ringChainKeys = [...new Set(config.ring.slice(0, -1))];
        const sampler = createWalletBalanceSampler({
          chains: config.chains.filter(
            (chain) => ringChainKeys.includes(chain.key) && chain.networkId !== 0
          ),
          wallets: wallets.map((wallet) => ({ userId: wallet.userId, address: wallet.address })),
          readerFor: (chainKey) => setFor(chainByKey.get(chainKey) as RunChain).public,
          collector,
          logger
        });
        tasks.push(
          createPeriodicTask({
            intervalMs: measurement.walletBalanceIntervalMs,
            run: sampler.sampleOnce,
            immediate: true,
            label: 'wallet balance sampler',
            logger
          })
        );
      }
      if (measurement?.httpWindowMs !== undefined) {
        tasks.push(
          createPeriodicTask({
            intervalMs: measurement.httpWindowMs,
            run: async () => flushWindow(),
            label: 'http window',
            logger
          })
        );
      }
      tasks.forEach((task) => task.start());
    },

    async stop() {
      if (finished) return;
      finished = true;
      await pump?.stop();
      await Promise.all(tasks.map((task) => task.stop()));
      // A last poll (no overlap now: the periodic one has stopped) picks up the
      // leaf of the final deposit, and the last partial window is flushed.
      await l1Poller?.pollOnce();
      if (measurement?.httpWindowMs !== undefined) flushWindow();
    },

    async abort() {
      if (finished) return;
      finished = true;
      await pump?.stop({ waitForReceipt: false });
      await Promise.all(tasks.map((task) => task.stop()));
    },

    statusSuffix() {
      if (pump === null || config.pump === undefined) return '';
      const { settledDeposits, committedWei } = pump.progress();
      return pumpStatusSuffix(
        settledDeposits,
        committedWei,
        config.load.durationMinutes,
        config.pump.intervalSeconds
      );
    }
  };
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

interface UserRuntime {
  userId: string;
  mode: DriverMode;
  driver: UserDriver;
  cellsByAsset: Cell[][];
  lapCounterByAsset: number[];
}

// R0 (loadtest/REVIEW.md, CRITICAL): the ONLY confirmation gate used to be
// `wallets/fund.ts`'s `MAINNET_CONFIRMATION_REQUIRED`, reached only
// `if (options.fund)` — so `run` against an already-funded mainnet config
// broadcast a full load test (real bridge transactions on real mainnet)
// with NO confirmation and NO dry-run. This duplicates the gate so `run`
// itself refuses unconditionally, independent of `--fund`. Exported so a
// test can assert on the error type without string-matching the message.
export class MainnetConfirmationRequiredError extends Error {}

/**
 * S58a M6: a SIGINT listener for the WHOLE run. tsx's child preflight exits the process
 * (code 130) the moment no SIGINT listener exists, so a listener held only around the main loop
 * meant that `stop --drain` during the 1-5 min of preflight / harness start-up, or while the
 * report is written after the loop, killed the run with no `results.json` and no report.
 *
 * - before `attach`: SIGINTs are counted, and `attach` returns how many so the caller can
 *   replay them as drain requests the moment the main loop exists ("stop before start");
 * - between `attach` and `detach`: the main loop's own handler runs;
 * - after `detach`: the run is already stopping, a SIGINT is only logged.
 */
const createSigintGuard = (logger: (line: string) => void) => {
  let early = 0;
  let handler: (() => void) | null = null;
  let loopOver = false;
  const onSignal = (): void => {
    if (handler !== null) {
      handler();
    } else if (loopOver) {
      logger('SIGINT received while the run is already stopping (writing the report); ignored');
    } else {
      early += 1;
      logger(
        `SIGINT received before the main loop started (${early}); the run drains as soon as it starts`
      );
    }
  };
  process.on('SIGINT', onSignal);
  return {
    attach(loopHandler: () => void): number {
      handler = loopHandler;
      return early;
    },
    detach(): void {
      handler = null;
      loopOver = true;
    },
    dispose(): void {
      process.off('SIGINT', onSignal);
    }
  };
};
type SigintGuard = ReturnType<typeof createSigintGuard>;

export const runLoadTest = async (options: RunLoadTestOptions): Promise<RunLoadTestResult> => {
  // R16 (loadtest/REVIEW.md): see `runLoadTestWith`.
  const logger = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  const guard = createSigintGuard(logger);
  try {
    return await runLoadTestWith(options, guard);
  } finally {
    guard.dispose();
  }
};

const runLoadTestWith = async (
  options: RunLoadTestOptions,
  guard: SigintGuard
): Promise<RunLoadTestResult> => {
  const { config, activeAssetIndices, configPath, repoRoot, outDir } = options;
  // R16 (loadtest/REVIEW.md): a silent no-op default meant a caller that
  // simply omitted `logger` (any programmatic embedder, not `cli.ts`'s own
  // shipped path, which always passes one) lost every diagnostic — INCLUDING
  // `run: fatal error, draining: ...`. Default to stderr instead, so silence
  // requires an explicit opt-in (`logger: () => {}`), not an omission.
  const logger = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (activeAssetIndices.length === 0) throw new Error('run: activeAssetIndices must not be empty');

  // R0: checked FIRST, before any wallet derivation, funding, preflight or
  // driver work — `run` must refuse a mainnet config outright, not just
  // when `--fund` also happens to be set.
  if (config.env === 'mainnet' && options.mainnetConfirmed !== true) {
    throw new MainnetConfirmationRequiredError(
      'MAINNET_CONFIRMATION_REQUIRED: run refuses to execute against env "mainnet" without --i-know-this-is-mainnet. ' +
        'This gates the load test itself (real bridge transactions from real funded wallets), not just `fund` — ' +
        'see loadtest/REVIEW.md R0.'
    );
  }

  // S53: the schema already refuses a pump wallet inside the user range, but
  // `--users` is applied after parsing and can grow that range over the pump
  // index — re-check with the FINAL user count, before any wallet is derived or
  // funded, so the pump can never share a wallet with a user.
  if (config.pump?.enabled === true) {
    const overlap = pumpWalletOverlap(config.users, config.pump);
    if (overlap !== null) throw new Error(`PUMP_WALLET_OVERLAPS_USERS: ${overlap}`);
  }

  const clock: Clock = systemClock;

  // --- wallets / funding / preflight (pre-run setup; not part of the
  // load-test timeline the collector measures) ---------------------------
  const wallets: DerivedWallet[] = deriveWallets(config);

  // `fundWallets`/`runPreflight` iterate `config.assets` unconditionally —
  // scope them to just the assets `--assets` selected, so e.g. `--assets
  // eth` on a config that also declares an erc20 asset never demands an
  // erc20 balance/allowance for an asset this run will never bridge.
  // `deriveWallets` above intentionally still sees the FULL config (asset
  // selection has no bearing on wallet derivation).
  const scopedConfig: LoadtestConfig = {
    ...config,
    assets: activeAssetIndices.map((index) => config.assets[index])
  };

  if (options.fund) {
    const fundResult = await fundWallets({
      config: scopedConfig,
      wallets,
      mainnetConfirmed: options.mainnetConfirmed,
      logger
    });
    logger(
      `fund: env=${fundResult.env} strategy=${fundResult.strategy} users=${wallets.length} duration=${fundResult.durationMs}ms`
    );
  }

  const preflight = await runPreflight({ config: scopedConfig, wallets });
  logger(preflight.table);
  if (!preflight.ok) {
    const [first, ...rest] = preflight.failures;
    const restNote = rest.length > 0 ? ` (+${rest.length} more failure(s))` : '';
    throw new PreflightError(`preflight failed: ${first.code}: ${first.message}${restNote}`);
  }
  logger('preflight: all checks passed.');

  // SD5: gas-token chains are headless-only — the UI build has no WETH
  // currency entry for them, so browser users would bridge the native token.
  if (config.users.browser > 0 && Object.keys(preflight.gasTokenChains).length > 0) {
    throw new Error(
      `BROWSER_GAS_TOKEN_UNSUPPORTED: users.browser=${config.users.browser} but ring chain(s) ${Object.keys(preflight.gasTokenChains).join(', ')} are gas-token chains — run headless only (--browser 0)`
    );
  }

  fs.mkdirSync(outDir, { recursive: true });

  // --- UI build/serve (browser mode only, and only if not already served) ---
  let uiHandle: ServeUiHandle | null = null;
  let corsRelay: CorsRelayHandle | null = null;
  if (config.users.browser > 0) {
    if (config.uiBaseUrl === undefined) {
      throw new Error('run: users.browser > 0 requires uiBaseUrl in the config');
    }
    const reachable = await isUrlReachable(config.uiBaseUrl);
    if (reachable) {
      if (config.browser.corsRelay === true) {
        throw new Error(
          `run: browser.corsRelay is enabled but a UI is already being served at ${config.uiBaseUrl}; ` +
            'the relay URL is baked into a UI build made by this run, so it cannot be applied to an existing server. ' +
            'Stop that server (or change uiBaseUrl) and let the run build and serve the UI itself.'
        );
      }
      logger(`run: UI already reachable at ${config.uiBaseUrl}, not building/serving`);
    } else {
      if (config.browser.corsRelay === true) {
        corsRelay = await startCorsRelay({
          upstreamUrl: config.aggkitProxyUrl,
          allowedOrigins: [new URL(config.uiBaseUrl).origin],
          logger
        });
      }
      try {
        logger(`run: building UI for ${config.uiBaseUrl}...`);
        const built = await buildUi({
          configPath,
          repoRoot,
          aggkitProxyUrlOverride: corsRelay?.url
        });
        uiHandle = await serveUi({ outDir: built.outDir, uiBaseUrl: config.uiBaseUrl });
        logger(`run: serving UI at ${uiHandle.url}`);
      } catch (error) {
        // The relay's listener would otherwise keep the process alive after a failed build.
        await corsRelay?.close().catch(() => undefined);
        throw error;
      }
    }
  }

  // --- collector -----------------------------------------------------------
  const activitySink = config.output.activityLog
    ? createFileActivitySink(path.join(outDir, 'activity.ndjson'))
    : null;
  const collector = createCollector({ clock, activitySink });
  // R14 (loadtest/REVIEW.md): `installTimingFetch` returns an uninstall
  // handle specifically so `globalThis.fetch` doesn't stay monkey-patched
  // (and the collector reachable through its closure) past this run —
  // captured and called in `disposeEverything` below.
  // S53 F1: RPC traffic is named `rpc/<CHAIN_KEY>/<method>`, never by the URL's
  // last path segment (which is the API key for a keyed provider URL).
  const uninstallTimingFetch = installTimingFetch(collector, clock, {
    resolveChainKey: buildChainKeyResolver(config.chains)
  }).uninstall;

  let browserPool: BrowserPool | null = null;
  let harness: HarnessWorkers | null = null;
  let fatalError: unknown = null;
  // Guards `browserPool.dispose()` / `uiHandle.close()` / `collector.close()`
  // against running twice — the success path calls it once before
  // (possibly) rethrowing `fatalError`, and the outer catch below calls it
  // again for any error raised BEFORE that point (e.g. while still building
  // the user set); without the guard a 'fatal'-cause run would double-close
  // the ndjson file descriptor (`fs.closeSync` on an already-closed fd
  // throws) once through the success path and again via the rethrow.
  let disposed = false;
  // S16/A5: a real, always-on event-loop-lag histogram — see `sampleResources`
  // and its doc comment below.
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  const disposeEverything = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    eventLoopDelay.disable();
    // S53: a failure path never waits for a pump receipt or takes final samples.
    await harness?.abort().catch((error: unknown) => {
      logger(`run: harness workers abort failed: ${redactError(error)}`);
    });
    if (browserPool) {
      await browserPool
        .dispose()
        .catch((error: unknown) =>
          logger(`run: browser pool dispose failed: ${redactError(error)}`)
        );
    }
    if (uiHandle) {
      await uiHandle
        .close()
        .catch((error: unknown) => logger(`run: UI server close failed: ${redactError(error)}`));
    }
    if (corsRelay) {
      await corsRelay
        .close()
        .catch((error: unknown) => logger(`run: CORS relay close failed: ${redactError(error)}`));
    }
    try {
      uninstallTimingFetch();
    } catch {
      // best-effort — never block teardown on this
    }
    try {
      collector.close();
    } catch {
      // already closed
    }
  };

  try {
    // --- build the user set: first `users.browser` in the browser pool,
    // the rest headless (DESIGN §1's component map / S11 goal text). -------
    const browserWallets = wallets.slice(0, config.users.browser);
    const headlessWallets = wallets.slice(config.users.browser);

    // S16/A5 (VALIDATION-1.md): every headless user's driver loop runs on
    // THIS one Node event loop (`workers/headless/headlessUser.ts` does no
    // I/O off-thread) — a 100-headless-user run measured `toolCpuPct` p50
    // 101.4%/max 129.8% on a 64-core host, which invalidated that run's own
    // HTTP latency percentiles (a saturated loop delays when a resolved
    // promise's continuation runs, which the timing wrapper counts as part
    // of the request). True fixes are either genuine multi-process sharding
    // (`os.availableParallelism()`-sized worker processes, each with its
    // own collector, aggregated by the parent — not implemented: it needs
    // an inter-process collector-aggregation protocol this tool does not
    // have yet, and is deferred to S17, which is what will also establish
    // the empirically-supported per-process headless-user ceiling this
    // constant currently only guesses at) or running fewer headless users
    // per `run` invocation (partition `users.wallets.startIndex` across
    // multiple invocations). Neither is enforced here — this is the
    // "document" half of that fix; the "enforce" half is real-time, below:
    // `sampleResources()` measures actual event-loop lag every interval
    // (`perf_hooks.monitorEventLoopDelay`) and `metrics/report.ts`
    // self-disqualifies the run's own latency percentiles once it sees the
    // loop was genuinely backed up, rather than this guessing a headcount
    // threshold up front.
    const RECOMMENDED_MAX_HEADLESS_USERS_PER_PROCESS = 50;
    if (headlessWallets.length > RECOMMENDED_MAX_HEADLESS_USERS_PER_PROCESS) {
      logger(
        `run: WARNING — ${headlessWallets.length} headless users on one process exceeds the recommended ` +
          `${RECOMMENDED_MAX_HEADLESS_USERS_PER_PROCESS} (VALIDATION-1.md A5: 100 headless users saturated a single ` +
          `Node event loop and invalidated that run's own HTTP latency numbers). Watch this run's Resources section ` +
          `(eventLoopDelayP99Ms) and the report's latency-percentile disqualification note; consider fewer headless ` +
          `users per invocation until multi-process sharding lands.`
      );
    }

    if (browserWallets.length > 0) {
      browserPool = new BrowserPool({
        users: browserWallets.map((w) => ({ userId: w.userId, privateKey: w.privateKey })),
        contextsPerBrowser: config.browser.contextsPerBrowser,
        headless: config.browser.headless,
        baseUrl: config.uiBaseUrl,
        onCrash: (event) => logger(`browser pool: ${event.userId} ${event.kind}: ${event.message}`)
      });
      await browserPool.launch();
    }

    const rawUsers: UserRuntime[] = [
      ...browserWallets.map((w) => ({
        userId: w.userId,
        mode: 'browser' as const,
        driver: new BrowserUser({
          userId: w.userId,
          privateKey: w.privateKey,
          // Non-null: only constructed inside the `browserWallets.length > 0`
          // branch, where `browserPool` was just assigned and `launch()`ed.
          pool: browserPool as BrowserPool,
          chains: config.chains,
          assets: config.assets,
          // The browser driver polls tracker activity from inside the page, so with
          // the CORS relay on it must use the relay (the page's own proxy URL), not
          // the real proxy the page origin is not allowed to read.
          aggkitProxyUrl: corsRelay?.url ?? config.aggkitProxyUrl,
          collector,
          clock,
          pageLoadMs: config.timeouts.pageLoadMs,
          walletConnectMs: config.timeouts.walletConnectMs,
          // Align the driver's OWN internal UI-wait bounds with the ring's
          // configured timeouts — otherwise `BrowserUser`'s defaults
          // (60s/150s) would give up on a bridge/claim well before the
          // configured `txReceiptMs`/`claimedMs` (devnet: 60s/900s), making
          // browser mode fail hops the ring itself would still be willing
          // to wait out.
          bridgeSuccessTimeoutMs: config.timeouts.txReceiptMs,
          claimTimeoutMs: config.timeouts.claimedMs
        }) as UserDriver,
        cellsByAsset: activeAssetIndices.map(() => [] as Cell[]),
        lapCounterByAsset: activeAssetIndices.map(() => 0)
      })),
      ...headlessWallets.map((w) => ({
        userId: w.userId,
        mode: 'headless' as const,
        driver: new HeadlessUser({
          userId: w.userId,
          account: w.account,
          chains: config.chains,
          assets: config.assets,
          aggkitProxyUrl: config.aggkitProxyUrl,
          bridgeGasOffset: config.gas.bridgeGasOffset,
          claimGasOffset: config.gas.claimGasOffset,
          collector,
          clock,
          // R4 (loadtest/REVIEW.md): bounds viem's receipt wait to the same
          // budget `ring.ts` enforces, instead of viem's 180s default.
          receiptTimeoutMs: config.timeouts.txReceiptMs,
          // S53 M9: off unless `measurement.claimPreState` is set.
          claimPreState: config.measurement?.claimPreState === true
        }) as UserDriver,
        cellsByAsset: activeAssetIndices.map(() => [] as Cell[]),
        lapCounterByAsset: activeAssetIndices.map(() => 0)
      }))
    ];

    const initOutcomes = await Promise.allSettled(rawUsers.map((u) => u.driver.init()));
    const users: UserRuntime[] = [];
    for (let i = 0; i < initOutcomes.length; i += 1) {
      const outcome = initOutcomes[i];
      const u = rawUsers[i];
      if (outcome.status === 'fulfilled') {
        users.push(u);
        collector.userReady(u.userId, u.mode);
      } else {
        // R10/S26: `WalletIdentityMismatchError` gets its own `errorClass`
        // (mirrors `BrowserCrashError`'s handling in the tick loop below)
        // instead of falling through `classifyError`'s generic `'unknown'`
        // source, which would collapse it into `internal` and bury the one
        // failure mode that silently invalidates every measurement for this
        // user.
        const classified =
          outcome.reason instanceof WalletIdentityMismatchError
            ? { errorClass: outcome.reason.errorClass, message: redactError(outcome.reason) }
            : classifyError({ source: 'unknown', error: outcome.reason });
        collector.error({
          userId: u.userId,
          mode: u.mode,
          errorClass: classified.errorClass,
          message: classified.message
        });
        logger(`run: init failed for ${u.userId}: ${classified.message}`);
      }
    }
    if (users.length === 0) {
      throw new Error('run: every user failed to initialize — aborting before scheduling');
    }

    const usersById = new Map(users.map((u) => [u.userId, u]));
    const hopSpecsByAssetSlot = activeAssetIndices.map((assetIndex) =>
      buildHopSpecs(config, assetIndex, preflight.gasTokenChains)
    );

    collector.runStart({
      toolVersion: getToolVersion(repoRoot),
      sdkVersion: getSdkVersion(repoRoot),
      host: getHostInfo(),
      rampUpSeconds: config.load.rampUpSeconds
    });

    // S53: pump + samplers (a no-op without a pump block / matching measurement fields).
    harness = createHarnessWorkers({
      config,
      wallets,
      collector,
      clock,
      logger,
      chainClientFactory: options.chainClientFactory ?? defaultChainClientFactory
    });
    await harness.start();

    const engine = createRingEngine({ clock, timeouts: config.timeouts });
    const scheduler = createScheduler({
      clock,
      userIds: users.map((u) => u.userId),
      bridgesPerMinutePerUser: config.load.bridgesPerMinutePerUser,
      durationMinutes: config.load.durationMinutes,
      rampUpSeconds: config.load.rampUpSeconds,
      maxInflightLapsPerUser: config.load.maxInflightLapsPerUser,
      assetCount: activeAssetIndices.length,
      hopMs: config.timeouts.hopMs
    });

    const collectInflightHopStartTimes = (): number[] => {
      const starts: number[] = [];
      for (const u of users) {
        for (const cells of u.cellsByAsset) {
          for (const cell of cells) {
            if (cell.lap.state !== 'LAP_RUNNING') continue;
            const hop = cell.lap.hops[cell.lap.currentHopIndex];
            if (hop !== undefined) starts.push(hop.startedAt);
          }
        }
      }
      return starts;
    };

    const inflightLookup: InflightLookup = (userId) => {
      const u = usersById.get(userId);
      if (u === undefined)
        return { inflightLapsByAsset: activeAssetIndices.map(() => 0), oldestInflightGate: null };
      const inflightLapsByAsset = u.cellsByAsset.map(
        (cells) => cells.filter((c) => c.lap.state === 'LAP_RUNNING').length
      );
      let oldestGate: Gate | null = null;
      let oldestStart = Number.POSITIVE_INFINITY;
      for (const cells of u.cellsByAsset) {
        for (const cell of cells) {
          if (cell.lap.state !== 'LAP_RUNNING') continue;
          const hop = cell.lap.hops[cell.lap.currentHopIndex];
          if (hop === undefined) continue;
          if (hop.startedAt < oldestStart) {
            oldestStart = hop.startedAt;
            oldestGate = hop.currentGate;
          }
        }
      }
      return { inflightLapsByAsset, oldestInflightGate: oldestGate };
    };

    const activeLapTasks: Promise<void>[] = [];

    const launchLap = (u: UserRuntime, assetSlot: number): void => {
      const lapIndex = u.lapCounterByAsset[assetSlot];
      u.lapCounterByAsset[assetSlot] += 1;
      const lap = engine.startLap({
        userId: u.userId,
        lapIndex,
        assetIndex: activeAssetIndices[assetSlot],
        hopSpecs: hopSpecsByAssetSlot[assetSlot]
      });
      const cell: Cell = { lap };
      u.cellsByAsset[assetSlot].push(cell);

      const ctx: LapRunCtx = {
        engine,
        driver: u.driver,
        userId: u.userId,
        mode: u.mode,
        clock,
        collector,
        getDrainDeadline: () => scheduler.drainDeadline(),
        logger,
        assets: config.assets,
        stageProbeIntervalMs: config.measurement?.stageProbeIntervalMs ?? null,
        measurementEnabled: config.measurement !== undefined
      };

      const task = runLapToCompletion({ ctx, cell })
        .then(async (finalLap) => {
          collector.lapEnd({
            userId: u.userId,
            mode: u.mode,
            lapId: finalLap.id,
            outcome: finalLap.state as LapOutcome
          });
          if (isBrowserDriver(u.mode, u.driver)) {
            try {
              await u.driver.notifyLapCompleted(config.browser.recycleContextAfterLaps);
            } catch (error) {
              collector.error({
                userId: u.userId,
                mode: u.mode,
                errorClass: 'internal',
                message: redactError(error)
              });
            }
          }
        })
        .catch((error) => {
          const classified = classifyError({ source: 'unknown', error });
          collector.error({
            userId: u.userId,
            mode: u.mode,
            errorClass: classified.errorClass,
            message: classified.message
          });
          logger(`run: lap crashed unexpectedly for ${u.userId}: ${classified.message}`);
        })
        .finally(() => {
          const idx = u.cellsByAsset[assetSlot].indexOf(cell);
          if (idx !== -1) u.cellsByAsset[assetSlot].splice(idx, 1);
        });

      activeLapTasks.push(task);
    };

    // --- status line + resource sampling -----------------------------------
    const runStartedAtMs = clock.now();
    let lastCpuUsage = process.cpuUsage();
    let lastCpuAt = clock.now();

    // S16/A5 (VALIDATION-1.md): `eventLoopDelayP99Ms` is the p99 of
    // `perf_hooks.monitorEventLoopDelay`'s histogram over the interval
    // SINCE THE PREVIOUS SAMPLE (reset every call, mirroring the `toolCpuPct`
    // windowing right above) — a windowed figure so a bad stretch shows up
    // where it happened rather than being smeared across the whole run by a
    // cumulative percentile. `metrics/report.ts` uses the worst sample to
    // decide whether this run's own latency percentiles are trustworthy.
    const sampleResources = (): void => {
      const rssMb = process.memoryUsage().rss / (1024 * 1024);
      const now = clock.now();
      const cpuDelta = process.cpuUsage(lastCpuUsage);
      const elapsedMs = Math.max(1, now - lastCpuAt);
      const cpuPct = ((cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs) * 100;
      lastCpuUsage = process.cpuUsage();
      lastCpuAt = now;
      const browserProcesses = browserPool
        ? browserPool.livePids().map((pid) => ({ pid, rssMb: readProcRssMb(pid) }))
        : [];
      // `percentile()` returns nanoseconds; `NaN` when the histogram has no
      // samples yet (first call, or a period with zero event-loop ticks).
      const rawP99Ns = eventLoopDelay.percentile(99);
      const eventLoopDelayP99Ms = Number.isFinite(rawP99Ns) ? rawP99Ns / 1_000_000 : 0;
      eventLoopDelay.reset();
      collector.resourceSample({
        toolRssMb: rssMb,
        toolCpuPct: cpuPct,
        browserProcesses,
        eventLoopDelayP99Ms
      });
    };

    const printStatus = (): void => {
      const now = clock.now();
      const elapsedSec = Math.max(1, Math.round((now - runStartedAtMs) / 1000));
      // S53 F6: O(1) running counters. `collector.snapshot()` re-sorts every HTTP
      // and phase sample array — at stage-3 scale that is hundreds of thousands
      // of samples every 5 s, which blocked the event loop the tool is measuring.
      const live = collector.liveCounters();
      const activeUsers = users.filter((u) =>
        u.cellsByAsset.some((cells) => cells.some((c) => c.lap.state === 'LAP_RUNNING'))
      ).length;
      let inflightHops = 0;
      // S53 M6: laps currently in flight per route (the hop each one is on).
      const inflightByRoute = new Map<string, number>();
      for (const u of users) {
        for (const cells of u.cellsByAsset) {
          for (const cell of cells) {
            if (cell.lap.state !== 'LAP_RUNNING') continue;
            inflightHops += 1;
            const route = cell.lap.hops[cell.lap.currentHopIndex]?.spec.hopRoute;
            if (route !== undefined) {
              inflightByRoute.set(route, (inflightByRoute.get(route) ?? 0) + 1);
            }
          }
        }
      }
      // S11 retry defect (1): the live status line's `rate=` must be
      // comparable to the requested `--rate` (lap-starts/user/min), so it
      // is driven by `lapStartsSubmitted` (one per lap start), never the
      // hop-level `hopBridgesSubmitted` attempt #1 used here (which reads
      // `ring.length - 1` times too high for any multi-hop ring).
      const lapStartsSubmitted = live.lapStartsSubmitted;
      const ratePerMin = lapStartsSubmitted / (elapsedSec / 60);
      const routeOrder = config.ring.slice(0, -1).map((key, i) => `${key}->${config.ring[i + 1]}`);
      const byRoute = [...inflightByRoute.entries()]
        .sort(([a], [b]) => routeOrder.indexOf(a) - routeOrder.indexOf(b))
        .map(([route, count]) => `${route}:${count}`)
        .join(',');
      logger(
        `[status] t=${elapsedSec}s phase=${scheduler.phase()} usersActive=${activeUsers}/${users.length} lapStartsSubmitted=${lapStartsSubmitted} rate=${ratePerMin.toFixed(2)}/min inflightHops=${inflightHops} skippedBackpressure=${live.skippedBackpressure} errors=${live.errorsTotal} inflightByRoute=${byRoute === '' ? '-' : byRoute}${harness?.statusSuffix() ?? ''}`
      );
    };

    // S11 retry defect (2): how many laps were still `LAP_RUNNING` at the
    // exact instant drain began — captured once, at whichever of the three
    // `beginDrain` call sites fires first, so `runEnd` can report it
    // regardless of `aborted`.
    let lapsInFlightAtDrainStart = 0;

    // --- SIGINT handling (DESIGN §3.6 step 1/5) -----------------------------
    let sigintCount = 0;
    const onSigint = (): void => {
      sigintCount += 1;
      logger(
        `SIGINT received (${sigintCount})${sigintCount > 1 ? ' — second SIGINT, skipping grace period' : ' — draining...'}`
      );
      const inflightAtSigint = collectInflightHopStartTimes();
      if (sigintCount === 1) lapsInFlightAtDrainStart = inflightAtSigint.length;
      scheduler.beginDrain('sigint', inflightAtSigint);
    };
    // S58a M6: the guard has held the process-wide listener since the run began; hand it the
    // loop's handler, and replay any SIGINT that arrived during preflight / start-up.
    const earlySigints = guard.attach(onSigint);
    for (let i = 0; i < earlySigints; i += 1) onSigint();

    const PUMP_INTERVAL_MS = 1000;
    const STATUS_INTERVAL_MS = 5000;
    let lastStatusAt = clock.now();
    let lastResourceAt = clock.now();
    let durationDrainBegun = false;

    try {
      while (true) {
        const decisions: SchedulerDecision[] = scheduler.pump(inflightLookup);
        for (const decision of decisions) {
          const u = usersById.get(decision.userId);
          if (u === undefined) continue;
          if (decision.kind === 'start_lap') {
            collector.tick(u.userId, u.mode);
            launchLap(u, decision.assetIndex);
          } else {
            collector.tickSkipped(u.userId, u.mode, decision.gate);
            collector.recordGateBlocked(decision.gate);
          }
        }
        // DESIGN §5.5 invariant 1 (`ticksOffered = lapStartsSubmitted +
        // skippedBackpressure + ticksLostToRamp`) needs the scheduler's OWN
        // counters in the collector — `lapStartsSubmitted` is derived
        // separately, from the `collector.tick()` calls above (one per
        // `start_lap` decision), so it can never drift from what the
        // runner actually launched (collector.ts's own doc), but
        // `ticksOffered`/`skippedBackpressure`/`ticksLostToRamp` only exist
        // on the scheduler and must be pushed here on every pump.
        collector.setSchedulerCounters(scheduler.counters());

        if (
          !durationDrainBegun &&
          scheduler.drainCause() === null &&
          clock.now() >= scheduler.stopAt
        ) {
          durationDrainBegun = true;
          const inflightAtDuration = collectInflightHopStartTimes();
          lapsInFlightAtDrainStart = inflightAtDuration.length;
          logger(
            `run: duration elapsed — draining (${inflightAtDuration.length} lap(s) in flight)...`
          );
          scheduler.beginDrain('duration_elapsed', inflightAtDuration);
        }

        const now = clock.now();
        if (now - lastStatusAt >= STATUS_INTERVAL_MS) {
          printStatus();
          lastStatusAt = now;
        }
        if (now - lastResourceAt >= STATUS_INTERVAL_MS) {
          sampleResources();
          lastResourceAt = now;
        }

        // The drain deadline is a fixed UPPER BOUND computed once at drain
        // start (DESIGN §3.6 step 2), not a target to always wait out — once
        // every in-flight hop has actually reached a terminal state (a run
        // observed live: all work finished ~3 minutes before a 20-minute
        // `hopMs`-derived deadline), there is nothing left for further
        // waiting to accomplish. Stopping the instant drain has begun AND
        // nothing is left in flight avoids that dead time honestly — it
        // does not change WHAT gets recorded (every hop is already
        // terminal), only how long the process sits idle before writing it.
        if (
          scheduler.isStopped() ||
          (scheduler.drainCause() !== null && collectInflightHopStartTimes().length === 0)
        ) {
          break;
        }

        await sleep(PUMP_INTERVAL_MS);
      }
    } catch (error) {
      fatalError = error;
      if (scheduler.drainCause() === null) {
        const inflightAtFatal = collectInflightHopStartTimes();
        lapsInFlightAtDrainStart = inflightAtFatal.length;
        logger(`run: fatal error, draining: ${redactError(error)}`);
        scheduler.beginDrain('fatal', inflightAtFatal);
      }
    } finally {
      guard.detach();
    }

    // S53: the pump and samplers stop when the main loop exits (end of drain, or
    // abort), and a pending pump receipt is awaited (bounded by `txReceiptMs`)
    // BEFORE `runEnd`/`writeReportFiles`, so the report holds the final accounting.
    await harness.stop();

    await Promise.allSettled(activeLapTasks);
    sampleResources();

    // S11 retry defect (2): `aborted` is reserved for ABNORMAL termination
    // (SIGINT, a fatal error) — `duration_elapsed` is the NORMAL end of a
    // run that served its full requested `--minutes` and then drained, and
    // must read as a pass. Attempt #1 hardcoded `aborted: true` here
    // unconditionally, so every completed run (including S14/S17-style
    // validation runs) was mislabelled `ABORTED (duration_elapsed)`.
    const drainCause = scheduler.drainCause();
    const abnormalAbort = drainCause === 'sigint' || drainCause === 'fatal';
    collector.runEnd({
      aborted: abnormalAbort,
      abortCause: abnormalAbort ? drainCause : null,
      lapsInFlightAtStop: lapsInFlightAtDrainStart
    });

    await Promise.allSettled(
      users.map(async (u) => {
        try {
          await u.driver.dispose();
        } catch (error) {
          logger(`run: dispose failed for ${u.userId}: ${redactError(error)}`);
        }
      })
    );
    const written = writeReportFiles({
      dir: outDir,
      snapshot: collector.snapshot(),
      config,
      gasTokenChains: preflight.gasTokenChains
    });

    await disposeEverything();

    if (fatalError) throw fatalError;

    return {
      outDir,
      resultsPath: written.resultsPath,
      summaryPath: written.summaryPath,
      activityPath: path.join(outDir, 'activity.ndjson'),
      aborted: written.results.run.aborted,
      abortCause: written.results.run.abortCause as AbortCause | null
    };
  } catch (error) {
    await disposeEverything();
    throw error;
  }
};

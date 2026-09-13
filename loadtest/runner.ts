import type { Address } from 'viem';

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

import type { LoadtestConfig } from './config/schema';
import type { Clock, RingEmission, RingEngine } from './core/ring';
import type { AbortCause, InflightLookup, SchedulerDecision } from './core/scheduler';
import type { AssetKind, Gate, Hop, HopSpec, Lap, ObservedRow } from './core/types';
import type { DriverError, DriverMode, UserDriver } from './core/userDriver';
import type { Collector, HostInfo, LapOutcome } from './metrics/collector';
import type { ServeUiHandle } from './ui/serve';
import type { DerivedWallet } from './wallets/derive';

import { createRingEngine, eventsFromBridge, eventsFromClaim, systemClock } from './core/ring';
import { createScheduler } from './core/scheduler';
import { createCollector, createFileActivitySink } from './metrics/collector';
import { classifyError } from './metrics/errors';
import { writeReportFiles } from './metrics/report';
import { buildUi } from './ui/build';
import { serveUi } from './ui/serve';
import { deriveWallets } from './wallets/derive';
import { fundWallets } from './wallets/fund';
import { PreflightError, runPreflight } from './wallets/preflight';
import { redactError } from './wallets/redact';
import { BrowserCrashError, BrowserUser } from './workers/browser/browserUser';
import { BrowserPool } from './workers/browser/pool';
import { HeadlessUser } from './workers/headless/headlessUser';
import { installTimingFetch } from './workers/headless/uiCallset';

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

const buildHopSpecs = (config: LoadtestConfig, assetIndex: number): HopSpec[] => {
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

interface LapRunCtx {
  engine: RingEngine;
  driver: UserDriver;
  userId: string;
  mode: DriverMode;
  clock: Clock;
  collector: Collector;
  getDrainDeadline: () => number | null;
  logger: (line: string) => void;
}

const reportDriverError = (
  ctx: LapRunCtx,
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

const reportEmbeddedErrors = (
  ctx: LapRunCtx,
  hopId: string,
  errors: readonly (DriverError | undefined)[]
): void => {
  for (const error of errors) {
    if (error !== undefined) reportDriverError(ctx, hopId, error);
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
            const classified = classifyError({ source: 'unknown', error });
            reportDriverError(ctx, hop.id, classified);
            await sleep(1000);
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

  return lap;
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

export const runLoadTest = async (options: RunLoadTestOptions): Promise<RunLoadTestResult> => {
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

  fs.mkdirSync(outDir, { recursive: true });

  // --- UI build/serve (browser mode only, and only if not already served) ---
  let uiHandle: ServeUiHandle | null = null;
  if (config.users.browser > 0) {
    if (config.uiBaseUrl === undefined) {
      throw new Error('run: users.browser > 0 requires uiBaseUrl in the config');
    }
    const reachable = await isUrlReachable(config.uiBaseUrl);
    if (reachable) {
      logger(`run: UI already reachable at ${config.uiBaseUrl}, not building/serving`);
    } else {
      logger(`run: building UI for ${config.uiBaseUrl}...`);
      const built = await buildUi({ configPath, repoRoot });
      uiHandle = await serveUi({ outDir: built.outDir, uiBaseUrl: config.uiBaseUrl });
      logger(`run: serving UI at ${uiHandle.url}`);
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
  const uninstallTimingFetch = installTimingFetch(collector, clock).uninstall;

  let browserPool: BrowserPool | null = null;
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
          aggkitProxyUrl: config.aggkitProxyUrl,
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
          collector,
          clock,
          // R4 (loadtest/REVIEW.md): bounds viem's receipt wait to the same
          // budget `ring.ts` enforces, instead of viem's 180s default.
          receiptTimeoutMs: config.timeouts.txReceiptMs
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
        const classified = classifyError({ source: 'unknown', error: outcome.reason });
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
      buildHopSpecs(config, assetIndex)
    );

    collector.runStart({
      toolVersion: getToolVersion(repoRoot),
      sdkVersion: getSdkVersion(repoRoot),
      host: getHostInfo(),
      rampUpSeconds: config.load.rampUpSeconds
    });

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
        logger
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
      const snap = collector.snapshot();
      const activeUsers = users.filter((u) =>
        u.cellsByAsset.some((cells) => cells.some((c) => c.lap.state === 'LAP_RUNNING'))
      ).length;
      const inflightHops = users.reduce(
        (sum, u) =>
          sum +
          u.cellsByAsset.reduce(
            (s, cells) => s + cells.filter((c) => c.lap.state === 'LAP_RUNNING').length,
            0
          ),
        0
      );
      // S11 retry defect (1): the live status line's `rate=` must be
      // comparable to the requested `--rate` (lap-starts/user/min), so it
      // is driven by `lapStartsSubmitted` (one per lap start), never the
      // hop-level `hopBridgesSubmitted` attempt #1 used here (which reads
      // `ring.length - 1` times too high for any multi-hop ring).
      const lapStartsSubmitted = snap.scheduler.lapStartsSubmitted;
      const ratePerMin = lapStartsSubmitted / (elapsedSec / 60);
      const errorsTotal = Object.values(snap.errors.byClass).reduce(
        (a: number, b) => a + (b ?? 0),
        0
      );
      logger(
        `[status] t=${elapsedSec}s phase=${scheduler.phase()} usersActive=${activeUsers}/${users.length} lapStartsSubmitted=${lapStartsSubmitted} rate=${ratePerMin.toFixed(2)}/min inflightHops=${inflightHops} skippedBackpressure=${snap.scheduler.skippedBackpressure} errors=${errorsTotal}`
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
    process.on('SIGINT', onSigint);

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
      process.off('SIGINT', onSigint);
    }

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
    const written = writeReportFiles({ dir: outDir, snapshot: collector.snapshot(), config });

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

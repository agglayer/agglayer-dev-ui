// Offered-load scheduler — DESIGN §3.5 (token bucket, ramp-up,
// backpressure, new-lap-vs-continue, asset interleaving, stop) and §3.6
// (drain and abort). Pure and I/O-free: time enters through the injected
// `Clock`, and the in-flight picture enters through an `InflightLookup`
// callback the caller (S11's runner) closes over its own `UserRing` set.
//
// The one property everything here exists to protect is honesty of the
// achieved-rate number:
//
//   * capacity is 1 token, never more — a burst would let the tool claim a
//     rate it never sustained;
//   * a tick that hits `maxInflightLapsPerUser` is DROPPED and counted as
//     `skipped_backpressure`, never queued — a queued tick would later fire
//     as a burst and misreport the offered load;
//   * a user's bucket starts EMPTY at its ramp-in instant, so no user
//     front-loads a token it earned before it existed. The tokens the ramp
//     cost are accounted for as `ticks_lost_to_ramp` rather than quietly
//     dropped, which is what makes §5.5's invariant 1 checkable:
//     `ticks_offered = bridges_submitted + skipped_backpressure +
//     ticks_lost_to_ramp`.

import type { Clock } from './ring';
import type { Gate } from './types';

// What the runner must know about one user's in-flight work when a tick
// fires. `inflightLapsByAsset[i]` is the number of laps of asset `i` that
// are still `LAP_RUNNING`; `oldestInflightGate` is the gate the oldest
// in-flight hop is sitting on (§5.4's "how many hops were sitting on it when
// a `skipped_backpressure` tick fired" — the number that answers whether the
// devnet or the tool was the bottleneck).
export interface UserInflight {
  inflightLapsByAsset: readonly number[];
  oldestInflightGate: Gate | null;
}

export type InflightLookup = (userId: string) => UserInflight;

export type SchedulerPhase = 'ramping' | 'steady' | 'draining' | 'stopped';

export type AbortCause = 'duration_elapsed' | 'sigint' | 'fatal';

export type SchedulerDecision =
  | { kind: 'start_lap'; userId: string; assetIndex: number; at: number }
  | { kind: 'skipped_backpressure'; userId: string; at: number; gate: Gate | null };

export interface SchedulerCounters {
  ticksIssued: number;
  skippedBackpressure: number;
  ticksLostToRamp: number;
  // §5.5 invariant 1's left-hand side.
  ticksOffered: number;
  // R29 (loadtest/REVIEW.md): `ticksOffered` is *defined* as
  // `ticksIssued + skippedBackpressure + ticksLostToRamp` — a tautology
  // with respect to the scheduler's own three counters, so if the token
  // bucket ever silently dropped demand, every term would shrink together
  // and the identity check would still print OK. `ticksExpected` is an
  // INDEPENDENT fourth term, computed once from the config alone
  // (`users x bridgesPerMinutePerUser x durationMinutes`, floored), never
  // from the bucket's own bookkeeping — so a gap between it and
  // `ticksOffered` is now visible instead of structurally unable to exist.
  // Not part of the §5.5 identity's strict equality (ramp rounding means it
  // will rarely match exactly); `metrics/report.ts` renders both side by
  // side so a reader can see the gap.
  ticksExpected: number;
}

export interface SchedulerParams {
  clock: Clock;
  userIds: readonly string[];
  bridgesPerMinutePerUser: number;
  durationMinutes: number;
  rampUpSeconds: number;
  maxInflightLapsPerUser: number;
  assetCount: number;
  // DESIGN §3.6 step 2 bounds the drain by `hopMs`.
  hopMs: number;
  startedAt?: number;
}

interface BucketState {
  userId: string;
  index: number;
  admissibleAt: number;
  // Accrued credit in MILLISECONDS rather than in fractional tokens. A
  // token costs `periodMs`; credit accumulates as integer clock deltas and
  // is capped at exactly one token's worth, so `credit -= periodMs` lands on
  // 0 and no float error accumulates. Accumulating `delta × rate` as a
  // fraction instead loses roughly one tick in ten to binary rounding
  // (0.1 × 10 < 1), which would quietly under-report the offered rate.
  creditMs: number;
  lastRefillAt: number;
  nextAssetIndex: number;
}

export interface Scheduler {
  readonly startedAt: number;
  readonly stopAt: number;
  phase(): SchedulerPhase;
  // DESIGN §3.5's ramp formula, exposed so a test can assert it directly.
  admissibleAt(userIndex: number): number;
  // Advance every bucket to `clock.now()` and return the decisions for this
  // instant. At most one decision per user per call (capacity 1).
  pump(inflight: InflightLookup): SchedulerDecision[];
  // §3.6 step 1/5. `sigint` twice skips the grace period entirely.
  beginDrain(cause: AbortCause, inflightHopStartedAt: readonly number[]): void;
  drainDeadline(): number | null;
  drainCause(): AbortCause | null;
  counters(): SchedulerCounters;
  // True once no ticks will ever be issued again.
  isStopped(): boolean;
}

// DESIGN §3.6 step 2: in-flight hops are allowed to finish, bounded by
// `hopMs` measured from EACH hop's own start, and by an overall drain
// deadline of `min(hopMs, remaining hop budget across all in-flight hops)`.
// Both bounds are absolute instants here, and the earlier one wins — which
// is what makes "drain stops within hopMs" a theorem rather than a hope.
export const computeDrainDeadline = (params: {
  drainStartedAt: number;
  hopMs: number;
  inflightHopStartedAt: readonly number[];
}): number => {
  const cap = params.drainStartedAt + params.hopMs;
  const latest = params.inflightHopStartedAt.reduce(
    (max, startedAt) => Math.max(max, startedAt + params.hopMs),
    params.drainStartedAt
  );
  return Math.min(cap, latest);
};

export const createScheduler = (params: SchedulerParams): Scheduler => {
  const {
    clock,
    userIds,
    bridgesPerMinutePerUser,
    durationMinutes,
    rampUpSeconds,
    maxInflightLapsPerUser,
    assetCount,
    hopMs
  } = params;

  if (assetCount < 1) throw new Error('createScheduler: assetCount must be >= 1');

  const startedAt = params.startedAt ?? clock.now();
  const stopAt = startedAt + durationMinutes * 60_000;
  const rampEndsAt = startedAt + rampUpSeconds * 1_000;
  // One token per `periodMs`, refilled continuously (DESIGN §3.5).
  const periodMs = 60_000 / bridgesPerMinutePerUser;
  const total = userIds.length;

  const admissibleAt = (index: number): number =>
    total === 0 ? startedAt : startedAt + (rampUpSeconds * 1_000 * index) / total;

  const buckets: BucketState[] = userIds.map((userId, index) => ({
    userId,
    index,
    admissibleAt: admissibleAt(index),
    creditMs: 0,
    lastRefillAt: admissibleAt(index),
    nextAssetIndex: 0
  }));

  // The tokens the ramp cost, as offered-load accounting. A user admitted at
  // `admissibleAt(k)` never earns the tokens a fully-ramped user would have
  // over `admissibleAt(k) − startedAt`; those are reported rather than
  // silently absent.
  const ticksLostToRamp = buckets.reduce(
    (sum, bucket) => sum + Math.floor((bucket.admissibleAt - startedAt) / periodMs),
    0
  );

  // R29: an INDEPENDENT fourth term — see `SchedulerCounters.ticksExpected`'s
  // doc. Computed once, from the config alone, never touched by `pump()`.
  const ticksExpected = Math.floor(total * bridgesPerMinutePerUser * durationMinutes);

  let ticksIssued = 0;
  let skippedBackpressure = 0;
  let drainStartedAt: number | null = null;
  let drainDeadlineAt: number | null = null;
  let cause: AbortCause | null = null;

  const pickAsset = (bucket: BucketState, inflightByAsset: readonly number[]): number | null => {
    // Round-robin among the user's per-asset rings, skipping any ring that is
    // already at its in-flight limit (DESIGN §3.5 "asset interleaving").
    for (let offset = 0; offset < assetCount; offset += 1) {
      const candidate = (bucket.nextAssetIndex + offset) % assetCount;
      const inflight = inflightByAsset[candidate] ?? 0;
      if (inflight < maxInflightLapsPerUser) {
        bucket.nextAssetIndex = (candidate + 1) % assetCount;
        return candidate;
      }
    }
    return null;
  };

  return {
    startedAt,
    stopAt,

    admissibleAt,

    phase: () => {
      const now = clock.now();
      if (drainStartedAt !== null) {
        return drainDeadlineAt !== null && now >= drainDeadlineAt ? 'stopped' : 'draining';
      }
      if (now >= stopAt) return 'stopped';
      return now < rampEndsAt ? 'ramping' : 'steady';
    },

    pump: (inflight) => {
      const now = clock.now();
      // §3.5 "Stop": at `durationMinutes × 60000` no further ticks are
      // issued and drain begins.
      if (drainStartedAt !== null || now >= stopAt) return [];

      const decisions: SchedulerDecision[] = [];
      for (const bucket of buckets) {
        if (now < bucket.admissibleAt) {
          bucket.lastRefillAt = bucket.admissibleAt;
          continue;
        }
        // R29 (loadtest/REVIEW.md): credit used to be CAPPED at exactly one
        // token's worth (`Math.min(periodMs, ...)`) while `lastRefillAt`
        // advanced unconditionally — so if the real gap between two pump()
        // calls ever exceeded `periodMs` (the pump loop runs on the same
        // Node event loop `runner.ts` samples for `eventLoopDelayP99Ms`,
        // and S17 measured that loop backed up to 35 433ms p99 — well past
        // `periodMs` at the plan's own `--rate 2`), the excess credit was
        // silently discarded rather than carried over, capping the bucket
        // at one tick per pump call regardless of how many periods elapsed.
        // Credit now accrues without a cap, and the loop below drains every
        // whole period's worth of credit as its own tick — so a coarse pump
        // cadence produces a BURST of ticks (each independently subject to
        // the same backpressure check) instead of lost demand.
        bucket.creditMs += now - bucket.lastRefillAt;
        bucket.lastRefillAt = now;

        // Ticks fired for THIS user within this single pump() call, per
        // asset — simulated forward so a burst's own earlier ticks are
        // reflected in the backpressure check for its later ticks (the
        // real `inflight()` snapshot is taken once, before the loop, and
        // does not know about decisions this same loop is about to make).
        const snapshot = inflight(bucket.userId);
        const providedThisPump = new Array<number>(assetCount).fill(0);

        while (bucket.creditMs >= periodMs) {
          // A tick fires. It is consumed whether or not it produces a lap:
          // dropping it (rather than putting the token back) is what keeps
          // the achieved-rate number honest.
          bucket.creditMs -= periodMs;
          const simulatedInflight = snapshot.inflightLapsByAsset.map(
            (count, index) => count + (providedThisPump[index] ?? 0)
          );
          const assetIndex = pickAsset(bucket, simulatedInflight);
          if (assetIndex === null) {
            skippedBackpressure += 1;
            decisions.push({
              kind: 'skipped_backpressure',
              userId: bucket.userId,
              at: now,
              gate: snapshot.oldestInflightGate
            });
            continue;
          }
          ticksIssued += 1;
          providedThisPump[assetIndex] = (providedThisPump[assetIndex] ?? 0) + 1;
          decisions.push({ kind: 'start_lap', userId: bucket.userId, assetIndex, at: now });
        }
      }
      return decisions;
    },

    beginDrain: (nextCause, inflightHopStartedAt) => {
      const now = clock.now();
      if (drainStartedAt !== null) {
        // §3.6 step 5: a second SIGINT during drain skips the grace period
        // and writes immediately.
        drainDeadlineAt = now;
        cause = nextCause;
        return;
      }
      drainStartedAt = now;
      cause = nextCause;
      drainDeadlineAt = computeDrainDeadline({
        drainStartedAt: now,
        hopMs,
        inflightHopStartedAt
      });
    },

    drainDeadline: () => drainDeadlineAt,
    drainCause: () => cause,

    counters: () => ({
      ticksIssued,
      skippedBackpressure,
      ticksLostToRamp,
      ticksOffered: ticksIssued + skippedBackpressure + ticksLostToRamp,
      ticksExpected
    }),

    isStopped: () => {
      const now = clock.now();
      if (drainStartedAt === null) return false;
      return drainDeadlineAt !== null && now >= drainDeadlineAt;
    }
  };
};

// The hop/lap state machine — DESIGN §3, implemented row by row against the
// §3.2 transition table (T1–T30) and the §3.2 lap table (L1–L4). Pure and
// I/O-free: the only time source is the injected `Clock`, and every input
// arrives as a `RingEvent` produced by a `UserDriver` (S08/S10) result.
//
// Deliberate divergences from aggkit's `bridge_loop_tester`, all from
// DESIGN §3.4/§3.2 and all load-test-honesty rather than policy assertion:
//
//   * `autoclaim_overdue` (T18) and `unexpected_autoclaim` (T27) are recorded
//     COUNTERS that do not fail a hop. aggkit treats both as fatal claim-mode
//     violations; this tool escalates (T18) or simply records (T27) and keeps
//     the ring moving.
//   * a lost claim race is a SUCCESS: `hop_completed_raced` (T19/T22/T24).
//   * activity status `ERROR` (`claimed === 'error'`) is its own outcome
//     `activity_status_error` (T16) — it is a member of a string union, never
//     a falsy "not claimed".
//   * row identity is `tx_hash:deposit_count` (§9.2), never `bridge_hash`,
//     never `global_index`.
//
// Interpretation notes, where §3.2 is silent and a choice had to be made
// (each is called out so S20 can audit it):
//
//   N1. T13's guard is read as `expected === true && !hop.escalated`. Once
//       T18 has escalated a hop to manual, re-entering AWAITING_READY (via
//       T20) must not re-enter the grace window — that would double-count
//       `autoclaim_overdue` on every retry cycle.
//   N2. T20 re-enters AWAITING_READY with a FRESH `readyToClaimMs` window
//       (its `stateEnteredAt` is reset) but keeps `readyAt` and does not
//       re-record the `ready_to_claim` phase. The T28 `hopMs` umbrella is
//       what bounds a T14/T20 retry cycle, exactly as the table's last row
//       promises.
//   N3. CLAIM_BUILD's one timeout key (`claimedMs`) is measured from state
//       entry; WHICH timeout outcome it produces is selected by the pending
//       sub-step (T19 → `timeout_claim_build`, T20 → `timeout_not_claimable`,
//       T21/T22 → `timeout_claim_submit`), which is the only reading under
//       which those three table rows differ.
//   N4. An activity row observed already `CLAIMED` while in
//       AWAITING_ACTIVITY cascades T12 → AWAITING_READY → T15 within the one
//       event, which is how T27's "AWAITING_ACTIVITY … AWAITING_CLAIMED"
//       range is satisfied without inventing a transition.
//   N5. `hop_total` / `lap_total` are recorded only for a hop/lap that
//       completed successfully. A failed hop's duration is a timeout budget,
//       not a latency sample, and averaging it in would corrupt the §5.1
//       percentiles; failures are accounted for by outcome instead.
//   N6. A lap-level `lapMs` expiry (L1/L2's timeout column) fails the
//       outstanding hop with outcome `timeout_lap` as well as the lap, so
//       §5.5's invariant 2 ("every hop has exactly one terminal outcome")
//       still holds.
//   N7. T4/T8/T22's "classifier" outcome is taken from the event's
//       `errorClass` (assigned by `metrics/errors.ts`, S07, on typed
//       evidence). When no class is supplied, ring.ts applies only the two
//       rules DESIGN states in prose itself — `LocalBalanceTreeUnderflow` in
//       the message ⇒ `lbt_underflow` (§3.7/T8), otherwise `internal`.

import type { Hex } from 'viem';

import type {
  ClaimStep,
  ErrorClass,
  Gate,
  Hop,
  HopCounter,
  HopSpec,
  HopState,
  Lap,
  ObservedRow,
  Outcome,
  Phase,
  PhaseSample,
  RingTimeouts,
  TimeoutKey,
  TimeoutOutcome,
  TransitionId
} from './types';
import type {
  BridgeSubmission,
  ClaimInputsResult,
  ClaimSubmission,
  DriverError,
  ReceiptStatus,
  StepTiming,
  TxStepResult
} from './userDriver';

import { emptyHopCounters, isSuccessOutcome, isTerminalHopState, toRowKey } from './types';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

// A manually advanced clock. Used by ring.test.ts / scheduler.test.ts so
// every timeout in §3.2 and the scheduler's Y·Z bound are asserted
// deterministically rather than by sleeping.
export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): number;
}

export const createFakeClock = (startAt = 0): FakeClock => {
  let current = startAt;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
      return current;
    }
  };
};

// ---------------------------------------------------------------------------
// Events, emissions, actions
// ---------------------------------------------------------------------------

export type RingEvent =
  // T1 / T2 — the ERC20 allowance read (absent for ETH hops).
  | { kind: 'allowance'; sufficient: boolean; timing?: StepTiming }
  // T3
  | { kind: 'approve_sent'; txHash: Hex; timing?: StepTiming }
  // T5 / T6
  | { kind: 'approve_receipt'; status: ReceiptStatus; timing?: StepTiming }
  // T7
  | { kind: 'bridge_sent'; txHash: Hex; timing?: StepTiming }
  // T9 / T10 / T11
  | {
      kind: 'bridge_receipt';
      status: ReceiptStatus;
      depositCount: number | null;
      bridgeEventFound: boolean;
      timing?: StepTiming;
    }
  // T4 / T8 / T22 — a build/send throw, already classified where possible.
  | { kind: 'submit_error'; step: 'approve' | 'bridge' | 'claim'; error: DriverError }
  // T12 – T17, T26, T27 — one activity poll's rows.
  | { kind: 'activity'; rows: readonly ObservedRow[] }
  // T19
  | { kind: 'is_claimed'; claimed: boolean; timing?: StepTiming }
  // T20 / T21
  | { kind: 'claim_inputs'; claimable: boolean; reason?: string; timing?: StepTiming }
  // T21
  | { kind: 'claim_sent'; txHash: Hex; timing?: StepTiming }
  // T23 / T24 / T25
  | {
      kind: 'claim_receipt';
      status: ReceiptStatus;
      isClaimedRecheck: boolean | null;
      timing?: StepTiming;
    }
  // T30
  | { kind: 'browser_crash'; error?: DriverError }
  // T28 / T29 and every per-phase timeout: a pure clock advance.
  | { kind: 'tick' };

export type RingEmission =
  | { type: 'transition'; transition: TransitionId; from: HopState; to: HopState; at: number }
  // R2: `censored` mirrors `PhaseSample.censored` — true for a sample
  // recorded on a timeout path rather than a real completion.
  | { type: 'phase'; phase: Phase; startedAt: number; durationMs: number; censored?: boolean }
  | { type: 'counter'; counter: HopCounter; at: number }
  | { type: 'gate_enter'; gate: Gate; at: number }
  // R6: true when this gate visit closed BECAUSE its phase timed out
  // (a duration ≈ the configured timeout, not a real stall measurement).
  | { type: 'gate_exit'; gate: Gate; at: number; durationMs: number; timedOut: boolean }
  | { type: 'outcome'; outcome: Outcome; at: number }
  // T28's "the per-phase timeout outcome is recorded too": the primary
  // outcome stays `timeout_hop`, and the phase timeout is recorded here so
  // §5.5's one-outcome-per-hop invariant is not broken.
  | { type: 'secondary_timeout'; timeout: TimeoutOutcome; at: number }
  | { type: 'lap_transition'; transition: TransitionId; lapState: Lap['state']; at: number };

// What the runner (S11) must do next for this hop. The state machine, not
// the worker, decides — so both worker kinds drive an identical sequence.
export type RingAction =
  | { kind: 'bridge' }
  | { kind: 'observe_activity' }
  | { kind: 'claim' }
  | { kind: 'awaiting_driver' }
  | { kind: 'none' };

export interface RingContext {
  now: number;
  timeouts: RingTimeouts;
  // Set once drain begins (DESIGN §3.6). `deadlineAt` is the overall drain
  // deadline computed by the scheduler.
  drain?: { deadlineAt: number };
}

export interface HopStep {
  hop: Hop;
  emissions: RingEmission[];
}

export interface LapStep {
  lap: Lap;
  emissions: RingEmission[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateHopParams {
  userId: string;
  lapId: string;
  lapIndex: number;
  spec: HopSpec;
  startedAt: number;
}

export const createHop = (params: CreateHopParams): Hop => ({
  id: `${params.lapId}:h${params.spec.hopIndex}`,
  userId: params.userId,
  lapId: params.lapId,
  lapIndex: params.lapIndex,
  spec: params.spec,
  state: 'PLANNED',
  claimStep: null,
  startedAt: params.startedAt,
  stateEnteredAt: params.startedAt,
  stepStartedAt: params.startedAt,
  bridgeTxHash: null,
  claimTxHash: null,
  depositCount: null,
  rowKey: null,
  readyAt: null,
  escalated: false,
  claimSubmitted: false,
  counters: emptyHopCounters(),
  phases: [],
  gates: [],
  currentGate: null,
  outcome: null,
  timeouts: []
});

export interface CreateLapParams {
  userId: string;
  lapIndex: number;
  assetIndex: number;
  hopSpecs: readonly HopSpec[];
  startedAt: number;
}

export const createLap = (params: CreateLapParams): Lap => {
  const lapId = `${params.userId}:a${params.assetIndex}:l${params.lapIndex}`;
  const first = params.hopSpecs[0];
  if (first === undefined) throw new Error('createLap: hopSpecs must not be empty');
  return {
    id: lapId,
    userId: params.userId,
    lapIndex: params.lapIndex,
    assetIndex: params.assetIndex,
    hopSpecs: params.hopSpecs,
    state: 'LAP_RUNNING',
    startedAt: params.startedAt,
    endedAt: null,
    hops: [
      createHop({
        userId: params.userId,
        lapId,
        lapIndex: params.lapIndex,
        spec: first,
        startedAt: params.startedAt
      })
    ],
    currentHopIndex: 0,
    outcome: null
  };
};

// ---------------------------------------------------------------------------
// Deadlines (DESIGN §3.2's "Timeout key" / "On timeout" columns)
// ---------------------------------------------------------------------------

export interface HopDeadline {
  at: number;
  key: TimeoutKey;
  // Absent for AWAITING_AUTOCLAIM: its expiry is T18's escalation, not a
  // failure (DESIGN §3.4).
  outcome: TimeoutOutcome | null;
}

const claimBuildTimeoutOutcome = (step: ClaimStep): TimeoutOutcome => {
  // See note N3.
  if (step === 'is_claimed') return 'timeout_claim_build';
  if (step === 'claim_inputs') return 'timeout_not_claimable';
  return 'timeout_claim_submit';
};

export const hopDeadline = (hop: Hop, timeouts: RingTimeouts): HopDeadline | null => {
  const from = hop.stateEnteredAt;
  switch (hop.state) {
    // T1/T2 are synchronous within the hop budget ("—" in the table).
    case 'PLANNED':
      return null;
    case 'APPROVE_BUILD':
      return {
        at: from + timeouts.txReceiptMs,
        key: 'txReceiptMs',
        outcome: 'timeout_approve_submit'
      };
    case 'APPROVE_PENDING':
      return {
        at: from + timeouts.txReceiptMs,
        key: 'txReceiptMs',
        outcome: 'timeout_approve_receipt'
      };
    case 'BRIDGE_BUILD':
      return {
        at: from + timeouts.txReceiptMs,
        key: 'txReceiptMs',
        outcome: 'timeout_bridge_submit'
      };
    case 'BRIDGE_PENDING':
      return {
        at: from + timeouts.txReceiptMs,
        key: 'txReceiptMs',
        outcome: 'timeout_bridge_receipt'
      };
    case 'AWAITING_ACTIVITY':
      return {
        at: from + timeouts.appearsInActivityMs,
        key: 'appearsInActivityMs',
        outcome: 'timeout_appears_in_activity'
      };
    case 'AWAITING_READY':
      return {
        at: from + timeouts.readyToClaimMs,
        key: 'readyToClaimMs',
        outcome: 'timeout_ready_to_claim'
      };
    case 'AWAITING_AUTOCLAIM': {
      // Grace window measured from FIRST-observed READY_TO_CLAIM, mirroring
      // app/hooks/useAutoclaimGate.ts + app/utils/autoclaim.ts's
      // `now >= readyAt + waitMs`.
      const readyAt = hop.readyAt ?? from;
      return {
        at: readyAt + (hop.spec.autoclaim.waitMs ?? 0),
        key: 'autoclaimWaitMs',
        outcome: null
      };
    }
    case 'CLAIM_BUILD':
      return {
        at: from + timeouts.claimedMs,
        key: 'claimedMs',
        outcome: claimBuildTimeoutOutcome(hop.claimStep ?? 'is_claimed')
      };
    case 'CLAIM_PENDING':
      return {
        at: from + timeouts.txReceiptMs,
        key: 'txReceiptMs',
        outcome: 'timeout_claim_receipt'
      };
    case 'AWAITING_CLAIMED':
      return {
        at: from + timeouts.claimedMs,
        key: 'claimedMs',
        outcome: 'timeout_claimed_observed'
      };
    default:
      return null;
  }
};

export const nextAction = (hop: Hop): RingAction => {
  switch (hop.state) {
    case 'PLANNED':
      return { kind: 'bridge' };
    case 'APPROVE_BUILD':
    case 'APPROVE_PENDING':
    case 'BRIDGE_BUILD':
    case 'BRIDGE_PENDING':
    case 'CLAIM_PENDING':
      return { kind: 'awaiting_driver' };
    case 'AWAITING_ACTIVITY':
    case 'AWAITING_READY':
    case 'AWAITING_AUTOCLAIM':
    case 'AWAITING_CLAIMED':
      return { kind: 'observe_activity' };
    case 'CLAIM_BUILD':
      return hop.claimStep === 'is_claimed' ? { kind: 'claim' } : { kind: 'awaiting_driver' };
    default:
      return { kind: 'none' };
  }
};

// ---------------------------------------------------------------------------
// Internal mutation helpers (each returns a new Hop; emissions accumulate)
// ---------------------------------------------------------------------------

const GATE_ON_ENTRY: Partial<Record<HopState, Gate>> = {
  AWAITING_ACTIVITY: 'activity-index',
  AWAITING_READY: 'claim-proof',
  AWAITING_AUTOCLAIM: 'claimed',
  AWAITING_CLAIMED: 'claimed'
};

// DESIGN §5.4: `getClaimInputs`'s `reason` is an OPEN union — branch with a
// default, never `assertNever`.
export const gateFromClaimInputsReason = (reason?: string): Gate => {
  switch (reason) {
    case 'SOURCE_NOT_ON_L1_INFO_TREE':
      return 'l1-info-tree-index';
    case 'SYNCER_INCONSISTENT':
      return 'syncer-inconsistent';
    case 'DESTINATION_NOT_INJECTED':
    case 'GER_NOT_INJECTED':
      return 'injected-l1-info-leaf';
    default:
      return 'claim-proof';
  }
};

interface Mut {
  hop: Hop;
  emissions: RingEmission[];
}

const phaseSample = (
  phase: Phase,
  now: number,
  fallbackStartedAt: number,
  timing?: StepTiming
): PhaseSample =>
  timing !== undefined
    ? { phase, startedAt: timing.startedAt, durationMs: timing.durationMs }
    : { phase, startedAt: fallbackStartedAt, durationMs: Math.max(0, now - fallbackStartedAt) };

const recordPhase = (mut: Mut, sample: PhaseSample): void => {
  mut.hop = { ...mut.hop, phases: [...mut.hop.phases, sample] };
  mut.emissions.push({
    type: 'phase',
    phase: sample.phase,
    startedAt: sample.startedAt,
    durationMs: sample.durationMs,
    ...(sample.censored === true ? { censored: true as const } : {})
  });
};

const bumpCounter = (mut: Mut, counter: HopCounter, at: number): void => {
  mut.hop = {
    ...mut.hop,
    counters: { ...mut.hop.counters, [counter]: mut.hop.counters[counter] + 1 }
  };
  mut.emissions.push({ type: 'counter', counter, at });
};

// R6 (loadtest/REVIEW.md): a gate visit that ends because its phase timed
// out has a duration ≈ the configured timeout — that is a CENSORING signal,
// not a latency measurement, and `metrics/report.ts`'s gate-stalls table
// used to render it as a plain percentile with nothing distinguishing it
// from a real stall. `timedOut` is threaded through so the collector can
// count, per gate, how many of its visits ended at the timeout budget
// rather than a real resolution.
const exitGate = (mut: Mut, now: number, timedOut = false): void => {
  const { currentGate, gates } = mut.hop;
  if (currentGate === null) return;
  const open = gates.findLast((visit) => visit.gate === currentGate && visit.exitedAt === null);
  const closed = gates.map((visit) => (visit === open ? { ...visit, exitedAt: now } : visit));
  mut.hop = { ...mut.hop, gates: closed, currentGate: null };
  mut.emissions.push({
    type: 'gate_exit',
    gate: currentGate,
    at: now,
    durationMs: open === undefined ? 0 : Math.max(0, now - open.enteredAt),
    timedOut
  });
};

const enterGate = (mut: Mut, gate: Gate, now: number): void => {
  mut.hop = {
    ...mut.hop,
    gates: [...mut.hop.gates, { gate, enteredAt: now, exitedAt: null }],
    currentGate: gate
  };
  mut.emissions.push({ type: 'gate_enter', gate, at: now });
};

interface GoToOptions {
  claimStep?: ClaimStep | null;
  // Override the gate the destination state would enter by default (T20).
  gate?: Gate;
}

const goTo = (
  mut: Mut,
  to: HopState,
  transition: TransitionId,
  now: number,
  options: GoToOptions = {}
): void => {
  const from = mut.hop.state;
  exitGate(mut, now);
  mut.hop = {
    ...mut.hop,
    state: to,
    claimStep: options.claimStep ?? null,
    stateEnteredAt: now,
    stepStartedAt: now
  };
  mut.emissions.push({ type: 'transition', transition, from, to, at: now });
  const gate = options.gate ?? GATE_ON_ENTRY[to];
  if (gate !== undefined) enterGate(mut, gate, now);
};

const setStep = (mut: Mut, step: ClaimStep, now: number): void => {
  mut.hop = { ...mut.hop, claimStep: step, stepStartedAt: now };
};

// The full `TimeoutOutcome` union, so `finish()` can tell — from the
// outcome alone — whether the gate it is about to close (if any) was
// closed BY a timeout (R6) without needing a second parameter threaded
// through every call site.
const TIMEOUT_OUTCOMES: ReadonlySet<Outcome> = new Set<TimeoutOutcome>([
  'timeout_approve_submit',
  'timeout_approve_receipt',
  'timeout_bridge_submit',
  'timeout_bridge_receipt',
  'timeout_appears_in_activity',
  'timeout_ready_to_claim',
  'timeout_claim_build',
  'timeout_not_claimable',
  'timeout_claim_submit',
  'timeout_claim_receipt',
  'timeout_claimed_observed',
  'timeout_hop',
  'timeout_lap'
]);
const isTimeoutOutcomeValue = (outcome: Outcome): outcome is TimeoutOutcome =>
  TIMEOUT_OUTCOMES.has(outcome);

const finish = (mut: Mut, state: 'DONE' | 'FAILED', outcome: Outcome, now: number): void => {
  exitGate(mut, now, state === 'FAILED' && isTimeoutOutcomeValue(outcome));
  mut.hop = { ...mut.hop, state, claimStep: null, stateEnteredAt: now, outcome };
  mut.emissions.push({ type: 'outcome', outcome, at: now });
  // Note N5: only a successful hop contributes a `hop_total` latency sample.
  if (isSuccessOutcome(outcome)) {
    recordPhase(mut, {
      phase: 'hop_total',
      startedAt: mut.hop.startedAt,
      durationMs: Math.max(0, now - mut.hop.startedAt)
    });
  }
};

// R2 (loadtest/REVIEW.md): maps a `TimeoutOutcome` to the §5.1 `Phase` it
// timed out DURING, and where that phase's clock started (mirroring the
// same `phaseSample` call the SUCCESS path for that state uses —
// `stepStartedAt` for CLAIM_BUILD's finer-grained sub-phases, per the `Hop`
// doc, `stateEnteredAt` for everything else). `null` for the three outcomes
// with no phase of their own: `timeout_claim_build` is T19's `is_claimed`
// check (no named phase), and `timeout_hop`/`timeout_lap` are the umbrella
// outcomes themselves, not a phase.
const timeoutPhaseInfo = (
  hop: Hop,
  outcome: TimeoutOutcome
): { phase: Phase; startedAt: number } | null => {
  switch (outcome) {
    case 'timeout_approve_submit':
      return { phase: 'approve_submit', startedAt: hop.stateEnteredAt };
    case 'timeout_approve_receipt':
      return { phase: 'approve_receipt', startedAt: hop.stateEnteredAt };
    case 'timeout_bridge_submit':
      return { phase: 'bridge_submit', startedAt: hop.stateEnteredAt };
    case 'timeout_bridge_receipt':
      return { phase: 'bridge_receipt', startedAt: hop.stateEnteredAt };
    case 'timeout_appears_in_activity':
      return { phase: 'appears_in_activity', startedAt: hop.stateEnteredAt };
    case 'timeout_ready_to_claim':
      return { phase: 'ready_to_claim', startedAt: hop.stateEnteredAt };
    case 'timeout_not_claimable':
      return { phase: 'claim_inputs', startedAt: hop.stepStartedAt };
    case 'timeout_claim_submit':
      return { phase: 'claim_submit', startedAt: hop.stepStartedAt };
    case 'timeout_claim_receipt':
      return { phase: 'claim_receipt', startedAt: hop.stateEnteredAt };
    case 'timeout_claimed_observed':
      return { phase: 'claimed_observed', startedAt: hop.stateEnteredAt };
    case 'timeout_claim_build':
    case 'timeout_hop':
    case 'timeout_lap':
      return null;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
};

// R2: a phase that times out used to contribute NO sample at all — its
// slow tail was silently discarded, biasing every phase's percentiles
// optimistically (compounding R28's fast-head duplication in the SAME
// direction, on the SAME `ready_to_claim` metric DESIGN §3.3 sizes its
// timeouts from). Now it contributes a CENSORED sample: the real elapsed
// wait, tagged `censored: true`. `metrics/collector.ts` keeps censored
// samples OUT of the percentile arrays (a value capped at the configured
// timeout is not a latency measurement) but counts them, so
// `metrics/report.ts` can disclose "N more hops entered this phase and
// never finished it" next to the percentiles instead of the reader having
// no way to know the tail was cut.
const recordCensoredTimeoutPhase = (mut: Mut, outcome: TimeoutOutcome, now: number): void => {
  const info = timeoutPhaseInfo(mut.hop, outcome);
  if (info === null) return;
  recordPhase(mut, {
    phase: info.phase,
    startedAt: info.startedAt,
    durationMs: Math.max(0, now - info.startedAt),
    censored: true
  });
};

const failWithTimeout = (mut: Mut, outcome: TimeoutOutcome, now: number): void => {
  recordCensoredTimeoutPhase(mut, outcome, now);
  mut.hop = { ...mut.hop, timeouts: [...mut.hop.timeouts, outcome] };
  finish(mut, 'FAILED', outcome, now);
};

// Note N7.
const outcomeFromDriverError = (error: DriverError | undefined): Outcome => {
  const cls: ErrorClass | undefined = error?.errorClass;
  if (cls !== undefined) {
    switch (cls) {
      case 'not_ready':
        // A readiness gate is not an error (§5.3); a driver that surfaces one
        // as a throw has nothing better to say than "unclassified".
        return 'internal';
      case 'already_claimed':
        // Handled by the caller (T22) before it gets here.
        return 'internal';
      case 'console_error':
      case 'funding':
      case 'config':
        return 'internal';
      // R10/S26: `wallet_identity_mismatch` is only ever thrown by
      // `BrowserUser.init()`'s `assertConnectedWallet()`, before any hop
      // begins (runner.ts's `Promise.allSettled` over `driver.init()`
      // excludes the user from the run entirely on that failure) — no
      // ring/hop ever attributes an outcome to it in practice. Handled here
      // anyway so a future caller that DID attach this class to a mid-hop
      // `DriverError` still gets a safe, generic outcome instead of a type
      // error on this switch; the distinct classification survives in the
      // separately-reported `ErrorClass` regardless (same rationale as
      // `console_error`/`funding`/`config` above).
      case 'wallet_identity_mismatch':
        return 'internal';
      case 'lbt_underflow':
        return 'lbt_underflow';
      // R3 (loadtest/REVIEW.md): the hop's TERMINAL OUTCOME stays
      // `rpc_error` (no new `Outcome`/`FailureOutcome` member) — the
      // distinction lives one layer up, in the separately-reported
      // `ErrorClass` (`metrics/collector.ts`'s error-by-class table), which
      // is where a reader actually goes looking for "why did this hop
      // fail" attribution.
      case 'nonce_conflict':
        return 'rpc_error';
      default:
        return cls;
    }
  }
  if (error !== undefined && error.message.includes('LocalBalanceTreeUnderflow')) {
    return 'lbt_underflow';
  }
  return 'internal';
};

// ---------------------------------------------------------------------------
// Row matching (DESIGN §9.2)
// ---------------------------------------------------------------------------

const matchRow = (hop: Hop, rows: readonly ObservedRow[]): ObservedRow | undefined => {
  if (hop.rowKey !== null) return rows.find((row) => row.rowKey === hop.rowKey);
  if (hop.bridgeTxHash === null) return undefined;
  return rows.find(
    (row) =>
      row.transactionHash === hop.bridgeTxHash &&
      (hop.depositCount === null || row.depositCount === hop.depositCount)
  );
};

// ---------------------------------------------------------------------------
// Per-state event handling
// ---------------------------------------------------------------------------

// Applies the AWAITING_READY rows T13–T16 (and T27's counter) to a row we
// already matched. Split out because T12 cascades straight into it (note N4)
// and because T20's re-entry lands back here.
const applyAwaitingReady = (mut: Mut, row: ObservedRow, now: number): void => {
  const { expected } = mut.hop.spec.autoclaim;

  if (row.status === 'CLAIMED') {
    // T15 — autoclaim beat our poll.
    recordPhase(mut, phaseSample('ready_to_claim', now, mut.hop.stateEnteredAt));
    recordPhase(mut, phaseSample('claimed_observed', now, mut.hop.stateEnteredAt));
    // T27 — the route did not expect autoclaim, yet something claimed it.
    // Recorded, never failed (§3.4).
    if (!expected && !mut.hop.claimSubmitted) bumpCounter(mut, 'unexpected_autoclaim', now);
    mut.emissions.push({
      type: 'transition',
      transition: expected ? 'T15' : 'T27',
      from: mut.hop.state,
      to: 'DONE',
      at: now
    });
    finish(mut, 'DONE', 'hop_completed_auto', now);
    return;
  }

  if (row.status === 'ERROR') {
    // T16 — `claimed === 'error'` (app/services/activity.ts:151). Never read
    // as `false`.
    mut.emissions.push({
      type: 'transition',
      transition: 'T16',
      from: mut.hop.state,
      to: 'FAILED',
      at: now
    });
    finish(mut, 'FAILED', 'activity_status_error', now);
    return;
  }

  if (row.status !== 'READY_TO_CLAIM') return; // PENDING: keep polling.

  // R28 (loadtest/REVIEW.md): note N2 says T20's re-entry "does not
  // re-record the ready_to_claim phase" — the code did not honour that.
  // `readyAt === null` is true EXACTLY on the first time this hop has ever
  // observed READY_TO_CLAIM (it is set once, below, and never reset — T20's
  // re-entry keeps it per N2), so gating the phase record on it (rather
  // than recording unconditionally) means a T20 retry cycle (CLAIM_BUILD ->
  // claimable:false -> AWAITING_READY -> still READY_TO_CLAIM -> back to
  // CLAIM_BUILD) contributes exactly ONE `ready_to_claim` sample total,
  // not N+1 near-zero ones (goTo resets `stateEnteredAt` on every re-entry,
  // so the un-gated version measured only the poll interval since re-entry,
  // not a real "ready to claim" latency).
  const isFirstReadyObservation = mut.hop.readyAt === null;
  // First-observed READY_TO_CLAIM is the grace window's origin (§3.4).
  if (isFirstReadyObservation) {
    mut.hop = { ...mut.hop, readyAt: now };
    recordPhase(mut, phaseSample('ready_to_claim', now, mut.hop.stateEnteredAt));
  }

  if (expected && !mut.hop.escalated) {
    // T13 (guard per note N1). Entering the gate `claimed`; the grace window
    // may already have elapsed, which the immediate tick below escalates.
    goTo(mut, 'AWAITING_AUTOCLAIM', 'T13', now);
    applyAutoclaimDeadline(mut, now);
    return;
  }
  // T14
  goTo(mut, 'CLAIM_BUILD', 'T14', now, { claimStep: 'is_claimed' });
};

// T18: `now − readyAt >= waitMs`, still unclaimed. Not a failure — counter
// `autoclaim_overdue`++, the `claimed` gate stall is recorded by goTo's gate
// exit, and we escalate to a manual claim.
const applyAutoclaimDeadline = (mut: Mut, now: number): void => {
  if (mut.hop.state !== 'AWAITING_AUTOCLAIM') return;
  const readyAt = mut.hop.readyAt ?? mut.hop.stateEnteredAt;
  const waitMs = mut.hop.spec.autoclaim.waitMs ?? 0;
  if (now < readyAt + waitMs) return;
  bumpCounter(mut, 'autoclaim_overdue', now);
  mut.hop = { ...mut.hop, escalated: true };
  goTo(mut, 'CLAIM_BUILD', 'T18', now, { claimStep: 'is_claimed' });
};

const applyActivity = (mut: Mut, rows: readonly ObservedRow[], now: number): void => {
  const row = matchRow(mut.hop, rows);
  if (row === undefined) return;

  if (mut.hop.state === 'AWAITING_ACTIVITY') {
    // T12 — the row appeared. Pin the identity to `tx_hash:deposit_count`.
    recordPhase(mut, phaseSample('appears_in_activity', now, mut.hop.stateEnteredAt));
    mut.hop = { ...mut.hop, rowKey: row.rowKey, depositCount: row.depositCount };
    goTo(mut, 'AWAITING_READY', 'T12', now);
    // Note N4: a row already past PENDING is evaluated in the same event.
    applyAwaitingReady(mut, row, now);
    return;
  }

  if (mut.hop.state === 'AWAITING_READY') {
    applyAwaitingReady(mut, row, now);
    return;
  }

  if (mut.hop.state === 'AWAITING_AUTOCLAIM') {
    if (row.status === 'CLAIMED') {
      // T17
      recordPhase(mut, phaseSample('claimed_observed', now, mut.hop.stateEnteredAt));
      mut.emissions.push({
        type: 'transition',
        transition: 'T17',
        from: 'AWAITING_AUTOCLAIM',
        to: 'DONE',
        at: now
      });
      finish(mut, 'DONE', 'hop_completed_auto', now);
      return;
    }
    if (row.status === 'ERROR') {
      mut.emissions.push({
        type: 'transition',
        transition: 'T16',
        from: 'AWAITING_AUTOCLAIM',
        to: 'FAILED',
        at: now
      });
      finish(mut, 'FAILED', 'activity_status_error', now);
      return;
    }
    return;
  }

  if (mut.hop.state === 'AWAITING_CLAIMED' && row.status === 'CLAIMED') {
    // T26 — `hop_completed_manual`, or `hop_completed_escalated` when T18
    // fired for this hop.
    //
    // R32 (loadtest/REVIEW.md, dead code (a)): this branch used to also
    // compute `unexpected = !mut.hop.spec.autoclaim.expected &&
    // !mut.hop.claimSubmitted` and take a T27/`hop_completed_auto` arc when
    // true — but the ONLY entry to AWAITING_CLAIMED is T23
    // (CLAIM_PENDING's receipt success), reachable only after the
    // `claim_sent` handler has already set `claimSubmitted: true`. So
    // `unexpected` was always `false` here and that arc was unreachable
    // dead code (confirmed by reading, not just inspection — T27's OTHER
    // half, via the AWAITING_ACTIVITY/AWAITING_READY cascade, remains fully
    // reachable and is what `ring.test.ts`'s T27 test exercises). Deleted
    // rather than kept as a defensive-but-unreachable branch.
    recordPhase(mut, phaseSample('claimed_observed', now, mut.hop.stateEnteredAt));
    mut.emissions.push({
      type: 'transition',
      transition: 'T26',
      from: 'AWAITING_CLAIMED',
      to: 'DONE',
      at: now
    });
    finish(
      mut,
      'DONE',
      mut.hop.escalated ? 'hop_completed_escalated' : 'hop_completed_manual',
      now
    );
  }
};

// R30 (loadtest/REVIEW.md): the STANDALONE per-phase-timeout branch below
// (no drain, no `hopMs` also expiring) used to label its transition 'T28'
// unconditionally — but per DESIGN §3.2, 'T28' is specifically the `hopMs`
// umbrella row. Reusing it here meant T3/T5/T7/T9/T12–T14/T19–T23/T26's own
// timeout arcs never appeared under their own id in the emission stream,
// systematically undercounting every one of those rows and overcounting
// T28. This maps the CURRENT hop state (before `finish`/`failWithTimeout`
// mutate it) to the DESIGN §3.2 row whose "On timeout" column matches —
// used ONLY for the standalone case; the drain (T29) and `hopMs` (T28)
// umbrella branches are correctly labelled already, and still carry the
// phase-specific outcome as a `secondary_timeout` emission alongside them.
const timeoutTransitionId = (hop: Hop): TransitionId => {
  switch (hop.state) {
    case 'APPROVE_BUILD':
      return 'T3';
    case 'APPROVE_PENDING':
      return 'T5';
    case 'BRIDGE_BUILD':
      return 'T7';
    case 'BRIDGE_PENDING':
      return 'T9';
    case 'AWAITING_ACTIVITY':
      return 'T12';
    case 'AWAITING_READY':
      return hop.spec.autoclaim.expected ? 'T13' : 'T14';
    case 'CLAIM_BUILD':
      if (hop.claimStep === 'is_claimed') return 'T19';
      if (hop.claimStep === 'claim_inputs') return 'T20';
      return 'T21';
    case 'CLAIM_PENDING':
      return 'T23';
    case 'AWAITING_CLAIMED':
      return 'T26';
    default:
      // Every other state either has no timeout key (`hopDeadline` returns
      // null) or is handled by the umbrella branches above — unreachable in
      // practice, but 'T28' is the least-wrong fallback if it ever is.
      return 'T28';
  }
};

const applyTick = (mut: Mut, ctx: RingContext): void => {
  const { now, timeouts, drain } = ctx;

  // AWAITING_AUTOCLAIM's "deadline" is T18's escalation, handled first so a
  // drain/hop check does not pre-empt a hop that is about to keep moving.
  if (mut.hop.state === 'AWAITING_AUTOCLAIM') {
    applyAutoclaimDeadline(mut, now);
    if (isTerminalHopState(mut.hop.state)) return;
  }

  const deadline = hopDeadline(mut.hop, timeouts);
  const phaseTimedOut =
    deadline !== null && deadline.outcome !== null && now >= deadline.at ? deadline.outcome : null;
  const hopDeadlineAt = mut.hop.startedAt + timeouts.hopMs;

  // T29 — drain. Whichever of the drain deadline and this hop's own `hopMs`
  // budget comes first wins (§3.6 step 2 bounds the drain by both).
  if (drain !== undefined && now >= drain.deadlineAt && drain.deadlineAt <= hopDeadlineAt) {
    if (phaseTimedOut !== null) {
      // R2: record the censored phase sample BEFORE `finish` mutates
      // `mut.hop.state`/`stateEnteredAt` — `timeoutPhaseInfo` reads them.
      recordCensoredTimeoutPhase(mut, phaseTimedOut, now);
      mut.emissions.push({ type: 'secondary_timeout', timeout: phaseTimedOut, at: now });
    }
    mut.emissions.push({
      type: 'transition',
      transition: 'T29',
      from: mut.hop.state,
      to: 'FAILED',
      at: now
    });
    finish(mut, 'FAILED', 'aborted_drain', now);
    return;
  }

  // T28 — the `hopMs` umbrella. Its note: "the per-phase timeout outcome is
  // recorded too, when one also fired".
  if (now >= hopDeadlineAt) {
    if (phaseTimedOut !== null) {
      // R2, same reasoning as the drain branch above.
      recordCensoredTimeoutPhase(mut, phaseTimedOut, now);
      mut.hop = { ...mut.hop, timeouts: [...mut.hop.timeouts, phaseTimedOut] };
      mut.emissions.push({ type: 'secondary_timeout', timeout: phaseTimedOut, at: now });
    }
    mut.emissions.push({
      type: 'transition',
      transition: 'T28',
      from: mut.hop.state,
      to: 'FAILED',
      at: now
    });
    // `failWithTimeout(mut, 'timeout_hop', now)` also calls
    // `recordCensoredTimeoutPhase` internally, but `timeoutPhaseInfo` maps
    // `'timeout_hop'` to `null` (it is the umbrella outcome itself, not a
    // phase) — so this does not double-record the phase timeout above.
    failWithTimeout(mut, 'timeout_hop', now);
    return;
  }

  // R32 (loadtest/REVIEW.md, dead code (b)): a SECOND `drain` check used to
  // sit here. It was confirmed mathematically unreachable: if
  // `drain.deadlineAt <= hopDeadlineAt`, the FIRST drain branch above
  // already returned; if `drain.deadlineAt > hopDeadlineAt`, then reaching
  // this point without having returned means `now < hopDeadlineAt`
  // (the `now >= hopDeadlineAt` branch above would have returned
  // otherwise) — which contradicts `now >= drain.deadlineAt > hopDeadlineAt`.
  // T29 itself stays fully reachable via the first branch; deleted rather
  // than kept as unreachable defensive code.
  if (phaseTimedOut !== null) {
    // R30: this is the STANDALONE per-phase timeout (neither drain nor
    // `hopMs` also fired) — label it with the §3.2 row it actually came
    // from, not 'T28' (the `hopMs` umbrella's own id, handled above).
    // `failWithTimeout` records the censored phase sample itself.
    mut.emissions.push({
      type: 'transition',
      transition: timeoutTransitionId(mut.hop),
      from: mut.hop.state,
      to: 'FAILED',
      at: now
    });
    failWithTimeout(mut, phaseTimedOut, now);
  }
};

// ---------------------------------------------------------------------------
// advanceHop — the single entry point
// ---------------------------------------------------------------------------

export const advanceHop = (hop: Hop, event: RingEvent, ctx: RingContext): HopStep => {
  if (isTerminalHopState(hop.state)) return { hop, emissions: [] };

  const mut: Mut = { hop, emissions: [] };
  const { now } = ctx;

  switch (event.kind) {
    case 'tick':
      applyTick(mut, ctx);
      break;

    case 'browser_crash':
      // T30
      mut.emissions.push({
        type: 'transition',
        transition: 'T30',
        from: mut.hop.state,
        to: 'FAILED',
        at: now
      });
      finish(mut, 'FAILED', 'browser_crash', now);
      break;

    case 'allowance':
      if (mut.hop.state !== 'PLANNED') break;
      // T1 / T2. The `allowance` phase is recorded for ERC20 hops only.
      if (mut.hop.spec.assetKind === 'erc20') {
        recordPhase(mut, phaseSample('allowance', now, mut.hop.stateEnteredAt, event.timing));
        if (!event.sufficient) {
          goTo(mut, 'APPROVE_BUILD', 'T1', now);
          break;
        }
      }
      goTo(mut, 'BRIDGE_BUILD', 'T2', now);
      break;

    case 'approve_sent':
      if (mut.hop.state !== 'APPROVE_BUILD') break;
      // T3
      recordPhase(mut, phaseSample('approve_submit', now, mut.hop.stateEnteredAt, event.timing));
      goTo(mut, 'APPROVE_PENDING', 'T3', now);
      break;

    case 'approve_receipt':
      if (mut.hop.state !== 'APPROVE_PENDING') break;
      recordPhase(mut, phaseSample('approve_receipt', now, mut.hop.stateEnteredAt, event.timing));
      if (event.status === 'success') {
        // T5
        goTo(mut, 'BRIDGE_BUILD', 'T5', now);
      } else {
        // T6
        mut.emissions.push({
          type: 'transition',
          transition: 'T6',
          from: 'APPROVE_PENDING',
          to: 'FAILED',
          at: now
        });
        finish(mut, 'FAILED', 'revert_approve', now);
      }
      break;

    case 'bridge_sent':
      if (mut.hop.state !== 'BRIDGE_BUILD') break;
      // T7
      recordPhase(mut, phaseSample('bridge_submit', now, mut.hop.stateEnteredAt, event.timing));
      mut.hop = { ...mut.hop, bridgeTxHash: event.txHash };
      goTo(mut, 'BRIDGE_PENDING', 'T7', now);
      break;

    case 'bridge_receipt': {
      if (mut.hop.state !== 'BRIDGE_PENDING') break;
      recordPhase(mut, phaseSample('bridge_receipt', now, mut.hop.stateEnteredAt, event.timing));
      if (event.status === 'reverted') {
        // T10
        mut.emissions.push({
          type: 'transition',
          transition: 'T10',
          from: 'BRIDGE_PENDING',
          to: 'FAILED',
          at: now
        });
        finish(mut, 'FAILED', 'revert_bridge', now);
        break;
      }
      if (!event.bridgeEventFound || event.depositCount === null) {
        // T11 — receipt succeeded but no `BridgeEvent` log.
        mut.emissions.push({
          type: 'transition',
          transition: 'T11',
          from: 'BRIDGE_PENDING',
          to: 'FAILED',
          at: now
        });
        finish(mut, 'FAILED', 'bridge_event_missing', now);
        break;
      }
      // T9 — `depositCount` checkpointed.
      mut.hop = { ...mut.hop, depositCount: event.depositCount };
      if (mut.hop.bridgeTxHash !== null) {
        mut.hop = { ...mut.hop, rowKey: toRowKey(mut.hop.bridgeTxHash, event.depositCount) };
      }
      goTo(mut, 'AWAITING_ACTIVITY', 'T9', now);
      break;
    }

    case 'submit_error': {
      // T4 (approve) / T8 (bridge) / T22 (claim).
      if (event.step === 'claim' && event.error.errorClass === 'already_claimed') {
        // §5.3: `AlreadyClaimed()` resolves to `claim_race_lost` + success.
        bumpCounter(mut, 'claim_race_lost', now);
        mut.emissions.push({
          type: 'transition',
          transition: 'T22',
          from: mut.hop.state,
          to: 'DONE',
          at: now
        });
        finish(mut, 'DONE', 'hop_completed_raced', now);
        break;
      }
      const transition: TransitionId =
        event.step === 'approve' ? 'T4' : event.step === 'bridge' ? 'T8' : 'T22';
      mut.emissions.push({
        type: 'transition',
        transition,
        from: mut.hop.state,
        to: 'FAILED',
        at: now
      });
      finish(mut, 'FAILED', outcomeFromDriverError(event.error), now);
      break;
    }

    case 'activity':
      applyActivity(mut, event.rows, now);
      break;

    case 'is_claimed':
      if (mut.hop.state !== 'CLAIM_BUILD' || mut.hop.claimStep !== 'is_claimed') break;
      if (event.claimed) {
        // T19 — the race is lost, which is still a SUCCESS.
        bumpCounter(mut, 'claim_race_lost', now);
        mut.emissions.push({
          type: 'transition',
          transition: 'T19',
          from: 'CLAIM_BUILD',
          to: 'DONE',
          at: now
        });
        finish(mut, 'DONE', 'hop_completed_raced', now);
        break;
      }
      setStep(mut, 'claim_inputs', now);
      break;

    case 'claim_inputs':
      if (mut.hop.state !== 'CLAIM_BUILD') break;
      if (!event.claimable) {
        // T20 — counter, plus the gate the `reason` names (§5.4). Re-enters
        // AWAITING_READY and keeps polling (note N2).
        bumpCounter(mut, 'not_yet_claimable', now);
        goTo(mut, 'AWAITING_READY', 'T20', now, {
          gate: gateFromClaimInputsReason(event.reason)
        });
        break;
      }
      // T21's first half.
      recordPhase(mut, phaseSample('claim_inputs', now, mut.hop.stepStartedAt, event.timing));
      setStep(mut, 'submit', now);
      break;

    case 'claim_sent':
      if (mut.hop.state !== 'CLAIM_BUILD') break;
      // T21's second half.
      recordPhase(mut, phaseSample('claim_submit', now, mut.hop.stepStartedAt, event.timing));
      mut.hop = { ...mut.hop, claimTxHash: event.txHash, claimSubmitted: true };
      goTo(mut, 'CLAIM_PENDING', 'T21', now);
      break;

    case 'claim_receipt':
      if (mut.hop.state !== 'CLAIM_PENDING') break;
      recordPhase(mut, phaseSample('claim_receipt', now, mut.hop.stateEnteredAt, event.timing));
      if (event.status === 'success') {
        // T23
        goTo(mut, 'AWAITING_CLAIMED', 'T23', now);
        break;
      }
      if (event.isClaimedRecheck === true) {
        // T24 — reverted, but the deposit IS claimed: race lost, success.
        bumpCounter(mut, 'claim_race_lost', now);
        mut.emissions.push({
          type: 'transition',
          transition: 'T24',
          from: 'CLAIM_PENDING',
          to: 'DONE',
          at: now
        });
        finish(mut, 'DONE', 'hop_completed_raced', now);
        break;
      }
      // T25
      mut.emissions.push({
        type: 'transition',
        transition: 'T25',
        from: 'CLAIM_PENDING',
        to: 'FAILED',
        at: now
      });
      finish(mut, 'FAILED', 'revert_claim', now);
      break;

    default:
      break;
  }

  return { hop: mut.hop, emissions: mut.emissions };
};

// ---------------------------------------------------------------------------
// Lap driving (DESIGN §3.2's L1–L4)
// ---------------------------------------------------------------------------

export const advanceLap = (lap: Lap, event: RingEvent, ctx: RingContext): LapStep => {
  if (lap.state !== 'LAP_RUNNING') return { lap, emissions: [] };

  const current = lap.hops[lap.currentHopIndex];
  if (current === undefined) return { lap, emissions: [] };

  const { hop, emissions } = advanceHop(current, event, ctx);
  let hops = lap.hops.map((entry, index) => (index === lap.currentHopIndex ? hop : entry));
  let next: Lap = { ...lap, hops };
  const all = emissions.slice();
  const { now } = ctx;

  if (hop.state === 'DONE') {
    const isLast = hop.spec.hopIndex >= lap.hopSpecs.length - 1;
    if (isLast) {
      // L2
      all.push({
        type: 'phase',
        phase: 'lap_total',
        startedAt: lap.startedAt,
        durationMs: Math.max(0, now - lap.startedAt)
      });
      all.push({ type: 'lap_transition', transition: 'L2', lapState: 'LAP_DONE', at: now });
      return { lap: { ...next, state: 'LAP_DONE', endedAt: now }, emissions: all };
    }
    // L1 — hop i+1 is only ever created once hop i is DONE (§3.2's closing
    // paragraph: nothing is burned except gas).
    const spec = lap.hopSpecs[hop.spec.hopIndex + 1];
    if (spec === undefined) {
      all.push({ type: 'lap_transition', transition: 'L2', lapState: 'LAP_DONE', at: now });
      return { lap: { ...next, state: 'LAP_DONE', endedAt: now }, emissions: all };
    }
    hops = [
      ...hops,
      createHop({
        userId: lap.userId,
        lapId: lap.id,
        lapIndex: lap.lapIndex,
        spec,
        startedAt: now
      })
    ];
    all.push({ type: 'lap_transition', transition: 'L1', lapState: 'LAP_RUNNING', at: now });
    return {
      lap: { ...next, hops, currentHopIndex: lap.currentHopIndex + 1 },
      emissions: all
    };
  }

  if (hop.state === 'FAILED') {
    if (hop.outcome === 'aborted_drain') {
      // L4
      all.push({ type: 'lap_transition', transition: 'L4', lapState: 'LAP_ABORTED', at: now });
      return {
        lap: { ...next, state: 'LAP_ABORTED', endedAt: now, outcome: 'aborted_drain' },
        emissions: all
      };
    }
    // L3
    all.push({ type: 'lap_transition', transition: 'L3', lapState: 'LAP_FAILED', at: now });
    return {
      lap: { ...next, state: 'LAP_FAILED', endedAt: now, outcome: hop.outcome },
      emissions: all
    };
  }

  // L1/L2's timeout column: the `lapMs` umbrella. Note N6 — the outstanding
  // hop is failed too, so every hop keeps exactly one terminal outcome.
  if (event.kind === 'tick' && now >= lap.startedAt + ctx.timeouts.lapMs) {
    // R31 (loadtest/REVIEW.md): this hand-rolls closing an open gate visit
    // (setting `exitedAt`) rather than going through `exitGate`, which is
    // ALSO the only thing that ever emits a `gate_exit` RingEmission.
    // `runner.ts`'s `case 'gate_exit'` is what feeds
    // `collector.recordGateVisit` (§5.4's gate-stalls table) — so a gate
    // visit interrupted by `lapMs` used to be present in `Hop.gates` (and
    // therefore correct in `results.json`) but silently absent from the
    // Gate-stalls table, which is built from the streamed emissions alone.
    const openGate = hop.currentGate;
    const openVisit =
      openGate === null
        ? undefined
        : hop.gates.findLast((visit) => visit.gate === openGate && visit.exitedAt === null);
    if (openGate !== null) {
      all.push({
        type: 'gate_exit',
        gate: openGate,
        at: now,
        durationMs: openVisit === undefined ? 0 : Math.max(0, now - openVisit.enteredAt),
        timedOut: true
      });
    }
    const failed: Hop = {
      ...hop,
      state: 'FAILED',
      claimStep: null,
      outcome: 'timeout_lap',
      timeouts: [...hop.timeouts, 'timeout_lap'],
      currentGate: null,
      gates: hop.gates.map((visit) =>
        visit.exitedAt === null ? { ...visit, exitedAt: now } : visit
      )
    };
    all.push({ type: 'outcome', outcome: 'timeout_lap', at: now });
    all.push({ type: 'lap_transition', transition: 'L3', lapState: 'LAP_FAILED', at: now });
    next = {
      ...next,
      hops: hops.map((entry, index) => (index === lap.currentHopIndex ? failed : entry)),
      state: 'LAP_FAILED',
      endedAt: now,
      outcome: 'timeout_lap'
    };
    return { lap: next, emissions: all };
  }

  return { lap: next, emissions: all };
};

export type CreateRingLapParams = CreateLapParams;

export const createRingLap = (params: CreateRingLapParams): Lap => createLap(params);

// ---------------------------------------------------------------------------
// Driver-result → event mappers (so the S11 runner holds no machine logic)
// ---------------------------------------------------------------------------

const txEvents = (
  step: 'approve' | 'bridge' | 'claim',
  result: TxStepResult,
  sentEvent: (txHash: Hex, timing?: StepTiming) => RingEvent,
  receiptEvent: (status: ReceiptStatus, timing?: StepTiming) => RingEvent
): RingEvent[] => {
  if (result.error !== undefined || result.txHash === null) {
    return [
      { kind: 'submit_error', step, error: result.error ?? { message: 'send did not resolve' } }
    ];
  }
  const events: RingEvent[] = [sentEvent(result.txHash, result.submit)];
  if (result.receipt !== null) {
    events.push(receiptEvent(result.receipt.status, result.receipt.timing));
  }
  return events;
};

export const eventsFromBridge = (submission: BridgeSubmission): RingEvent[] => {
  const events: RingEvent[] = [];
  if (submission.allowance !== null) {
    events.push({
      kind: 'allowance',
      sufficient: submission.allowance.sufficient,
      timing: submission.allowance.timing
    });
  } else {
    events.push({ kind: 'allowance', sufficient: true });
  }
  if (submission.approve !== null) {
    events.push(
      ...txEvents(
        'approve',
        submission.approve,
        (txHash, timing) => ({ kind: 'approve_sent', txHash, timing }),
        (status, timing) => ({ kind: 'approve_receipt', status, timing })
      )
    );
  }
  if (submission.bridge !== null) {
    events.push(
      ...txEvents(
        'bridge',
        submission.bridge,
        (txHash, timing) => ({ kind: 'bridge_sent', txHash, timing }),
        (status, timing) => ({
          kind: 'bridge_receipt',
          status,
          timing,
          depositCount: submission.depositCount,
          bridgeEventFound: submission.bridgeEventFound
        })
      )
    );
  }
  return events;
};

export const eventsFromClaim = (submission: ClaimSubmission): RingEvent[] => {
  const events: RingEvent[] = [
    { kind: 'is_claimed', claimed: submission.isClaimedBefore, timing: submission.isClaimedTiming }
  ];
  if (submission.isClaimedBefore) return events;

  const inputs: ClaimInputsResult | null = submission.claimInputs;
  if (inputs === null) {
    // S16/A2 (VALIDATION-1.md): a driver may fail before it can even
    // determine `claimInputs` (e.g. a UI whose claim button never became
    // clickable) and still attach its own classified `DriverError` to
    // `submission.claim.error`. That error must never be silently dropped
    // here — doing so left the hop parked at its `claim_inputs` step with
    // no error event at all, so it later timed out as `timeout_not_claimable`
    // (a devnet-shaped outcome) instead of failing on the driver's own
    // error. Core invariant: no `DriverError` a driver returns may ever be
    // dropped by this mapper.
    if (submission.claim?.error !== undefined) {
      events.push({ kind: 'submit_error', step: 'claim', error: submission.claim.error });
    }
    return events;
  }
  events.push({
    kind: 'claim_inputs',
    claimable: inputs.claimable,
    reason: inputs.reason,
    timing: inputs.timing
  });
  if (!inputs.claimable || submission.claim === null) return events;

  events.push(
    ...txEvents(
      'claim',
      submission.claim,
      (txHash, timing) => ({ kind: 'claim_sent', txHash, timing }),
      (status, timing) => ({
        kind: 'claim_receipt',
        status,
        timing,
        isClaimedRecheck: submission.isClaimedRecheck
      })
    )
  );
  return events;
};

// ---------------------------------------------------------------------------
// Engine facade — the injected-clock surface the runner uses
// ---------------------------------------------------------------------------

export interface RingEngine {
  readonly clock: Clock;
  readonly timeouts: RingTimeouts;
  startLap(params: Omit<CreateRingLapParams, 'startedAt'>): Lap;
  apply(lap: Lap, event: RingEvent, drain?: { deadlineAt: number }): LapStep;
  applyAll(lap: Lap, events: readonly RingEvent[], drain?: { deadlineAt: number }): LapStep;
  action(lap: Lap): RingAction;
  deadline(lap: Lap): HopDeadline | null;
}

export const createRingEngine = (params: { clock: Clock; timeouts: RingTimeouts }): RingEngine => {
  const { clock, timeouts } = params;
  const currentHop = (lap: Lap): Hop | undefined => lap.hops[lap.currentHopIndex];

  return {
    clock,
    timeouts,
    startLap: (lapParams) => createRingLap({ ...lapParams, startedAt: clock.now() }),
    apply: (lap, event, drain) => advanceLap(lap, event, { now: clock.now(), timeouts, drain }),
    applyAll: (lap, events, drain) => {
      let current = lap;
      const emissions: RingEmission[] = [];
      for (const event of events) {
        const step = advanceLap(current, event, { now: clock.now(), timeouts, drain });
        current = step.lap;
        emissions.push(...step.emissions);
      }
      return { lap: current, emissions };
    },
    action: (lap) => {
      const hop = currentHop(lap);
      return hop === undefined || lap.state !== 'LAP_RUNNING' ? { kind: 'none' } : nextAction(hop);
    },
    deadline: (lap) => {
      const hop = currentHop(lap);
      return hop === undefined ? null : hopDeadline(hop, timeouts);
    }
  };
};

// Shared vocabulary for the pure ring core — DESIGN §3 (states §3.1,
// transitions §3.2, timeouts §3.3, counters §3.4) plus the metric names the
// S07 collector aggregates (§5.1 phases, §5.3 error classes, §5.4 gates).
//
// Nothing in `loadtest/core/` performs I/O: this file, ring.ts, scheduler.ts
// and userDriver.ts import only `zod`-free, transport-free types (the single
// external import in the directory is `import type { Address, Hex } from
// 'viem'`, erased at compile time). All time enters through an injected
// clock or an explicit `now` argument.

import type { Hex } from 'viem';

// ---------------------------------------------------------------------------
// States (DESIGN §3.1)
// ---------------------------------------------------------------------------

export type HopState =
  | 'PLANNED'
  | 'APPROVE_BUILD'
  | 'APPROVE_PENDING'
  | 'BRIDGE_BUILD'
  | 'BRIDGE_PENDING'
  | 'AWAITING_ACTIVITY'
  | 'AWAITING_READY'
  | 'AWAITING_AUTOCLAIM'
  | 'CLAIM_BUILD'
  | 'CLAIM_PENDING'
  | 'AWAITING_CLAIMED'
  | 'DONE'
  | 'FAILED';

export type LapState = 'LAP_RUNNING' | 'LAP_DONE' | 'LAP_FAILED' | 'LAP_ABORTED';

export const TERMINAL_HOP_STATES: readonly HopState[] = ['DONE', 'FAILED'];

export const isTerminalHopState = (state: HopState): boolean =>
  state === 'DONE' || state === 'FAILED';

// `CLAIM_BUILD` is a single DESIGN §3.1 state with three sequential reads
// (T19 `isClaimed`, T20 `getClaimInputs`, T21/T22 build+send). Its timeout
// key is one value (`claimedMs`) but its timeout OUTCOME differs per row of
// the transition table, so the pending sub-step has to be part of the state.
export type ClaimStep = 'is_claimed' | 'claim_inputs' | 'submit';

// ---------------------------------------------------------------------------
// Transition ids — every emission carries the DESIGN §3.2 row it came from,
// so a test (and S20's audit) can assert the table itself, not a paraphrase.
// ---------------------------------------------------------------------------

export type TransitionId =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'T7'
  | 'T8'
  | 'T9'
  | 'T10'
  | 'T11'
  | 'T12'
  | 'T13'
  | 'T14'
  | 'T15'
  | 'T16'
  | 'T17'
  | 'T18'
  | 'T19'
  | 'T20'
  | 'T21'
  | 'T22'
  | 'T23'
  | 'T24'
  | 'T25'
  | 'T26'
  | 'T27'
  | 'T28'
  | 'T29'
  | 'T30'
  | 'L1'
  | 'L2'
  | 'L3'
  | 'L4';

// ---------------------------------------------------------------------------
// Phases (DESIGN §5.1) and timeout keys (§3.3)
// ---------------------------------------------------------------------------

export type Phase =
  | 'page_load'
  | 'wallet_connect'
  | 'allowance'
  | 'approve_submit'
  | 'approve_receipt'
  | 'bridge_submit'
  | 'bridge_receipt'
  | 'appears_in_activity'
  | 'ready_to_claim'
  | 'claim_inputs'
  | 'claim_submit'
  | 'claim_receipt'
  | 'claimed_observed'
  | 'hop_total'
  | 'lap_total';

export type TimeoutKey =
  | 'txReceiptMs'
  | 'appearsInActivityMs'
  | 'readyToClaimMs'
  | 'claimedMs'
  | 'hopMs'
  | 'lapMs'
  | 'pageLoadMs'
  | 'walletConnectMs'
  // Not a failure budget: T18's autoclaim grace window, whose expiry
  // escalates to a manual claim (DESIGN §3.4).
  | 'autoclaimWaitMs';

// The subset of `LoadtestConfig['timeouts']` the ring core needs. Declared
// structurally rather than imported from config/schema.ts so the state
// machine stays testable without building a whole config.
export interface RingTimeouts {
  txReceiptMs: number;
  appearsInActivityMs: number;
  readyToClaimMs: number;
  claimedMs: number;
  hopMs: number;
  lapMs: number;
}

// ---------------------------------------------------------------------------
// Outcomes (DESIGN §3.2 + §5.3)
// ---------------------------------------------------------------------------

// A lost claim race is a SUCCESS (T19/T22/T24, aggkit DESIGN §8), and an
// escalated hop that completes is a success too (T26) — neither is a failure
// outcome, which is the single most important deliberate divergence from
// aggkit's Go tool.
export type SuccessOutcome =
  | 'hop_completed_auto'
  | 'hop_completed_manual'
  | 'hop_completed_escalated'
  | 'hop_completed_raced';

export type TimeoutOutcome =
  | 'timeout_approve_submit'
  | 'timeout_approve_receipt'
  | 'timeout_bridge_submit'
  | 'timeout_bridge_receipt'
  | 'timeout_appears_in_activity'
  | 'timeout_ready_to_claim'
  | 'timeout_claim_build'
  | 'timeout_not_claimable'
  | 'timeout_claim_submit'
  | 'timeout_claim_receipt'
  | 'timeout_claimed_observed'
  | 'timeout_hop'
  | 'timeout_lap';

// DESIGN §5.3's classifier classes. `metrics/errors.ts` (S07) assigns these;
// the ring core only consumes an already-classified value off an event, so
// the classifier's typed-evidence rule stays in one place. Two members are
// never terminal outcomes and are handled specially by ring.ts:
// `not_ready` (a gate stall, not an error) and `already_claimed` (which
// resolves to `claim_race_lost` + hop success).
export type ErrorClass =
  | 'not_ready'
  | 'proxy_4xx'
  | 'proxy_5xx'
  | 'rpc_error'
  // R3 (loadtest/REVIEW.md): a deliberate decision, not a patch. There is
  // NO per-(user, chain) nonce serialization on the user send path
  // (`ChainNonceManager` is funder-only) — `maxInflightLapsPerUser` puts up
  // to 3 (6 with two assets, R34) concurrent sends on one EOA, and viem's
  // `prepareTransactionRequest` re-derives a fresh nonce per send (finding
  // C4's dropped-nonce parity with the UI), so collisions are a KNOWN,
  // self-inflicted consequence of running the ring concurrently — NOT the
  // system-under-test misbehaving. The chosen resolution keeps UI parity
  // (a real user's wallet does exactly what this does) and instead makes
  // the collisions HONEST: classified separately from `rpc_error` (a class
  // that reads as the proxy/chain's fault) rather than serializing sends
  // (which would diverge from the UI). See DESIGN §9.4's closing rule and
  // `metrics/errors.ts`'s classifiers for where this is applied.
  | 'nonce_conflict'
  | 'tx_revert'
  | 'lbt_underflow'
  | 'already_claimed'
  | 'ui_assertion'
  | 'browser_crash'
  | 'console_error'
  | 'funding'
  | 'config'
  // R10 (loadtest/REVIEW.md), fixed S26: a browser context's connected
  // wallet did not match the address the driver derived for this user (or
  // — the catastrophic case — matched the build-time E2E fallback key
  // `0x6Aa7F0e2397117D732a1d6A76D8A25fdC0bA7B07`, meaning the per-context
  // `window.__AGGLAYER_E2E_PRIVATE_KEY__` override silently failed to
  // apply). Deliberately its OWN class rather than folded into `internal`:
  // this failure mode invalidates every measurement for that user (wrong
  // signer, wrong nonces), so it must never be indistinguishable in the
  // error-by-class table from a generic setup failure. Thrown once, at
  // `BrowserUser.init()`'s `assertConnectedWallet()`, before any hop can
  // run — see `core/ring.ts`'s `outcomeFromDriverError` for why the ring
  // itself never needs to turn this into a `FailureOutcome`.
  | 'wallet_identity_mismatch'
  | 'internal';

export type FailureOutcome =
  | TimeoutOutcome
  | 'revert_approve'
  | 'revert_bridge'
  | 'revert_claim'
  | 'bridge_event_missing'
  | 'activity_status_error'
  | 'lbt_underflow'
  | 'aborted_drain'
  | 'browser_crash'
  | 'proxy_4xx'
  | 'proxy_5xx'
  | 'rpc_error'
  | 'tx_revert'
  | 'ui_assertion'
  | 'internal';

export type Outcome = SuccessOutcome | FailureOutcome;

export const SUCCESS_OUTCOMES: readonly SuccessOutcome[] = [
  'hop_completed_auto',
  'hop_completed_manual',
  'hop_completed_escalated',
  'hop_completed_raced'
];

export const isSuccessOutcome = (outcome: Outcome): outcome is SuccessOutcome =>
  (SUCCESS_OUTCOMES as readonly Outcome[]).includes(outcome);

// ---------------------------------------------------------------------------
// Counters (DESIGN §3.4) and gates (§5.4)
// ---------------------------------------------------------------------------

// All four are recorded counters that do NOT fail a hop. aggkit's Go tool
// treats `autoclaim_overdue` and `unexpected_autoclaim` as fatal claim-mode
// violations; this tool deliberately does not (DESIGN §3.4).
export type HopCounter =
  | 'autoclaim_overdue'
  | 'unexpected_autoclaim'
  | 'claim_race_lost'
  | 'not_yet_claimable';

// R32 (loadtest/REVIEW.md, dead code (d)): a `SchedulerCounter` type used to
// live here (`'skipped_backpressure' | 'ticks_lost_to_ramp'`) — confirmed
// orphaned (zero references anywhere outside its own definition; the real
// scheduler counters are `core/scheduler.ts`'s `SchedulerCounters`
// interface, a different, camelCase shape with `ticksIssued`/
// `ticksOffered` besides). Deleted rather than kept as stale dead code.

export type Gate =
  | 'activity-index'
  | 'l1-info-tree-index'
  | 'injected-l1-info-leaf'
  | 'claim-proof'
  | 'claimed'
  | 'syncer-inconsistent';

// ---------------------------------------------------------------------------
// Activity rows (DESIGN §9.2 — identity is `tx_hash:deposit_count`)
// ---------------------------------------------------------------------------

// Mirrors `app/types/transaction.ts`'s `TransactionStatus` exactly, including
// 'ERROR' (`claimed === 'error'`, app/services/activity.ts:151). 'ERROR' is a
// distinct member of a string union precisely so it can never be read as a
// falsy "not claimed" — T16 maps it to `activity_status_error`.
export type ActivityRowStatus = 'PENDING' | 'READY_TO_CLAIM' | 'CLAIMED' | 'ERROR';

export interface ObservedRow {
  // `${transactionHash}:${depositCount}` — DESIGN §9.2. Never `bridge_hash`
  // (a content hash a load test collides on constantly) and never
  // `global_index` (precision-unsafe).
  rowKey: string;
  status: ActivityRowStatus;
  statusError?: string;
  transactionHash: Hex;
  depositCount: number;
  sourceNetwork: number;
  destinationNetwork: number;
  globalIndex?: string;
  claimTransactionHash?: Hex;
}

export const toRowKey = (transactionHash: Hex, depositCount: number): string =>
  `${transactionHash}:${depositCount}`;

// ---------------------------------------------------------------------------
// Hop / lap / ring records
// ---------------------------------------------------------------------------

export type AssetKind = 'eth' | 'erc20';

export interface HopAutoclaim {
  expected: boolean;
  // Present iff `expected` (config schema's AUTOCLAIM_WAIT_REQUIRED rule).
  waitMs?: number;
}

// The immutable description of one ring hop for one asset — what a driver is
// handed. `hopRoute` is DESIGN §5.1's histogram label ("L1->L2A").
export interface HopSpec {
  hopIndex: number;
  hopRoute: string;
  fromChainKey: string;
  toChainKey: string;
  fromNetworkId: number;
  toNetworkId: number;
  assetIndex: number;
  assetKind: AssetKind;
  assetAddress?: Hex;
  amount: string;
  decimals: number;
  autoclaim: HopAutoclaim;
}

export interface PhaseSample {
  phase: Phase;
  startedAt: number;
  durationMs: number;
  // R2 (loadtest/REVIEW.md): true for a sample recorded on the TIMEOUT path
  // (`core/ring.ts`'s `recordCensoredTimeoutPhase`) rather than a real
  // completion — the duration is real elapsed time, but it is bounded by
  // the configured timeout, not a latency measurement, so
  // `metrics/collector.ts` keeps it out of the percentile arrays and counts
  // it separately instead. Absent (never `false`) on every ordinary sample,
  // so existing snapshots/tests that never set it are unaffected.
  censored?: boolean;
}

export interface GateVisit {
  gate: Gate;
  enteredAt: number;
  exitedAt: number | null;
}

export type HopCounters = Record<HopCounter, number>;

export const emptyHopCounters = (): HopCounters => ({
  autoclaim_overdue: 0,
  unexpected_autoclaim: 0,
  claim_race_lost: 0,
  not_yet_claimable: 0
});

export interface Hop {
  readonly id: string;
  readonly userId: string;
  readonly lapId: string;
  readonly lapIndex: number;
  readonly spec: HopSpec;
  readonly state: HopState;
  // Sub-step of CLAIM_BUILD; null in every other state.
  readonly claimStep: ClaimStep | null;
  readonly startedAt: number;
  readonly stateEnteredAt: number;
  // When the pending sub-step started, for the fine-grained §5.1 phases that
  // are narrower than a whole state (`claim_inputs`, `claim_submit`).
  readonly stepStartedAt: number;
  readonly bridgeTxHash: Hex | null;
  readonly claimTxHash: Hex | null;
  readonly depositCount: number | null;
  readonly rowKey: string | null;
  // First-observed READY_TO_CLAIM, the origin of the autoclaim grace window
  // (DESIGN §3.4, mirroring app/hooks/useAutoclaimGate.ts's `readyAt`).
  readonly readyAt: number | null;
  // T18 fired: the hop is in manual mode from here on, and a manual
  // completion is reported as `hop_completed_escalated` (T26).
  readonly escalated: boolean;
  // We sent a claim transaction — the guard that keeps T27
  // (`unexpected_autoclaim`) from firing on our own claim.
  readonly claimSubmitted: boolean;
  readonly counters: HopCounters;
  readonly phases: readonly PhaseSample[];
  readonly gates: readonly GateVisit[];
  readonly currentGate: Gate | null;
  readonly outcome: Outcome | null;
  // Every timeout that fired on this hop, in order. Normally one; T28 records
  // both the phase timeout and `timeout_hop` when they fire together.
  readonly timeouts: readonly TimeoutOutcome[];
}

export interface Lap {
  readonly id: string;
  readonly userId: string;
  readonly lapIndex: number;
  readonly assetIndex: number;
  // The ring's full hop-spec list for this lap's asset. Carried on the lap
  // (not looked up externally) so `advanceLap` can create hop `i+1` on L1
  // without any ambient state.
  readonly hopSpecs: readonly HopSpec[];
  readonly state: LapState;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly hops: readonly Hop[];
  readonly currentHopIndex: number;
  readonly outcome: Outcome | null;
}

export const isTerminalLapState = (state: LapState): boolean => state !== 'LAP_RUNNING';

// One user's independent ring for ONE asset kind (DESIGN §3.5's "asset
// interleaving": each user runs one ring per asset, and a bucket tick picks
// among them round-robin).
export interface UserRing {
  readonly userId: string;
  readonly assetIndex: number;
  readonly hopSpecs: readonly HopSpec[];
  readonly inflight: readonly Lap[];
  readonly nextLapIndex: number;
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
}

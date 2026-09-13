// The `userDriver` contract — DESIGN §1.1, implemented twice and identically
// observable: `workers/headless/headlessUser.ts` (S08) and
// `workers/browser/browserUser.ts` (S10).
//
// The interface is intentionally coarse (one call per DESIGN §3.2 cluster of
// transitions) while its RESULTS are fine-grained: every sub-step reports its
// own `StepTiming` and its own failure, so `ring.ts` still owns every state
// transition, every phase timer and every timeout. `eventsFromBridge` /
// `eventsFromClaim` in ring.ts turn one driver result into the exact sequence
// of `RingEvent`s the state machine consumes, so the S11 runner is a loop
// with no state-machine knowledge of its own.
//
// Both implementations MUST emit the same §5.1 phase timers and the same
// §5.2 `endpointClass` HTTP samples. The only permitted behavioural
// divergence is `gas.bridgeGasOffset` (§9.4 / finding C4).

import type { Address, Hex } from 'viem';

import type { ErrorClass, HopSpec, ObservedRow } from './types';

export type DriverMode = 'browser' | 'headless';

export interface StepTiming {
  startedAt: number;
  durationMs: number;
}

// A driver-side failure, already classified by `metrics/errors.ts` (S07) on
// typed evidence. `message` is kept so ring.ts can apply DESIGN §3.7's
// `LocalBalanceTreeUnderflow` rule when no classifier ran (tests, and any
// driver that reports raw errors).
export interface DriverError {
  message: string;
  errorClass?: ErrorClass;
}

export type ReceiptStatus = 'success' | 'reverted';

// One submitted transaction: the build+send window, then the receipt wait.
// `receipt: null` with no `error` means the send never resolved (the runner
// hit the phase deadline first) — ring.ts's tick handles that, not this type.
export interface TxStepResult {
  txHash: Hex | null;
  submit: StepTiming;
  receipt: { status: ReceiptStatus; timing: StepTiming } | null;
  error?: DriverError;
}

export interface AllowanceRead {
  sufficient: boolean;
  timing: StepTiming;
}

// `bridge()`'s result: the optional ERC20 allowance read (T1/T2), the
// optional approve (T3–T6), the bridgeAsset tx (T7–T10) and the
// `BridgeEvent` decode (T9/T11 — scan ALL receipt logs, an ERC20 bridge also
// emits `Transfer`).
export interface BridgeSubmission {
  allowance: AllowanceRead | null;
  approve: TxStepResult | null;
  bridge: TxStepResult | null;
  depositCount: number | null;
  bridgeEventFound: boolean;
  /**
   * VALIDATION-1.md A8: when `bridgeEventFound` is `false` because the
   * driver's own (node-side, `harness`-origin) receipt fetch/log-decode
   * THREW — rather than genuinely finding no matching log in a receipt it
   * successfully read — the classified underlying error, so it is reported
   * (as `rpc_error`, typically) instead of silently manufacturing a
   * `bridge_event_missing` hop outcome that reads as "the chain did not
   * emit a BridgeEvent" when the real cause was a transient RPC hiccup.
   * `core/ring.ts`'s T11 outcome is unchanged either way (the decode
   * genuinely did not produce a depositCount) — this only makes the CAUSE
   * visible in the errors table rather than swallowed by a bare `catch {}`.
   */
  bridgeEventDecodeError?: DriverError;
}

// `getClaimInputs`'s `reason` is an OPEN union (SDK doc) — recorded verbatim,
// never `assertNever`d.
export interface ClaimInputsResult {
  claimable: boolean;
  reason?: string;
  timing: StepTiming;
}

// `claim()`'s result, in the UI's own order (app/hooks/useClaimExecution.ts):
// `isClaimed` once before building (P14), then `getClaimInputs`
// (l1-info-tree-index → injected-l1-info-leaf → claim-proof), then build+send
// + receipt. `isClaimedRecheck` carries finding C3's post-throw retry loop
// (up to 3 more reads at 0/400/1000 ms, stopping at the first `true`) and the
// post-revert re-check T24/T25 branch on.
export interface ClaimSubmission {
  isClaimedBefore: boolean;
  isClaimedTiming: StepTiming;
  claimInputs: ClaimInputsResult | null;
  claim: TxStepResult | null;
  isClaimedRecheck: boolean | null;
}

// `readState()`: the two idempotent reads that make a hop re-derivable from
// `(bridgeTxHash, sourceNetworkId)` after an interruption (DESIGN §3 intro,
// aggkit's resumability rule). `allowanceSufficient` is null for ETH hops.
export interface HopReadState {
  allowanceSufficient: boolean | null;
  isClaimed: boolean;
}

export interface UserDriver {
  readonly userId: string;
  readonly mode: DriverMode;
  readonly address: Address;

  // browser: launch context, navigate, connect (phases `page_load`,
  // `wallet_connect`); headless: construct clients.
  init(): Promise<void>;
  // approve? + bridgeAsset.
  bridge(hop: HopSpec): Promise<BridgeSubmission>;
  // The UI's activity poll — parsed with `parseActivityResponse` semantics
  // (DESIGN §9.2: text + `quotePrecisionUnsafeIntegers`, row identity
  // `tx_hash:deposit_count`, READY_TO_CLAIM derived client-side).
  observeActivity(): Promise<ObservedRow[]>;
  claim(hop: HopSpec, row: ObservedRow): Promise<ClaimSubmission>;
  readState(hop: HopSpec, row: ObservedRow | null): Promise<HopReadState>;
  dispose(): Promise<void>;
}

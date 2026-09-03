import { BaseError, UserRejectedRequestError } from 'viem';

// EIP-1193's "User Rejected Request" error code. Every injected wallet that
// implements the spec returns this when the user dismisses a prompt, and it
// is the machine-readable signal that does NOT depend on the wallet's error
// copy or the user's locale.
const EIP1193_USER_REJECTED = 4001;

// Fallback only -- see isUserRejectionError. Kept because the *displayed*
// error (ClaimResultModal) only ever receives an already-flattened
// `error.message` string, never the thrown object, so a substring match is
// the only check available at that layer.
const REJECTION_MESSAGE_FRAGMENTS = ['rejected', 'denied', 'user refused'];

// Message-only rejection check, for callers that hold nothing but a string
// (ClaimExecutionState.error.message). Necessarily approximate: a wallet
// that reports a rejection in a non-English message, or an unrelated error
// whose text happens to contain "rejected", both fool it. Prefer
// isUserRejectionError below wherever the thrown value itself is in scope.
export const isUserRejectionMessage = (message?: string): boolean => {
  if (!message) return false;
  const lowerMessage = message.toLowerCase();
  return REJECTION_MESSAGE_FRAGMENTS.some((fragment) => lowerMessage.includes(fragment));
};

const hasUserRejectedCode = (candidate: unknown): boolean =>
  typeof candidate === 'object' &&
  candidate !== null &&
  'code' in candidate &&
  (candidate as { code?: unknown }).code === EIP1193_USER_REJECTED;

// Walks a thrown value's `cause` chain, depth-bounded so a self-referential
// or pathologically deep chain can't spin. Used for raw EIP-1193 errors that
// viem did not wrap into one of its own classes (viem-wrapped ones are
// handled by BaseError.walk instead).
const someCause = (error: unknown, predicate: (candidate: unknown) => boolean): boolean => {
  let candidate: unknown = error;
  for (let depth = 0; depth < 10 && candidate !== null && candidate !== undefined; depth += 1) {
    if (predicate(candidate)) return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
};

// Did the user dismiss the wallet prompt?
//
// Checked typed-first, per review comment 3862948256 (C7), which asked
// specifically for "viem's UserRejectedRequestError / code 4001":
//
//  1. `BaseError.walk` for viem's own `UserRejectedRequestError`. The walk
//     matters -- viem does NOT throw it at the top level: `sendTransaction`
//     surfaces a `TransactionExecutionError` with the rejection as its
//     `cause`, so a bare `instanceof UserRejectedRequestError` on the caught
//     value is always false.
//  2. A raw `code === 4001` anywhere down the `cause` chain, for a provider
//     error that reached us without viem mapping it.
//  3. Only then the message substrings, for anything that carries neither.
//
// Steps 1-2 are locale- and copy-independent, which the substring check is
// not: a wallet returning `{ code: 4001, message: 'Usuario canceló la
// solicitud' }` is a rejection that no English substring list can see.
export const isUserRejectionError = (error: unknown): boolean => {
  if (error instanceof BaseError && error.walk((e) => e instanceof UserRejectedRequestError)) {
    return true;
  }
  if (someCause(error, hasUserRejectedCode)) return true;
  return isUserRejectionMessage(error instanceof Error ? error.message : String(error));
};

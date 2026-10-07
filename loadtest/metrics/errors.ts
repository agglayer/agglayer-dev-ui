// DESIGN §5.3 — the error taxonomy classifier. Maps typed evidence (an
// aggkit-proxy HTTP response, a JSON-RPC/transport failure, a mined-revert
// receipt, a Playwright locator failure, a browser crash, a page console
// message, a `wallets/fund.ts` failure, a config failure) onto the
// `ErrorClass` union `core/types.ts` already defines (S06). Classification
// is on TYPED evidence per DESIGN §5.3's own rule, except the two cases the
// table names explicitly as free-text-only:
//
//   * the not-ready body-text rule (`matchesNotReady` below) — no proxy
//     response carries a machine-readable "not ready yet" field, only prose;
//   * the `AlreadyClaimed()` selector match — the one selector match this
//     taxonomy permits (DESIGN §5.3).
//
// Every message this module returns has already been through
// `wallets/redact.ts`'s `redactSecrets` / `redactError` — this file does
// NOT re-derive a redaction pattern (S07 constraint: reuse, don't duplicate).
//
// `core/` stays pure and I/O-free; this file is deliberately NOT in
// `core/` even though it produces `core/types.ts`'s `ErrorClass` values —
// `ring.ts` only ever *consumes* an already-classified `DriverError`
// (`core/ring.ts` note N7), it never imports this module.

import type { ErrorClass } from '../core/types';

import { redactError, redactSecrets } from '../wallets/redact';

export interface ClassifiedError {
  errorClass: ErrorClass;
  message: string;
}

// ---------------------------------------------------------------------------
// The not-ready rule — DESIGN §5.3's `not_ready` row, and the SAME allowlist
// `tests/bridge/console-hygiene.spec.ts:66-77` rows 1/2 already apply (that
// spec's `matches` closures check `url.includes('/bridge/v1/l1-info-tree-
// index')` etc; this classifier is evidence-shape-agnostic, so the identical
// (endpoint-needle, body-needle) pairs apply whether the evidence arrived as
// an HTTP response or a browser console/network message).
// ---------------------------------------------------------------------------

interface NotReadyTrigger {
  endpointNeedle: string;
  bodyNeedle: string;
}

const NOT_READY_TRIGGERS: readonly NotReadyTrigger[] = [
  {
    endpointNeedle: 'l1-info-tree-index',
    bodyNeedle: 'not been included on the L1 Info Tree yet'
  },
  { endpointNeedle: 'injected-l1-info-leaf', bodyNeedle: 'GER not yet injected' },
  { endpointNeedle: 'claim-proof', bodyNeedle: 'has not indexed' }
];

const matchesNotReady = (endpointOrUrl: string, text: string): boolean =>
  NOT_READY_TRIGGERS.some(
    (trigger) => endpointOrUrl.includes(trigger.endpointNeedle) && text.includes(trigger.bodyNeedle)
  );

// DESIGN §5.3: `AlreadyClaimed()`'s 4-byte selector (aggkit DESIGN §4
// S5submit; `app/hooks/useClaimExecution.ts:228-229`).
const ALREADY_CLAIMED_SELECTOR = '0x646cf558';

// ---------------------------------------------------------------------------
// Per-evidence-kind classifiers. Each is independently callable by whichever
// driver (S08 headless / S10 browser) already knows what kind of evidence it
// has — the dispatcher below is a convenience, not the only entry point.
// ---------------------------------------------------------------------------

/** A non-2xx response from `{proxy}/bridge/v1/*` or `{proxy}/tracker/v1/*`. */
export const classifyHttpError = (input: {
  endpointClass: string;
  status: number;
  bodyText?: string;
}): ClassifiedError => {
  const bodyText = input.bodyText ?? '';
  const message = redactSecrets(bodyText.length > 0 ? bodyText : `HTTP ${input.status}`);
  if (matchesNotReady(input.endpointClass, bodyText)) {
    return { errorClass: 'not_ready', message };
  }
  if (input.status >= 500) return { errorClass: 'proxy_5xx', message };
  if (input.status >= 400) return { errorClass: 'proxy_4xx', message };
  // A 2xx should never reach the classifier — surfacing it as `internal`
  // makes a misuse visible instead of silently mislabelling it.
  return {
    errorClass: 'internal',
    message: redactSecrets(`classifyHttpError called with non-error status ${input.status}`)
  };
};

// R3 (loadtest/REVIEW.md): a nonce collision is SELF-INFLICTED — there is
// no per-(user, chain) nonce serialization on the user send path
// (`ChainNonceManager` is funder-only), and `maxInflightLapsPerUser` puts
// multiple concurrent sends on one EOA by design (parity with a real
// user's wallet, finding C4). S14 logged 19 "Nonce provided for the
// transaction is lower than the current nonce" + 70 viem `-32003`
// `TransactionRejectedRpcError`s from exactly this. Evidence-based (only a
// message that actually mentions "nonce" is reclassified) rather than
// blanket-reclassifying every `-32003`, since that code also covers
// legitimate rejections unrelated to nonces.
const NONCE_CONFLICT_PATTERN = /nonce/i;

/** A JSON-RPC error response, or a transport failure, on a `chains[].rpcUrl`. */
export const classifyRpcError = (input: { message: string; code?: number }): ClassifiedError => {
  const prefix = input.code !== undefined ? `RPC error [${input.code}]: ` : 'RPC error: ';
  // DESIGN §5.3: "subdivided by JSON-RPC error code in the report" — the
  // code is folded into the message text itself since `DriverError` (S06,
  // `core/userDriver.ts`) has no dedicated code field to carry it.
  const message = redactSecrets(`${prefix}${input.message}`);
  if (NONCE_CONFLICT_PATTERN.test(input.message)) {
    return { errorClass: 'nonce_conflict', message };
  }
  return { errorClass: 'rpc_error', message };
};

/** A mined transaction whose receipt `status === 'reverted'` (T6/T10/T25). */
export const classifyRevertError = (input: {
  message: string;
  selector?: string;
}): ClassifiedError => {
  const message = redactSecrets(input.message);
  if (input.selector?.toLowerCase() === ALREADY_CLAIMED_SELECTOR) {
    return { errorClass: 'already_claimed', message };
  }
  if (input.message.includes('LocalBalanceTreeUnderflow')) {
    return { errorClass: 'lbt_underflow', message };
  }
  return { errorClass: 'tx_revert', message };
};

// S16/A4 (VALIDATION-1.md): `classifySubmitError` used to special-case only
// `LocalBalanceTreeUnderflow` and fall through to `internal` for
// everything else, which dumped ~440 of 861 `internal` errors into the
// wrong bucket in one run: 336 panic reverts, 70 viem `-32003` rejections +
// 19 nonce-too-low + 13 transport timeouts, 9 `AlreadyClaimed()`, and 57
// browser-pool crashes with no `hopId`. `ALREADY_CLAIMED_SELECTOR` already
// existed for `classifyRevertError` but was unreachable from this
// (pre-receipt) submit path, since nothing here ever pulled a selector out
// of the raw viem message.
const REVERT_SELECTOR_PATTERN = /\b(0x[0-9a-fA-F]{8})\b/;
const PANIC_PATTERN = /\bpanic:/i;

// Viem's own wording for the RPC-shaped failures this run measured verbatim
// (`viem/errors/rpc.ts`'s `TransactionRejectedRpcError` / `TimeoutError`,
// and anvil's nonce-too-low message) — a submit-time throw carrying one of
// these is a transport/RPC failure, not something this tool did wrong.
const VIEM_RPC_ERROR_NEEDLES: readonly string[] = [
  'Transaction creation failed.',
  'Nonce provided for the transaction is lower than the current nonce',
  'The request took too long to respond.'
];

/**
 * A build/send throw (T4/T8/T22) — before a receipt exists, so there is no
 * revert *receipt* to read, but the raw viem/anvil message can still carry
 * exactly the same evidence a receipt-driven classifier would use: a
 * 4-byte selector or a `panic:` prefix (delegated to `classifyRevertError`,
 * DESIGN §3.7 / `core/ring.ts` note N7's `LocalBalanceTreeUnderflow` rule
 * included), a viem RPC error identity (delegated to `classifyRpcError`),
 * or a browser-pool crash message (delegated to `classifyBrowserCrash` —
 * `workers/browser/pool.ts`'s "no live browser" error, S16/A3). Only truly
 * unrecognised messages still fall through to `internal`.
 */
export const classifySubmitError = (input: { message: string }): ClassifiedError => {
  const message = redactSecrets(input.message);
  if (input.message.includes('LocalBalanceTreeUnderflow')) {
    return { errorClass: 'lbt_underflow', message };
  }
  if (/BrowserPool: slot \d+ has no live browser/i.test(input.message)) {
    return classifyBrowserCrash({ message: input.message });
  }
  const selectorMatch = input.message.match(REVERT_SELECTOR_PATTERN);
  if (selectorMatch !== null || PANIC_PATTERN.test(input.message)) {
    return classifyRevertError({
      message: input.message,
      ...(selectorMatch !== null ? { selector: selectorMatch[1] } : {})
    });
  }
  if (VIEM_RPC_ERROR_NEEDLES.some((needle) => input.message.includes(needle))) {
    return classifyRpcError({ message: input.message });
  }
  return { errorClass: 'internal', message };
};

/** A Playwright locator/expect failure (browser mode only). */
export const classifyUiAssertionError = (input: {
  message: string;
  testId?: string;
}): ClassifiedError => ({
  errorClass: 'ui_assertion',
  message: redactSecrets(
    input.testId !== undefined ? `[${input.testId}] ${input.message}` : input.message
  )
});

/** A page/context crash (DESIGN §7.3, T30). */
export const classifyBrowserCrash = (input: { message?: string } = {}): ClassifiedError => ({
  errorClass: 'browser_crash',
  message: redactSecrets(input.message ?? 'browser/context crash')
});

/**
 * A page `console.error` / `pageerror`, browser mode only. Checked against
 * the SAME not-ready rule `classifyHttpError` uses: the browser logs any
 * non-2xx fetch to the console regardless of how the app's JS handles it
 * (`tests/bridge/console-hygiene.spec.ts` file-level comment), so without
 * this check the not-ready poll would double-count — once as a gate stall
 * via the HTTP path, once as a spurious `console_error` via this path.
 */
export const classifyConsoleError = (input: { message: string; url?: string }): ClassifiedError => {
  if (matchesNotReady(input.url ?? '', input.message)) {
    return { errorClass: 'not_ready', message: redactSecrets(input.message) };
  }
  return { errorClass: 'console_error', message: redactSecrets(input.message) };
};

// ---------------------------------------------------------------------------
// S11 retry defect (3): known-benign EXTERNAL asset hosts, unrelated to
// aggkit-proxy or this tool, that this environment (compose devnet, no
// outbound DNS) cannot resolve — `raw.githubusercontent.com` is the chain
// icon `<img>` src every chain object carries (`config.json`'s `iconUrl`,
// `app/config.ts:232`, rendered unconditionally on page load by
// `bridgeCard.tsx`/`tokenSelectorItem.tsx`); `fonts.reown.com` and
// `assets.polygon.technology` are the same class of noise for the
// Reown/polygon-assets asset fallbacks (the former is normally SKIPPED
// entirely in this tool's builds — `IS_E2E_ENABLED` makes `wallet.tsx` use
// `LocalWalletProvider` instead of `createAppKit(...)` — kept here only as
// a defensive, documented entry). Exactly the host set
// `tests/container/container-app.spec.ts`'s "X-1" catch-all already names
// for the SAME `net::ERR_NAME_NOT_RESOLVED` symptom under blocked egress.
// `metrics/collector.ts`'s `error()` uses this to exclude these from the
// aggregate error tables (mirroring how it already drops `not_ready`)
// WITHOUT discarding the raw `activity.ndjson` line, so the evidence (now
// carrying the real failing URL — see `workers/browser/timing.ts`'s
// `onConsole`, which used to pass the PAGE's own url, never the actual
// failing resource) stays auditable but does not swamp genuine findings.
const BENIGN_EXTERNAL_ASSET_HOSTS: readonly string[] = [
  'raw.githubusercontent.com',
  'fonts.reown.com',
  'assets.polygon.technology',
  'avatars.githubusercontent.com',
  // S11 retry: what a REAL devnet run against this sandboxed (no outbound
  // DNS) environment actually captured, 46/46 times, once
  // `workers/browser/timing.ts`'s `onConsole` started reading
  // `message.location().url` instead of `page.url()`. `icon.invalid` is
  // Chromium's OWN internal sentinel host for a failed favicon/site-icon
  // fetch (Blink's favicon driver attributes it this way instead of the
  // real URL in the console entry's location) — the app itself defines no
  // `<link rel="icon">` (`app/layout.tsx`'s `metadata` has no `icons`
  // field), so this is almost certainly Chromium's own automatic
  // favicon-fetch for the AppKit wallet-metadata icon
  // (`app/context/wallet.tsx:102`'s `metadata.icons:
  // ['https://avatars.githubusercontent.com/u/179229932']`) or the chain
  // icon `raw.githubusercontent.com` host above, surfacing through a
  // request class Chromium does not attribute to the real URL. Either way
  // it is browser/environment noise unrelated to aggkit-proxy.
  'icon.invalid'
];

export const isBenignExternalAssetHost = (endpointClassOrUrl: string | undefined): boolean =>
  endpointClassOrUrl !== undefined &&
  BENIGN_EXTERNAL_ASSET_HOSTS.some((host) => endpointClassOrUrl.includes(host));

/** Anything thrown by `wallets/fund.ts` (`FUNDING_CAP_EXCEEDED` is its own sub-code, carried in the message). */
export const classifyFundingError = (input: { message: string }): ClassifiedError => ({
  errorClass: 'funding',
  message: redactSecrets(input.message)
});

/** A schema/validate failure — the run never starts. */
export const classifyConfigError = (input: { message: string }): ClassifiedError => ({
  errorClass: 'config',
  message: redactSecrets(input.message)
});

/**
 * Anything unclassified. Reuses `redactError` (rather than `redactSecrets`
 * on a manually-extracted `.message`) so a non-`Error` thrown value is
 * still formatted safely. DESIGN §5.3: S20 should treat a non-trivial
 * `internal` count as a finding — this classifier is meant to be exhaustive.
 */
export const classifyUnknownError = (error: unknown): ClassifiedError => ({
  errorClass: 'internal',
  message: redactError(error)
});

// ---------------------------------------------------------------------------
// Dispatcher — one call site for a caller that already has typed evidence
// tagged with its `source`, for callers that prefer a single import over
// picking the right named classifier.
// ---------------------------------------------------------------------------

export type ClassifyInput =
  | ({ source: 'http' } & { endpointClass: string; status: number; bodyText?: string })
  | ({ source: 'rpc' } & { message: string; code?: number })
  | ({ source: 'revert' } & { message: string; selector?: string })
  | ({ source: 'submit' } & { message: string })
  | ({ source: 'ui_assertion' } & { message: string; testId?: string })
  | ({ source: 'browser_crash' } & { message?: string })
  | ({ source: 'console' } & { message: string; url?: string })
  | ({ source: 'funding' } & { message: string })
  | ({ source: 'config' } & { message: string })
  | { source: 'unknown'; error: unknown };

export const classifyError = (input: ClassifyInput): ClassifiedError => {
  switch (input.source) {
    case 'http':
      return classifyHttpError(input);
    case 'rpc':
      return classifyRpcError(input);
    case 'revert':
      return classifyRevertError(input);
    case 'submit':
      return classifySubmitError(input);
    case 'ui_assertion':
      return classifyUiAssertionError(input);
    case 'browser_crash':
      return classifyBrowserCrash(input);
    case 'console':
      return classifyConsoleError(input);
    case 'funding':
      return classifyFundingError(input);
    case 'config':
      return classifyConfigError(input);
    case 'unknown':
      return classifyUnknownError(input.error);
    default: {
      // Exhaustiveness guard — a new `source` member must be handled above.
      const exhaustive: never = input;
      return exhaustive;
    }
  }
};

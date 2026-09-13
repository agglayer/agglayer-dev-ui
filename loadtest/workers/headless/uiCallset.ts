// UI call-set replay helpers for the headless worker (S08) — DESIGN §9.
//
// Pure cadence/caching/classification logic lives here so it can be unit
// tested without a live devnet; headlessUser.ts wires it to real HTTP/RPC
// calls and the S07 collector.
//
// Two things are deliberately REUSED rather than re-derived, per DESIGN
// §9.2's mandatory parity rules:
//  - `parseActivityResponse` / `toTransaction` (app/services/activity.ts) —
//    the big-int-safe text parse and the exact PENDING/READY_TO_CLAIM/
//    CLAIMED/ERROR status derivation the UI itself uses. Both are pure
//    functions with no React/Next dependency (verified: their only runtime
//    imports are local, their `@/app/...`/`@agglayer/sdk` imports are
//    `import type`, erased at compile time) — safe to import standalone.
//  - `toRowKey` (loadtest/core/types.ts) — so our mapped `rowKey` is
//    byte-identical to the ring core's own `tx_hash:deposit_count` identity.
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ActivityWarning } from '../../../app/services/activity';
import type { ObservedRow } from '../../core/types';
import type { DriverMode } from '../../core/userDriver';
import type { Collector, HttpOrigin } from '../../metrics/collector';

import { parseActivityResponse, toTransaction } from '../../../app/services/activity';
import { toRowKey } from '../../core/types';

// ---------------------------------------------------------------------------
// Activity cadence scheduler — DESIGN §9.1 row P1, findings C1/C2.
//
// `useTransactions.ts`'s page-level refetchInterval bursts 500/1000/2000/
// 3000ms after a submit, then settles to 5000ms while any row is
// non-terminal, else 10000ms. `useReadyToClaimCount.ts`'s badge polls a flat
// 15000ms. Both hooks share queryKey ['activity', mode, address], so
// react-query runs only the SHORTEST live interval and issues ONE request
// (finding C2) — modelled here as `effectivePollIntervalMs =
// min(pageInterval, BADGE_INTERVAL_MS)`. Our headless driver always behaves
// as if "the transactions page is open" (that's its entire job), so the
// page interval is the one that matters in practice; the badge cap is kept
// for fidelity to the documented rule, not because it ever binds (the page
// interval never exceeds 10000ms, always < the 15000ms badge floor).
// ---------------------------------------------------------------------------

const BURST_DELAYS_MS = [500, 1000, 2000, 3000] as const;
export const BADGE_INTERVAL_MS = 15_000;
export const NON_TERMINAL_INTERVAL_MS = 5_000;
export const TERMINAL_INTERVAL_MS = 10_000;

export interface ActivityCadenceState {
  readonly lastFetchAt: number | null;
  readonly lastSubmitAt: number | null;
  readonly anyNonTerminal: boolean;
}

export const initialActivityCadenceState: ActivityCadenceState = {
  lastFetchAt: null,
  lastSubmitAt: null,
  anyNonTerminal: false
};

/** Call when a bridge/claim tx is submitted — resets the burst window (matches the UI's counter reset on the false->true submitting edge). */
export const noteBridgeSubmitted = (
  state: ActivityCadenceState,
  now: number
): ActivityCadenceState => ({
  ...state,
  lastSubmitAt: now
});

/** Call after every fetch, with whether any observed row was still non-terminal. */
export const noteActivityFetched = (
  state: ActivityCadenceState,
  now: number,
  anyNonTerminal: boolean
): ActivityCadenceState => ({ ...state, lastFetchAt: now, anyNonTerminal });

const pageIntervalMs = (state: ActivityCadenceState, now: number): number => {
  if (state.lastSubmitAt !== null) {
    const sinceSubmit = now - state.lastSubmitAt;
    let cumulative = 0;
    for (const delay of BURST_DELAYS_MS) {
      cumulative += delay;
      if (sinceSubmit < cumulative) return delay;
    }
  }
  return state.anyNonTerminal ? NON_TERMINAL_INTERVAL_MS : TERMINAL_INTERVAL_MS;
};

/** DESIGN finding C2's dedup rule. Exported so a test can assert the min directly. */
export const effectivePollIntervalMs = (state: ActivityCadenceState, now: number): number =>
  Math.min(pageIntervalMs(state, now), BADGE_INTERVAL_MS);

/** ms until the next fetch is due; 0 means "fetch now". */
export const nextActivityFetchDelayMs = (state: ActivityCadenceState, now: number): number => {
  if (state.lastFetchAt === null) return 0;
  const interval = effectivePollIntervalMs(state, now);
  return Math.max(0, interval - (now - state.lastFetchAt));
};

export const isActivityFetchDue = (state: ActivityCadenceState, now: number): boolean =>
  nextActivityFetchDelayMs(state, now) === 0;

// ---------------------------------------------------------------------------
// S16/A6 (VALIDATION-1.md): single-flight the cadence-paced fetch itself.
//
// `headlessUser.ts`'s old `observeActivity()` computed `nextActivityFetchDelayMs`,
// slept, THEN fetched — every time, unconditionally. Under
// `maxInflightLapsPerUser > 1` several of ONE user's in-flight laps call
// `observeActivity()` concurrently, and all of them read the SAME
// `ActivityCadenceState.lastFetchAt` (nothing updates it until a fetch
// actually completes), so all compute the same delay, all sleep in
// parallel, and all wake up and fetch AT THE SAME TIME. Measured: 1211
// `tracker/activity` requests/user against an expected ~448 (2.7x, matching
// `maxInflightLapsPerUser: 3` almost exactly) — the real UI cannot do this;
// `useTransactions`/`useReadyToClaimCount` share one react-query key, so
// react-query issues exactly ONE request per interval no matter how many
// components are mounted (finding C2, `uiCallset.ts`'s own module doc).
//
// This is the SAME bug class S24 already fixed on the browser side
// (`browserUser.ts`'s `fetchActivitySingleFlight`) — reused shape: the
// FIRST caller to find no fetch already in flight owns the sleep+fetch
// chain and every concurrent caller joins that SAME promise instead of
// starting its own. Unlike the browser side, headless keeps NO TTL cache on
// top of this — sleeping out `delayMs()` before fetching already reproduces
// the UI's real cadence exactly, so serving a stale cached answer instead of
// waiting would just make this driver's own polling loop spin instead of
// pacing itself (worsening finding A5, not fixing A6).
//
// S24's second lesson carries over too: single-flighting a fetch means ONE
// transient failure now fails every joined caller at once, so a bounded
// retry belongs here — but never for an error the caller marks fatal (the
// browser side's analogous carve-out is `isCrashLikeError`; headless has no
// browser to crash, so callers pass their own predicate, e.g. "the process
// is draining/aborting").
// ---------------------------------------------------------------------------

export interface SingleFlightPollerOptions {
  /** Injected so tests can run with an instant/fake sleep instead of real timers. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Total attempts (first try + retries) before giving up. Default 3, mirroring `fetchActivityTextWithRetry`'s `maxAttempts`. */
  maxAttempts?: number;
  /** Pause between retry attempts, ms. */
  retryDelayMs?: number;
  /** An error this returns `true` for is never retried and propagates immediately to every joined caller. */
  isFatal?: (error: unknown) => boolean;
}

export class SingleFlightPoller<T> {
  private inFlight: Promise<T> | null = null;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly isFatal: (error: unknown) => boolean;

  constructor(options: SingleFlightPollerOptions = {}) {
    this.sleepFn = options.sleepFn ?? sleep;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 300;
    this.isFatal = options.isFatal ?? (() => false);
  }

  /**
   * `delayMs()` is evaluated fresh for whichever call actually starts a new
   * chain (a joining caller never re-evaluates it) — callers should pass a
   * closure over their own cadence state (e.g. `() =>
   * nextActivityFetchDelayMs(this.cadence, this.clock.now())`), not a
   * pre-computed number, so the delay reflects the moment the chain
   * actually starts rather than the moment `run()` was called.
   */
  run(delayMs: () => number, fetchFn: () => Promise<T>): Promise<T> {
    if (this.inFlight !== null) return this.inFlight;
    const promise = this.execute(delayMs, fetchFn);
    this.inFlight = promise;
    // Mirrors `browserUser.ts`'s `fetchActivitySingleFlight` cleanup: every
    // concurrent joiner already holds its own reference to `promise` and
    // resolves/rejects with it regardless; this chain only frees the slot
    // for the next call and must never surface as a second, duplicate
    // unhandled rejection.
    promise
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null;
      })
      .catch(() => {});
    return promise;
  }

  private async execute(delayMs: () => number, fetchFn: () => Promise<T>): Promise<T> {
    const delay = delayMs();
    if (delay > 0) await this.sleepFn(delay);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await fetchFn();
      } catch (error) {
        lastError = error;
        if (attempt === this.maxAttempts || this.isFatal(error)) throw error;
        await this.sleepFn(this.retryDelayMs);
      }
    }
    // Unreachable (the loop above always returns or throws on its last
    // attempt), but keeps TypeScript's control-flow analysis happy.
    throw lastError;
  }
}

// ---------------------------------------------------------------------------
// Generic TTL memo cache — DESIGN P7 (balance, 15s), P8 (gasPrice, 15s), P9
// (allowance — "no staleTime" but keyed including the amount string, and
// `refetchOnMount/WindowFocus/Reconnect: false`, so in practice it is
// fetched once per distinct (chain,token,owner,spender,amount) for the run:
// modelled with an effectively-infinite TTL).
// ---------------------------------------------------------------------------

export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, load: () => Promise<T>, now: number): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && now < hit.expiresAt) return hit.value;
    const value = await load();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }
}

// ---------------------------------------------------------------------------
// Endpoint classing — DESIGN §5.2: "/bridge/v1/<route>?network_id=N ->
// bridge/<route>[N]; tracker activity; tracker tx; RPC by JSON-RPC method."
// No shared classifier exists yet in metrics/ (S07 leaves endpointClass
// production to the caller), so this is the one call site both `bridge/*`
// REST traffic and RPC traffic route through.
// ---------------------------------------------------------------------------

export const classifyEndpoint = (urlStr: string, bodyText?: string): string => {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return 'unknown';
  }
  const path = url.pathname;
  const networkId = url.searchParams.get('network_id');

  const bridgeMatch = /\/bridge\/v1\/([^/?]+)\/?$/.exec(path);
  if (bridgeMatch) {
    const route = bridgeMatch[1];
    return networkId !== null ? `bridge/${route}[${networkId}]` : `bridge/${route}`;
  }
  if (path.includes('/tracker/v1/activity/from/')) return 'tracker/activity';
  if (/\/tracker\/v1\/network\/[^/]+\/tx\//.test(path)) return 'tracker/tx';
  if (path.endsWith('/tracker/v1/health')) return 'tracker/health';

  // Anything else hitting a bare RPC URL is assumed to be JSON-RPC — classed
  // by method name from the request body, with the URL's last path segment
  // as a cheap per-chain discriminator (loadtest.config.json's `rpcUrl`
  // convention, e.g. ".../l1rpc", ".../l2rpc-001").
  const chainSegment = path.split('/').filter(Boolean).pop() ?? url.hostname;
  if (bodyText !== undefined) {
    try {
      const parsed = JSON.parse(bodyText) as { method?: unknown };
      if (typeof parsed.method === 'string') return `rpc/${chainSegment}/${parsed.method}`;
    } catch {
      // Not JSON (or not a single JSON-RPC request) — fall through.
    }
  }
  return `rpc/${chainSegment}`;
};

// ---------------------------------------------------------------------------
// Timing fetch wrapper — "ALL HTTP goes through a timing fetch wrapper
// feeding the S07 collector." Both our own explicit fetch (the activity
// poll) AND the pinned SDK's internal fetches (RPC via viem's `http`
// transport inside `BaseContract`/`NativeClient`, REST via `httpRaw.ts`'s
// `fetchRawText` inside `AggkitBridgeClient`) resolve through Node's global
// `fetch`, and the SDK gives us no hook to inject a transport into its
// internally-constructed clients — so wrapping `globalThis.fetch` once is
// the only way to observe SDK-internal traffic without forking the SDK.
// Scoped per-call to a user via AsyncLocalStorage so concurrent users'
// samples are attributed correctly even though the wrapper is process-wide.
// ---------------------------------------------------------------------------

export interface FetchContext {
  userId: string;
  mode: DriverMode;
  // S24 / DESIGN §9.3 finding C16: which side issued this Node-side fetch —
  // see `metrics/collector.ts`'s `HttpOrigin` doc. Optional, defaults to
  // `'ui'` below (headless's every call IS the UI replay, per DESIGN §9.4 —
  // it never needs to pass this). The browser driver's own Node-side
  // bookkeeping calls (wrapped-token-address resolution, the bridge tx's
  // own receipt fetch) pass `'harness'` explicitly.
  origin?: HttpOrigin;
}

const fetchContextStorage = new AsyncLocalStorage<FetchContext>();

export const runWithFetchContext = <T>(ctx: FetchContext, fn: () => Promise<T>): Promise<T> =>
  fetchContextStorage.run(ctx, fn);

// DESIGN §9.5: `fetchRawText` retries a transport failure up to 3x with
// backoff, within a 30s per-attempt timeout — one logical `/bridge/v1/*`
// call can be up to 4 requests. We cannot see the SDK's internal retry
// bookkeeping from outside it, so `attempt` is approximated: repeated calls
// to the identical (user, method, endpointClass) key within a 35s window
// (the timeout plus slack) are treated as successive attempts of the same
// logical call. This is a documented approximation, not exact SDK
// introspection — see the S08 feedback pack.
const ATTEMPT_WINDOW_MS = 35_000;
const attemptTracker = new Map<string, { count: number; lastAt: number }>();

const nextAttempt = (key: string, now: number): number => {
  const prior = attemptTracker.get(key);
  if (prior !== undefined && now - prior.lastAt < ATTEMPT_WINDOW_MS) {
    attemptTracker.set(key, { count: prior.count + 1, lastAt: now });
    return prior.count;
  }
  attemptTracker.set(key, { count: 1, lastAt: now });
  return 0;
};

export interface TimingFetchHandle {
  uninstall(): void;
}

/** Installs a wrapped `globalThis.fetch`. Call once per process; returns a handle to restore the original. */
export const installTimingFetch = (
  collector: Collector,
  clock: { now(): number } = { now: () => Date.now() }
): TimingFetchHandle => {
  const original = globalThis.fetch;

  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = clock.now();
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : undefined) ??
      'GET'
    ).toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const endpointClass = classifyEndpoint(url, bodyText);
    const ctx = fetchContextStorage.getStore();
    const attemptKey = `${ctx?.userId ?? '?'}:${method}:${endpointClass}`;
    // VALIDATION-1.md A7: the window-based heuristic below approximates the
    // pinned SDK's internal retry count by treating any repeat call within
    // `ATTEMPT_WINDOW_MS` as a retry of the same logical call — a
    // reasonable approximation for `/bridge/v1/*` (the SDK's own
    // `fetchRawText` really does retry those), but `tracker/activity` is
    // NEVER retried by the SDK at all — it is P1's own legitimate 5-10s
    // poll loop, driven by this file's cadence engine, not a retry of
    // anything. Applying the same heuristic to it mislabelled nearly every
    // poll after the first as a "retry" (96 847 of 96 927 in one run),
    // which made `describeHttpStats`'s `retries=` field on that endpoint
    // meaningless and led one validation write-up to (wrongly) conclude
    // the poll loop was "spin-polling". Excluded from inference entirely.
    const attempt = endpointClass === 'tracker/activity' ? 0 : nextAttempt(attemptKey, startedAt);

    try {
      const response = await original(input, init);
      if (ctx) {
        collector.recordHttpSample({
          userId: ctx.userId,
          mode: ctx.mode,
          endpointClass,
          method,
          status: response.status,
          durationMs: clock.now() - startedAt,
          attempt,
          origin: ctx.origin ?? 'ui'
        });
      } else {
        // R11 (loadtest/REVIEW.md): a request outside any
        // `runWithFetchContext` scope used to be silently unrecorded — no
        // sample, no counter, no warning — making the endpoint tables an
        // undisclosed lower bound. Counted here instead.
        collector.recordUncontextedRequest();
      }
      return response;
    } catch (error) {
      if (ctx) {
        // status: 0 is our sentinel for "transport failure, no response" —
        // there is no HTTP status to carry.
        collector.recordHttpSample({
          userId: ctx.userId,
          mode: ctx.mode,
          endpointClass,
          method,
          status: 0,
          durationMs: clock.now() - startedAt,
          attempt,
          origin: ctx.origin ?? 'ui'
        });
      } else {
        collector.recordUncontextedRequest();
      }
      throw error;
    }
  }) as typeof fetch;

  globalThis.fetch = wrapped;

  return {
    uninstall() {
      globalThis.fetch = original;
    }
  };
};

// ---------------------------------------------------------------------------
// Activity row mapping — DESIGN §9.2: parse as text through
// `parseActivityResponse` (big-int safe), reuse `toTransaction`'s status
// derivation, then map onto the ring core's own `ObservedRow`/`toRowKey`
// identity (never `bridge_hash`, never a bare-number `global_index`).
// ---------------------------------------------------------------------------

export interface MappedActivity {
  rows: ObservedRow[];
  warnings: ActivityWarning[];
}

export const mapActivityResponseText = (text: string): MappedActivity => {
  const raw = parseActivityResponse(text);
  const rows: ObservedRow[] = raw.bridges.map((bridge) => {
    const tx = toTransaction(bridge);
    const transactionHash = tx.transactionHash as `0x${string}`;
    return {
      rowKey: toRowKey(transactionHash, tx.depositCount),
      status: tx.status,
      statusError: tx.statusError,
      transactionHash,
      depositCount: tx.depositCount,
      sourceNetwork: tx.sourceNetwork,
      destinationNetwork: tx.destinationNetwork,
      globalIndex: tx.globalIndex,
      claimTransactionHash: tx.claimTransactionHash as `0x${string}` | undefined
    };
  });
  return { rows, warnings: raw.warnings ?? [] };
};

/**
 * True while any observed row still has work left (drives the
 * burst->5s/10s decay). R20 (loadtest/REVIEW.md): this used to also
 * exclude `'ERROR'` rows, an UNDECLARED divergence from the real UI —
 * `app/hooks/useTransactions.ts`'s `hasNonTerminalTransaction` excludes
 * ONLY `'CLAIMED'`, so a real user's browser keeps polling at the 5000ms
 * non-terminal interval for as long as an `ERROR` row is present, while
 * headless decayed to the 10000ms terminal branch — under-polling the
 * highest-volume endpoint class in the whole test, in exactly the
 * direction (less load than a real user) DESIGN §9.4's closing rule
 * ("anything else that differs between the two modes is a defect") does
 * not allow to go undeclared. Matches the UI's predicate exactly now.
 */
export const anyRowNonTerminal = (rows: readonly ObservedRow[]): boolean =>
  rows.some((row) => row.status !== 'CLAIMED');

// ---------------------------------------------------------------------------
// isClaimed post-throw / post-revert retry loop — DESIGN P14, finding C3.
// ---------------------------------------------------------------------------

export const IS_CLAIMED_RECHECK_DELAYS_MS = [0, 400, 1000] as const;

export const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Per-chain ERC20 address resolution — S08 retry, tool-defect fix.
//
// Attempt #1 read a configured ERC20 asset's address (always the asset's
// ORIGIN chain address, per config/schema.ts's `originNetworkId`
// convention) on every chain a hop touched, which crashed `balanceOf` on a
// non-origin chain where the token exists only as a *wrapped* ERC20 at a
// different, precalculated address
// (`ContractFunctionExecutionError: ... returned no data ("0x")`).
//
// The decision + cache logic is pure and lives here (unit-testable without
// the SDK/a live devnet); `headlessUser.ts` wires `lookupWrapped` to the
// pinned SDK's `Bridge.getWrappedTokenAddress` (on-chain
// `getTokenWrappedAddress`, a plain deployed-address mapping lookup — NOT
// `getPrecalculatedWrapperAddress`/`precalculatedWrapperAddress`, which
// reverts with no reason on this devnet's deployed bridge contract; see
// `headlessUser.ts`'s `tokenAddressResolver` doc) and uses the result for
// balance reads, `allowance`, `approve` and the bridge call — this is the
// same mapping UI parity row P6's `token-mappings` lookup implies, though
// the UI itself never performs this resolution (see the S08 feedback pack:
// browser mode requires the user to manually register a "custom token"
// address per chain instead).
// ---------------------------------------------------------------------------

export interface TokenChainRef {
  chainId: number;
  bridgeAddress: string;
  networkId: number;
}

const ZERO_ADDRESS_RE = /^0x0{40}$/i;

/** True for the zero address — the on-chain "no mapping yet" sentinel (a plain Solidity mapping default, not a revert). */
export const isZeroAddress = (address: string): boolean => ZERO_ADDRESS_RE.test(address);

export interface TokenAddressResolverDeps {
  /**
   * Tier 3 (on-chain fallback): the pinned SDK's `Bridge.getWrappedTokenAddress`
   * (on-chain `getTokenWrappedAddress`, a plain deployed-address mapping
   * lookup) against `chain`'s bridge contract. Immune to aggkit
   * token-mappings indexer lag — always current as of the queried block.
   * Returning the zero address means the wrapper genuinely does not exist
   * on `chain` yet (not an error): the caller returns it unresolved and
   * does NOT cache it, so the next resolve() call for the same triple
   * re-checks rather than permanently believing "never exists".
   */
  lookupWrapped(
    originNetworkId: number,
    originAddress: string,
    chain: TokenChainRef
  ): Promise<string>;
  /**
   * Tier 2 (UI-parity-correct source, DESIGN §9.1 row P6): `GET
   * {proxy}/bridge/v1/token-mappings?network_id={chain.networkId}&origin_token_address={originAddress}`
   * via the pinned SDK's `AggkitBridgeAggregator.clientFor(chain.networkId)
   * .getTokenMappings(...)`. Return `null` when `token_mappings` comes back
   * empty (the wrapper has never reached `chain` yet, e.g. the inbound
   * claim that would deploy it hasn't landed there yet) so the caller falls
   * through to `lookupWrapped`. Optional — a caller that only wants the
   * on-chain path (e.g. existing unit tests, or a run without proxy
   * access) can omit it; omitting it behaves as if it always returns `null`.
   */
  lookupTokenMappings?(
    originNetworkId: number,
    originAddress: string,
    chain: TokenChainRef
  ): Promise<string | null>;
}

/**
 * Three-tier per-chain ERC20 address resolution (S08 retry #2):
 *
 * 1. `originNetworkId === chain.networkId` (or `originNetworkId` unknown,
 *    e.g. no asset metadata was supplied) returns `originAddress`
 *    unresolved — the pre-fix behaviour, deliberately preserved as the
 *    fallback rather than guessing.
 * 2. Otherwise ask `deps.lookupTokenMappings` (the UI-parity-correct
 *    source) — if it returns a non-empty, non-zero address, use it.
 * 3. Otherwise fall back to `deps.lookupWrapped`'s direct on-chain read
 *    (handles both "no proxy dep supplied" and "token-mappings hasn't
 *    indexed the deploy yet").
 *
 * A resolved non-zero address is cached indefinitely — a wrapped address
 * is a deterministic contract address for a given (originNetwork,
 * originToken, chain) triple, it never changes once deployed. The zero
 * address (Tier 3's "not deployed yet" sentinel) is deliberately NOT
 * cached, so a later call — after the inbound claim that deploys the
 * wrapper has landed — re-resolves instead of being stuck on a stale
 * "doesn't exist" answer.
 */
export class TokenAddressResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly deps: TokenAddressResolverDeps) {}

  async resolve(
    originAddress: string,
    originNetworkId: number | undefined,
    chain: TokenChainRef
  ): Promise<string> {
    if (originNetworkId === undefined || chain.networkId === originNetworkId) {
      return originAddress;
    }

    const cacheKey = `${originNetworkId}:${originAddress.toLowerCase()}:${chain.networkId}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (this.deps.lookupTokenMappings) {
      // A transient proxy failure here (network error, 5xx) is not fatal —
      // Tier 3's on-chain read is a fully valid independent source, so fall
      // through to it rather than failing resolution outright.
      const viaMappings = await this.deps
        .lookupTokenMappings(originNetworkId, originAddress, chain)
        .catch(() => null);
      if (viaMappings !== null && !isZeroAddress(viaMappings)) {
        this.cache.set(cacheKey, viaMappings);
        return viaMappings;
      }
    }

    const wrapped = await this.deps.lookupWrapped(originNetworkId, originAddress, chain);
    if (!isZeroAddress(wrapped)) {
      this.cache.set(cacheKey, wrapped);
    }
    return wrapped;
  }
}

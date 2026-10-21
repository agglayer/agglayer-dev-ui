// Browser pool — DESIGN §7 (sharding, crash detection/recovery, context
// recycling). K Chromium PROCESSES, `contextsPerBrowser` isolated CONTEXTS
// each (one context == one simulated user, never shared/reused across two
// live users — that would produce nonce collisions on the same account,
// §7.3). Sharding axis is "one browser, N contexts" per plan §1's measured
// feasibility table (marginal RSS ~150MB/user that way vs ~470MB/user for
// "N browsers, 1 context each"), so `contextsPerBrowser` is what bounds a
// single crash's blast radius, not browser count.
//
// This module owns Playwright process/context lifecycle ONLY. It knows
// nothing about `UserDriver`, hops, or the ring — `browserUser.ts` is the
// only caller, and it goes through `acquireContext()`/`releaseContext()`.
import type { Browser, BrowserContext, BrowserServer } from '@playwright/test';
import type { Hex } from 'viem';

import { chromium, selectors } from '@playwright/test';

export interface BrowserPoolUserSpec {
  userId: string;
  privateKey: Hex;
}

export interface ShardAssignment {
  slotIndex: number;
  userIds: string[];
}

/**
 * DESIGN §7.1: `browsers = ceil(users.browser / contextsPerBrowser)`,
 * contexts distributed round-robin so a crash loses at most
 * `contextsPerBrowser` users. Pure and exported so the arithmetic itself is
 * unit-testable without launching a real browser.
 */
export const computeShardAssignment = (
  users: readonly BrowserPoolUserSpec[],
  contextsPerBrowser: number
): ShardAssignment[] => {
  if (contextsPerBrowser < 1) {
    throw new Error(
      `computeShardAssignment: contextsPerBrowser must be >= 1, got ${contextsPerBrowser}`
    );
  }
  const slotCount = Math.max(1, Math.ceil(users.length / contextsPerBrowser));
  const slots: ShardAssignment[] = Array.from({ length: slotCount }, (_, slotIndex) => ({
    slotIndex,
    userIds: []
  }));
  // Round-robin, not contiguous chunks: DESIGN §7.1 says "round-robin", and
  // it also means an early crash-and-relaunch of one slot doesn't
  // concentrate all of users[0..K] behind one recovering process.
  users.forEach((user, index) => {
    slots[index % slotCount].userIds.push(user.userId);
  });
  return slots;
};

export type BrowserCrashKind = 'browser_crash' | 'browser_crash_permanent';

export interface BrowserCrashEvent {
  userId: string;
  slotIndex: number;
  kind: BrowserCrashKind;
  message: string;
}

export type CrashListener = (event: BrowserCrashEvent) => void;

export interface BrowserPoolOptions {
  users: readonly BrowserPoolUserSpec[];
  contextsPerBrowser: number;
  headless?: boolean;
  /** DESIGN §7.3 default. */
  maxBrowserRelaunches?: number;
  /** Extra flags beyond the mandatory `--disable-dev-shm-usage` (+ `--no-sandbox` under uid 0). */
  extraArgs?: readonly string[];
  /** Called for every crash-derived outcome (both `browser_crash` and the terminal `browser_crash_permanent`). */
  onCrash?: CrashListener;
  /**
   * Per-user HAR output path (S10 acceptance #5 — "a HAR of one lap saved
   * for S23's parity diff"). Return `undefined` for every user except the
   * one being recorded. The HAR is flushed to disk on that user's context
   * close (a recycle, `dispose()`, or a crash), so a caller wanting a HAR
   * of exactly one lap should close/recreate that context right after it.
   */
  harPathFor?: (userId: string) => string | undefined;
  /** `loadtest.config.json`'s `uiBaseUrl` — set as each context's `baseURL` so `bridge-page.ts`'s `page.goto('/')` resolves (a standalone `newContext()` has no test-runner `use.baseURL` to inherit it from). */
  baseUrl?: string;
}

interface Slot {
  index: number;
  userIds: string[];
  browser: Browser | null;
  // Launched via `chromium.launchServer()` rather than `chromium.launch()`
  // specifically so a real OS process is reachable for `killSlotFor` —
  // the public `Browser` type has no `.process()` in this Playwright
  // version (verified empirically), but `BrowserServer` does, plus a
  // `.kill()` that sends the process a real kill signal and waits for
  // exit (DESIGN §7.3 acceptance: "killing one Chromium process").
  server: BrowserServer | null;
  relaunches: number;
  retiredUsers: Set<string>;
  // Contexts created for this slot's current browser incarnation, so a
  // relaunch knows exactly which contexts died with it.
  contexts: Map<string, BrowserContext>;
  launching: Promise<void> | null;
}

let testIdAttributeSet = false;

// S03 gotcha (carried into every hand-launched Playwright script):
// playwright.config.ts's `testIdAttribute: 'data-test-id'` only applies to
// the test-fixture `page` — a standalone `chromium.launch()` page defaults
// to `data-testid`, so `bridge-page.ts`'s `page.getByTestId(...)` calls
// would silently match nothing. `selectors.setTestIdAttribute` is a
// process-global switch (not per-context), so it is set once, before the
// first browser in this process launches, rather than per-context.
const ensureTestIdAttribute = (): void => {
  if (testIdAttributeSet) return;
  selectors.setTestIdAttribute('data-test-id');
  testIdAttributeSet = true;
};

const MANDATORY_ARGS = ['--disable-dev-shm-usage'];

const launchArgsFor = (extra: readonly string[]): string[] => {
  const args = [...MANDATORY_ARGS, ...extra];
  if (
    typeof process.getuid === 'function' &&
    process.getuid() === 0 &&
    !args.includes('--no-sandbox')
  ) {
    args.push('--no-sandbox');
  }
  return args;
};

export const isCrashLikeError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('target page, context or browser has been closed') ||
    message.includes('targetclosederror') ||
    message.includes('target closed') ||
    // Playwright's own wording varies by call site/version — "Browser has
    // been closed" (locator actions) vs the bare "Browser closed" observed
    // live from a raw `page.evaluate` against a killed `chromium.connect()`
    // server (S10 acceptance run). Match both rather than one literal.
    message.includes('browser closed') ||
    message.includes('browser has been closed') ||
    message.includes('has been closed') ||
    message.includes('context or browser')
  );
};

/**
 * DESIGN §7.3/§7.4: launches, shards, and recovers Chromium processes.
 * `acquireContext(userId)` is the only thing `browserUser.ts` needs — it
 * resolves to a live `BrowserContext` with `window.__AGGLAYER_E2E_PRIVATE_KEY__`
 * already injected via `addInitScript` (S03), created fresh (never a
 * context handed to a second live user).
 */
export class BrowserPool {
  private readonly slots: Slot[];
  private readonly keyByUser = new Map<string, Hex>();
  private readonly slotByUser = new Map<string, number>();
  private readonly headless: boolean;
  private readonly maxBrowserRelaunches: number;
  private readonly extraArgs: readonly string[];
  private readonly onCrash?: CrashListener;
  private readonly harPathFor?: (userId: string) => string | undefined;
  private readonly baseUrl?: string;
  private readonly expectedCloses = new WeakSet<BrowserContext>();
  private readonly crashListeners = new Map<string, Set<CrashListener>>();
  // Dedupes concurrent crash signals for the same slot incarnation. A real
  // process kill fires MULTIPLE detection signals for the same incident
  // (each context's `close`, then the browser's `disconnected`) — without
  // this, the first signal's synchronous `slot.browser = null` +
  // `relaunches += 1` would run again for the second signal, double-
  // counting relaunches and double-emitting crash events. It also means a
  // caller that reacts to the FIRST crash event and immediately calls
  // `acquireContext`/`recover()` cannot race ahead of the relaunch: by the
  // time any crash event is emitted (inside the guarded body below),
  // `slot.browser` is already null and the relaunch is already in flight,
  // so `acquireContext`'s `if (!slot.browser) await this.launchSlot(slot)`
  // always waits for the SAME in-flight relaunch rather than reading a
  // stale, already-dead `slot.browser` reference (S10 attempt #1 retry:
  // this exact race produced "browser.newContext: ... Browser closed" from
  // a `recover()` called right after a `context.on('close')`-only crash
  // event, before `browser.on('disconnected')` had a chance to null out
  // `slot.browser`).
  private readonly crashInFlight = new Map<number, Promise<void>>();
  private disposing = false;

  constructor(options: BrowserPoolOptions) {
    this.headless = options.headless ?? true;
    this.maxBrowserRelaunches = options.maxBrowserRelaunches ?? 3;
    this.extraArgs = options.extraArgs ?? [];
    this.onCrash = options.onCrash;
    this.harPathFor = options.harPathFor;
    this.baseUrl = options.baseUrl;

    for (const user of options.users) this.keyByUser.set(user.userId, user.privateKey);

    const assignment = computeShardAssignment(options.users, options.contextsPerBrowser);
    this.slots = assignment.map((shard) => ({
      index: shard.slotIndex,
      userIds: shard.userIds,
      browser: null,
      server: null,
      relaunches: 0,
      retiredUsers: new Set<string>(),
      contexts: new Map<string, BrowserContext>(),
      launching: null
    }));
    for (const slot of this.slots) {
      for (const userId of slot.userIds) this.slotByUser.set(userId, slot.index);
    }
  }

  get slotCount(): number {
    return this.slots.length;
  }

  slotIndexFor(userId: string): number {
    const index = this.slotByUser.get(userId);
    if (index === undefined) throw new Error(`BrowserPool: unknown user "${userId}"`);
    return index;
  }

  /**
   * S11 resource sampling: the OS pids of every currently-live Chromium
   * process this pool owns, one per slot with a running `server`. Exposed
   * only so the runner can attribute `resources.samples[].browserProcesses`
   * RSS to real processes — the pool itself still owns launch/relaunch/kill.
   */
  livePids(): number[] {
    const pids: number[] = [];
    for (const slot of this.slots) {
      const pid = slot.server?.process().pid;
      if (pid !== undefined) pids.push(pid);
    }
    return pids;
  }

  /** Launches every slot's browser process and creates every user's context. Call once before any `acquireContext`. */
  async launch(): Promise<void> {
    ensureTestIdAttribute();
    await Promise.all(this.slots.map((slot) => this.launchSlot(slot)));
  }

  private async launchSlot(slot: Slot): Promise<void> {
    // R1 (loadtest/REVIEW.md): the crash-recovery path
    // (`runSlotCrashRecovery`) already refuses to relaunch once
    // `dispose()` has started — this is the DIRECT launch path
    // (`acquireContext`'s `if (!slot.browser) await this.launchSlot(slot)`)
    // that used to have no such guard, so a launch that started (or was
    // re-entered) at or after teardown could still succeed and hand back a
    // FRESH Chromium child process/WebSocket that `dispose()` — which had
    // already run — would never close. An in-flight launch that started
    // BEFORE `disposing` flipped true is still awaited below (this guard
    // only stops a NEW one from starting).
    if (this.disposing) return;
    if (slot.launching) return slot.launching;
    slot.launching = (async () => {
      const server = await chromium.launchServer({
        headless: this.headless,
        args: launchArgsFor(this.extraArgs)
      });
      const browser = await chromium.connect(server.wsEndpoint());
      slot.server = server;
      slot.browser = browser;
      slot.contexts.clear();

      browser.on('disconnected', () => {
        if (this.disposing) return;
        // Guard against a STALE event: this listener is attached to THIS
        // browser incarnation. If `slot.browser` has already moved on to a
        // newer incarnation (recovery already completed via an earlier
        // signal — e.g. a `context.on('close')` for the same incident, or
        // a prior relaunch entirely), a late-arriving `disconnected` for
        // the now-superseded old browser must NOT tear down the fresh
        // contexts. Without this check, killing a process fires both
        // `context.on('close')` (fast, synchronous-ish) and this
        // `disconnected` event (can arrive noticeably later — observed
        // live: after recovery had already produced a working context),
        // and the second would spuriously re-crash an already-healthy slot.
        if (slot.browser !== browser) return;
        void this.handleSlotCrash(slot, 'browser disconnected');
      });

      for (const userId of slot.userIds) {
        if (slot.retiredUsers.has(userId)) continue;
        await this.createContextFor(slot, userId);
      }
    })();
    try {
      await slot.launching;
    } finally {
      slot.launching = null;
    }
  }

  private async createContextFor(
    slot: Slot,
    userId: string,
    alreadyRetried = false
  ): Promise<BrowserContext> {
    const browser = slot.browser;
    if (!browser) {
      // S16/A3 (VALIDATION-1.md): `acquireContext` can await `launchSlot`
      // to completion and then lose a race to a second, concurrent crash
      // that nulls `slot.browser` again before this read — the prior
      // behaviour threw immediately (57 "slot N has no live browser"
      // occurrences in one run, all misclassified `internal` with no
      // `hopId`). Re-enter `launchSlot` once — it dedupes against any
      // relaunch already in flight via `slot.launching` — and only give up
      // on a second failure. Guarded against re-entering the very
      // `launchSlot` invocation this call is already running inside of
      // (`slot.launching !== null`), which would otherwise await a promise
      // that can only settle after this call returns.
      if (!alreadyRetried && slot.launching === null) {
        await this.launchSlot(slot);
        // `launchSlot` itself just (re-)created a context for every
        // non-retired user in `slot.userIds`, `userId` included — reuse it
        // rather than creating (and leaking) a second one.
        const relaunched = slot.contexts.get(userId);
        if (relaunched) return relaunched;
        return this.createContextFor(slot, userId, true);
      }
      // Thrown as a crash-classifiable message (matches `isCrashLikeError`)
      // rather than a bare internal error, so every caller that already
      // routes a real crash through `classifyBrowserCrash` (and attaches
      // the current hop's id) does the same here instead of this falling
      // into the generic/unclassified `internal` bucket.
      throw new Error(
        `BrowserPool: slot ${slot.index} has no live browser after a relaunch attempt (browser has been closed)`
      );
    }
    const key = this.keyByUser.get(userId);
    if (!key) throw new Error(`BrowserPool: no private key registered for user "${userId}"`);

    const harPath = this.harPathFor?.(userId);
    const context = await browser.newContext({
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      ...(harPath
        ? { recordHar: { path: harPath, mode: 'full' as const, content: 'embed' as const } }
        : {})
    });
    // S03: must run before context.newPage()/navigation — this IS what
    // gives each context a distinct wallet (one call sets both the header's
    // connected address and the tx signer).
    await context.addInitScript((privateKey: string) => {
      (
        window as unknown as { __AGGLAYER_E2E_PRIVATE_KEY__?: string }
      ).__AGGLAYER_E2E_PRIVATE_KEY__ = privateKey;
    }, key);

    context.on('close', () => {
      // A context the pool itself is not in the middle of tearing down
      // closed on its own — DESIGN §7.3's second detection signal
      // ("context.on('close') without a dispose() request").
      if (this.disposing) return;
      if (this.expectedCloses.has(context)) {
        this.expectedCloses.delete(context);
        return;
      }
      if (slot.contexts.get(userId) !== context) return; // already superseded (e.g. recreated after a crash)
      if (slot.retiredUsers.has(userId)) return;
      // Routes through the SAME slot-level recovery path `browser.on
      // ('disconnected')` uses (not just `emitCrash`) — see DESIGN §7.3:
      // any of the three signals must drive "the pool relaunches the
      // browser process ... and re-creates each context", not merely
      // notify. `handleSlotCrash` dedupes against a concurrent
      // `disconnected` firing for the same incident via `crashInFlight`.
      void this.handleSlotCrash(slot, 'context closed unexpectedly');
    });

    slot.contexts.set(userId, context);
    return context;
  }

  private emitCrash(slot: Slot, userId: string, kind: BrowserCrashKind, message: string): void {
    const event: BrowserCrashEvent = { userId, slotIndex: slot.index, kind, message };
    this.onCrash?.(event);
    const listeners = this.crashListeners.get(userId);
    if (listeners) for (const listener of [...listeners]) listener(event);
  }

  /**
   * Event-driven crash notification for one user, scoped (unlike the
   * constructor's `onCrash`, which fires for every user). `browserUser.ts`
   * races its in-flight page operation against this so a crash is detected
   * the instant the pool observes it — near-instant per DESIGN §7.3's three
   * signals — rather than waiting for the operation itself to notice its
   * page/context/browser died (which, empirically, can hang far longer than
   * any operation's own timeout when the underlying transport is torn down
   * without a clean protocol-level error). Returns an unsubscribe function;
   * always call it once the raced operation settles, crash or not, to avoid
   * leaking a listener per call.
   */
  addCrashListener(userId: string, listener: CrashListener): () => void {
    const set = this.crashListeners.get(userId) ?? new Set<CrashListener>();
    set.add(listener);
    this.crashListeners.set(userId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.crashListeners.delete(userId);
    };
  }

  /**
   * Dedupes concurrent crash signals for the same slot (see `crashInFlight`'s
   * doc). Safe to call from multiple listeners for the same incident: the
   * second+ caller just awaits the first caller's in-flight recovery
   * instead of re-running it.
   */
  private async handleSlotCrash(slot: Slot, message: string): Promise<void> {
    const existing = this.crashInFlight.get(slot.index);
    if (existing) {
      await existing;
      return;
    }
    const promise = this.runSlotCrashRecovery(slot, message);
    this.crashInFlight.set(slot.index, promise);
    try {
      await promise;
    } finally {
      this.crashInFlight.delete(slot.index);
    }
  }

  private async runSlotCrashRecovery(slot: Slot, message: string): Promise<void> {
    if (this.disposing) return;
    const affectedUsers = [
      ...slot.contexts.keys(),
      ...slot.userIds.filter((id) => !slot.retiredUsers.has(id))
    ];
    const uniqueAffected = Array.from(new Set(affectedUsers));
    slot.contexts.clear();
    slot.browser = null;
    slot.server = null;
    slot.relaunches += 1;

    if (slot.relaunches > this.maxBrowserRelaunches) {
      for (const userId of uniqueAffected) {
        slot.retiredUsers.add(userId);
        this.emitCrash(
          slot,
          userId,
          'browser_crash_permanent',
          `${message} (relaunch budget exhausted at ${slot.relaunches - 1}/${this.maxBrowserRelaunches})`
        );
      }
      return;
    }

    for (const userId of uniqueAffected) this.emitCrash(slot, userId, 'browser_crash', message);

    try {
      await this.launchSlot(slot);
    } catch (relaunchError) {
      const relaunchMessage =
        relaunchError instanceof Error ? relaunchError.message : String(relaunchError);
      for (const userId of uniqueAffected) {
        slot.retiredUsers.add(userId);
        this.emitCrash(
          slot,
          userId,
          'browser_crash_permanent',
          `relaunch failed: ${relaunchMessage}`
        );
      }
    }
  }

  isRetired(userId: string): boolean {
    const slot = this.slots[this.slotIndexFor(userId)];
    return slot.retiredUsers.has(userId);
  }

  /**
   * Resolves to `userId`'s live context, recreating it (with the same
   * `addInitScript` key, so the wallet — and therefore ring position — is
   * unchanged) if a prior operation observed a crash. Throws if the user's
   * slot has been permanently retired (`browser_crash_permanent`).
   */
  async acquireContext(userId: string): Promise<BrowserContext> {
    // R1 (loadtest/REVIEW.md): the direct launch path this method drives
    // (`if (!slot.browser) await this.launchSlot(slot)`) did not check
    // `this.disposing` — the crash-driven relaunch path already does
    // (`runSlotCrashRecovery`). A caller (an abandoned `raceOrTimeout`
    // promise still inside `acquireContext`, per `runner.ts`'s own doc on
    // that function) racing teardown could still launch a fresh Chromium
    // process AFTER `dispose()` had already closed everything else.
    if (this.disposing) {
      throw new Error(
        `BrowserPool: cannot acquire a context for "${userId}" — the pool is disposing`
      );
    }
    const slotIndex = this.slotIndexFor(userId);
    const slot = this.slots[slotIndex];
    if (slot.retiredUsers.has(userId)) {
      throw new Error(
        `BrowserPool: user "${userId}" is permanently retired (browser_crash_permanent)`
      );
    }
    if (!slot.browser) await this.launchSlot(slot);
    const existing = slot.contexts.get(userId);
    if (existing) return existing;
    return this.createContextFor(slot, userId);
  }

  /**
   * A driver-observed crash mid-operation (a `TargetClosedError` thrown
   * from inside a page action, DESIGN §7.3's third detection signal) — the
   * caller reports it here so the pool can drive the same recovery path as
   * a process-level `disconnected` event, then the caller re-acquires a
   * fresh context via `acquireContext`.
   */
  reportOperationCrash(userId: string, error: unknown): void {
    if (!isCrashLikeError(error)) return;
    const slot = this.slots[this.slotIndexFor(userId)];
    void this.handleSlotCrash(slot, error instanceof Error ? error.message : String(error));
  }

  /**
   * Closes `userId`'s current context deliberately (a dispose or a §7.4
   * recycle, never mid-hop) — marked as an expected close so the
   * `context.on('close')` listener does not read it as a crash.
   */
  async releaseContext(userId: string): Promise<void> {
    const slot = this.slots[this.slotIndexFor(userId)];
    const context = slot.contexts.get(userId);
    if (!context) return;
    this.expectedCloses.add(context);
    slot.contexts.delete(userId);
    await context.close().catch(() => undefined);
  }

  /** DESIGN §7.4: close-then-recreate between laps (never mid-hop), same `addInitScript` key. */
  async recycleContext(userId: string): Promise<BrowserContext> {
    await this.releaseContext(userId);
    const slot = this.slots[this.slotIndexFor(userId)];
    return this.createContextFor(slot, userId);
  }

  /**
   * Kills the underlying Chromium process for `userId`'s slot — test-only
   * hook for exercising crash recovery deliberately. Sends a real kill
   * signal via `BrowserServer.process()` (a genuine OS process handle,
   * unlike `Browser`, which this Playwright version does not expose one
   * on) and waits for exit; the connected `Browser`'s `'disconnected'`
   * event then drives the same recovery path a spontaneous crash would.
   */
  async killSlotFor(userId: string): Promise<void> {
    const slot = this.slots[this.slotIndexFor(userId)];
    const server = slot.server;
    if (!server) return;
    const childProcess = server.process();
    if (childProcess.pid !== undefined) {
      process.kill(childProcess.pid, 'SIGKILL');
    } else {
      await server.kill().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    // R1 (loadtest/REVIEW.md): the root cause of `run` hanging (and worse,
    // resurrecting a Chromium child) past teardown. `dispose()` used to
    // close whatever existed AT THIS INSTANT and return — it never awaited
    // `slot.launching` (a direct `acquireContext` -> `launchSlot` in
    // flight) or `this.crashInFlight` (a crash-driven relaunch in flight,
    // via `runSlotCrashRecovery` -> `launchSlot`). Either can still be
    // running here: an abandoned `raceOrTimeout` promise (`runner.ts`'s own
    // doc: "the promise is abandoned, not cancelled") can be sitting inside
    // exactly that call chain. Awaiting both FIRST means every launch this
    // pool will ever start has either finished (and is then closed by the
    // loop below) or been refused by the `disposing` guards added to
    // `launchSlot`/`acquireContext` above — no launch can complete AFTER
    // this function returns and leak a Chromium process/WebSocket nothing
    // will ever close.
    await Promise.all([...this.crashInFlight.values()].map((p) => p.catch(() => undefined)));
    await Promise.all(
      this.slots.map((slot) => (slot.launching ? slot.launching.catch(() => undefined) : undefined))
    );
    await Promise.all(
      this.slots.map(async (slot) => {
        for (const context of slot.contexts.values()) {
          await context.close().catch(() => undefined);
        }
        slot.contexts.clear();
        if (slot.browser) await slot.browser.close().catch(() => undefined);
        if (slot.server) await slot.server.close().catch(() => undefined);
        slot.browser = null;
        slot.server = null;
      })
    );
  }
}

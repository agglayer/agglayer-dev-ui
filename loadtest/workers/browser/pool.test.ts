// Unit coverage for the one pure piece of pool.ts — DESIGN §7.1's sharding
// arithmetic — plus (S12 hardening pass) the crash-signal dedup/recovery
// state machine, faked against a minimal `@playwright/test` stand-in so it
// runs with no real Chromium process. Everything else in this module still
// needs a real browser and is exercised live (S10 acceptance run), not here.
import { describe, expect, it, vi } from 'vitest';

import type { BrowserCrashEvent, BrowserPoolOptions } from './pool';

import { BrowserPool, computeShardAssignment, isCrashLikeError } from './pool';

// `vi.hoisted` because `vi.mock` factories are hoisted above every import —
// this is the shared state + fake-object factory both the mock and the test
// bodies below reach into.
const { fakeChromium, poolFakes } = vi.hoisted(() => {
  interface FakeContext {
    on: (event: string, cb: () => void) => void;
    fireClose: () => void;
    addInitScript: () => Promise<void>;
    close: () => Promise<void>;
  }
  interface FakeBrowser {
    on: (event: string, cb: () => void) => void;
    fireDisconnected: () => void;
    newContext: () => Promise<FakeContext>;
    close: () => Promise<void>;
  }
  interface FakeServer {
    wsEndpoint: () => string;
    process: () => { pid: number };
    kill: () => Promise<void>;
    close: () => Promise<void>;
  }

  const poolFakes = {
    servers: [] as FakeServer[],
    browsers: [] as FakeBrowser[],
    contexts: [] as FakeContext[]
  };

  let pidCounter = 1000;

  const makeContext = (): FakeContext => {
    const handlers: Record<string, Array<() => void>> = {};
    const context: FakeContext = {
      on: (event, cb) => {
        (handlers[event] ??= []).push(cb);
      },
      fireClose: () => (handlers.close ?? []).forEach((cb) => cb()),
      addInitScript: async () => {},
      close: async () => {}
    };
    poolFakes.contexts.push(context);
    return context;
  };

  const makeBrowser = (): FakeBrowser => {
    const handlers: Record<string, Array<() => void>> = {};
    const browser: FakeBrowser = {
      on: (event, cb) => {
        (handlers[event] ??= []).push(cb);
      },
      fireDisconnected: () => (handlers.disconnected ?? []).forEach((cb) => cb()),
      newContext: async () => makeContext(),
      close: async () => {}
    };
    poolFakes.browsers.push(browser);
    return browser;
  };

  const makeServer = (): FakeServer => {
    const pid = pidCounter++;
    const server: FakeServer = {
      wsEndpoint: () => `ws://fake-${pid}`,
      process: () => ({ pid }),
      kill: async () => {},
      close: async () => {}
    };
    poolFakes.servers.push(server);
    return server;
  };

  const fakeChromium = {
    launchServer: async () => makeServer(),
    connect: async () => makeBrowser()
  };

  return { fakeChromium, poolFakes };
});

vi.mock('@playwright/test', () => ({
  chromium: fakeChromium,
  selectors: { setTestIdAttribute: () => {} }
}));

// None of the fakes above use a real timer — every one of their `async`
// bodies resolves via a plain microtask. Node fully drains the microtask
// queue (however many hops deep a chained `void handleSlotCrash(...)`
// recovery goes) before running any macrotask, so a single macrotask
// boundary is enough to observe the recovery as settled.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('computeShardAssignment', () => {
  const users = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, privateKey: '0x00' as const }));

  it('ceil(users/contextsPerBrowser) slots', () => {
    expect(computeShardAssignment(users(4), 25)).toHaveLength(1);
    expect(computeShardAssignment(users(4), 2)).toHaveLength(2);
    expect(computeShardAssignment(users(5), 2)).toHaveLength(3);
  });

  it('distributes round-robin, not contiguous chunks', () => {
    const shards = computeShardAssignment(users(4), 2);
    expect(shards[0].userIds).toEqual(['u0', 'u2']);
    expect(shards[1].userIds).toEqual(['u1', 'u3']);
  });

  it('a crash loses at most contextsPerBrowser users', () => {
    const shards = computeShardAssignment(users(10), 3);
    for (const shard of shards) expect(shard.userIds.length).toBeLessThanOrEqual(3);
  });

  it('rejects contextsPerBrowser < 1', () => {
    expect(() => computeShardAssignment(users(1), 0)).toThrow(/contextsPerBrowser/);
  });

  it('handles zero users without dividing by zero', () => {
    expect(computeShardAssignment([], 5)).toHaveLength(1);
  });
});

describe('isCrashLikeError', () => {
  it('recognizes Playwright TargetClosedError-shaped messages', () => {
    expect(isCrashLikeError(new Error('Target page, context or browser has been closed'))).toBe(
      true
    );
    expect(isCrashLikeError(new Error('TargetClosedError: something'))).toBe(true);
  });

  it('does not misclassify an unrelated error', () => {
    expect(isCrashLikeError(new Error('LocalBalanceTreeUnderflow'))).toBe(false);
    expect(isCrashLikeError('not an Error instance')).toBe(false);
  });
});

describe('BrowserPool — crash-signal dedup and recovery (DESIGN §7.3)', () => {
  const onePoolOptions = (onCrash: (event: BrowserCrashEvent) => void): BrowserPoolOptions => ({
    users: [{ userId: 'u0', privateKey: '0x00' as const }],
    contextsPerBrowser: 25,
    onCrash
  });

  it("kill mid-hop: browser.on('disconnected') and context.on('close') both fire for the same incident, but exactly ONE relaunch happens", async () => {
    const events: BrowserCrashEvent[] = [];
    const pool = new BrowserPool(onePoolOptions((e) => events.push(e)));
    await pool.launch();

    const browser = poolFakes.browsers[poolFakes.browsers.length - 1];
    const context = poolFakes.contexts[poolFakes.contexts.length - 1];
    const serversBefore = poolFakes.servers.length;

    // A real Chromium process kill fires both detection signals for the
    // SAME incident (DESIGN §7.3) — a context close, then the browser
    // disconnecting.
    context.fireClose();
    browser.fireDisconnected();
    await flush();

    expect(events.filter((e) => e.kind === 'browser_crash')).toHaveLength(1);
    expect(poolFakes.servers.length).toBe(serversBefore + 1); // exactly one relaunch

    // The slot is healthy again: acquiring the context resolves off the NEW
    // incarnation rather than throwing or hanging.
    const recovered = await pool.acquireContext('u0');
    expect(recovered).toBe(poolFakes.contexts[poolFakes.contexts.length - 1]);
  });

  it('crashInFlight (pool.ts:185): a reportOperationCrash call racing an in-flight event-driven recovery coalesces into ONE relaunch', async () => {
    const events: BrowserCrashEvent[] = [];
    const pool = new BrowserPool(onePoolOptions((e) => events.push(e)));
    await pool.launch();

    const context = poolFakes.contexts[poolFakes.contexts.length - 1];
    const serversBefore = poolFakes.servers.length;

    // Signal 1: the context closes unexpectedly — synchronously starts
    // recovery (nulls slot.browser, clears slot.contexts, sets
    // `crashInFlight`) and is now awaiting the relaunch.
    context.fireClose();
    // Signal 2, same tick: an in-flight page operation independently
    // observes a crash-like error and reports it directly.
    // `reportOperationCrash` carries none of the state guards the two event
    // listeners have (no browser-identity check, no contexts-map check) —
    // `crashInFlight` is the ONLY thing that stops it from re-running
    // `runSlotCrashRecovery` a second time for the same incident.
    pool.reportOperationCrash('u0', new Error('Target page, context or browser has been closed'));
    await flush();

    expect(events.filter((e) => e.kind === 'browser_crash')).toHaveLength(1);
    expect(poolFakes.servers.length).toBe(serversBefore + 1);
  });

  it("stale-incarnation guard: a late 'disconnected' for an already-superseded browser is dropped, not treated as a new crash", async () => {
    const events: BrowserCrashEvent[] = [];
    const pool = new BrowserPool(onePoolOptions((e) => events.push(e)));
    await pool.launch();

    const staleBrowser = poolFakes.browsers[poolFakes.browsers.length - 1];

    // First incident: recovers fully onto a fresh browser incarnation.
    staleBrowser.fireDisconnected();
    await flush();
    expect(events.filter((e) => e.kind === 'browser_crash')).toHaveLength(1);
    const serversAfterFirstRecovery = poolFakes.servers.length;

    // A LATE `disconnected` for the now-dead OLD incarnation arrives after
    // recovery already completed. The listener's guard (`slot.browser !==
    // browser`, pool.ts) must drop it — without this guard it would
    // spuriously re-crash the now-healthy slot.
    staleBrowser.fireDisconnected();
    await flush();

    expect(events.filter((e) => e.kind === 'browser_crash')).toHaveLength(1); // unchanged
    expect(poolFakes.servers.length).toBe(serversAfterFirstRecovery); // no second relaunch
  });
});

// S16/A3 (VALIDATION-1.md): `createContextFor` used to throw the instant it
// observed `slot.browser === null`, which is exactly what a concurrent
// relaunch can leave behind for a brief window (57 "slot N has no live
// browser" occurrences in one run, all misclassified `internal` with no
// `hopId` to join back to a lap). White-box (reaches into the pool's
// private `slots`/`createContextFor`, unlike the black-box tests above) —
// reproducing the real race deterministically needs a real browser
// (this file's own header note), so this drives the retry-once contract
// directly instead.
// Minimal view onto the pool's private `slots`/`createContextFor` — just
// enough surface for the white-box pokes below, without resorting to `any`.
interface PoolInternals {
  slots: Array<{ browser: unknown; launching: Promise<void> | null }>;
  createContextFor: (
    slot: PoolInternals['slots'][number],
    userId: string,
    alreadyRetried?: boolean
  ) => Promise<unknown>;
}

describe('BrowserPool — createContextFor retries once past a concurrent relaunch (S16/A3)', () => {
  const users = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, privateKey: '0x00' as const }));

  it('retries launchSlot once and reuses the context it just created, when nothing is already launching', async () => {
    const pool = new BrowserPool({ users: users(1), contextsPerBrowser: 25 });
    await pool.launch();
    const internals = pool as unknown as PoolInternals;
    const slot = internals.slots[0];
    const serversBefore = poolFakes.servers.length;
    // Simulates the exact race pool.ts's guard comment describes: a
    // relaunch already completed (`slot.launching` reset to null) but a
    // second, concurrent crash nulled `slot.browser` again before this
    // particular read.
    slot.browser = null;

    const context = await internals.createContextFor(slot, 'u0');

    expect(context).toBeDefined();
    expect(slot.browser).not.toBeNull();
    expect(poolFakes.servers.length).toBe(serversBefore + 1); // exactly one retry relaunch
  });

  it('gives up (without deadlocking) and throws a crash-classifiable message when already inside the launch it would retry', async () => {
    const pool = new BrowserPool({ users: users(1), contextsPerBrowser: 25 });
    await pool.launch();
    const internals = pool as unknown as PoolInternals;
    const slot = internals.slots[0];
    slot.browser = null;
    // Simulates being called from WITHIN the currently in-flight
    // `launchSlot(slot)` this call would otherwise re-enter (which can only
    // settle after this call returns) — the guard must throw immediately
    // rather than await that promise.
    slot.launching = new Promise<void>(() => {});

    let thrown: unknown;
    try {
      await internals.createContextFor(slot, 'u0');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('no live browser');
    // The whole point of the fix: classifiable as a browser crash, not a
    // generic/unclassified internal error.
    expect(isCrashLikeError(thrown)).toBe(true);
  });

  it('throws a crash-classifiable message on a genuine second failure (retry exhausted)', async () => {
    const pool = new BrowserPool({ users: users(1), contextsPerBrowser: 25 });
    await pool.launch();
    const internals = pool as unknown as PoolInternals;
    const slot = internals.slots[0];
    slot.browser = null;

    let thrown: unknown;
    try {
      // `alreadyRetried: true` — the shape a caller reaches only after this
      // method's own first-failure retry already ran once.
      await internals.createContextFor(slot, 'u0', true);
    } catch (error) {
      thrown = error;
    }
    expect(isCrashLikeError(thrown)).toBe(true);
  });
});

// R1 (loadtest/REVIEW.md): `run` never exits — the root cause was
// `dispose()` not awaiting a launch already in flight, combined with
// `launchSlot`/`acquireContext` not refusing a NEW one once disposing had
// started. Exactly REVIEW.md's own suggested unit-level repro: start a
// `launchSlot` on a `chromium.launchServer` that resolves after a delay,
// call `dispose()` before it resolves, then assert the slot's
// `server`/`browser` end up null (i.e. `dispose()` actually closed the
// browser the in-flight launch produced, instead of returning immediately
// and leaving it orphaned).
interface PoolInternalsR1 {
  slots: Array<{ browser: unknown; server: unknown; launching: Promise<void> | null }>;
}

describe('BrowserPool.dispose — awaits an in-flight launch instead of orphaning it (R1)', () => {
  const users = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, privateKey: '0x00' as const }));

  it('a launch already in flight when dispose() is called still gets closed, not orphaned', async () => {
    let releaseLaunch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const originalLaunchServer = fakeChromium.launchServer;
    fakeChromium.launchServer = async () => {
      await gate; // held open until the test releases it, below
      return originalLaunchServer();
    };

    try {
      const pool = new BrowserPool({ users: users(1), contextsPerBrowser: 25 });
      // Not awaited: this starts `acquireContext` -> `launchSlot` ->
      // `chromium.launchServer()`, which is now stuck on `gate`.
      const acquiring = pool.acquireContext('u0').catch(() => undefined);
      await flush(); // let launchSlot actually start and set slot.launching

      const internals = pool as unknown as PoolInternalsR1;
      const slot = internals.slots[0];
      expect(slot.launching).not.toBeNull(); // the launch is genuinely in flight
      expect(slot.browser).toBeNull(); // ...and hasn't produced a browser yet

      // dispose() called WHILE the launch above is still stuck on `gate` —
      // this is the exact race R1 describes.
      const disposing = pool.dispose();

      // Now let the launch complete.
      releaseLaunch();
      await Promise.all([acquiring, disposing]);

      // The launch DID produce a browser/server (proving this isn't just
      // "nothing ever launched") — and dispose() closed both rather than
      // leaving them for nothing to ever close.
      expect(slot.browser).toBeNull();
      expect(slot.server).toBeNull();
    } finally {
      fakeChromium.launchServer = originalLaunchServer;
    }
  });

  it('acquireContext refuses to start a NEW launch once disposing has begun', async () => {
    const pool = new BrowserPool({ users: users(1), contextsPerBrowser: 25 });
    await pool.dispose(); // nothing was ever launched; disposing is now true
    await expect(pool.acquireContext('u0')).rejects.toThrow(/disposing/);
  });
});

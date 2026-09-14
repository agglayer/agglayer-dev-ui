// Unit coverage for the S24 retry #1 fix: `fetchActivitySingleFlight()`'s
// single-flight + TTL cache behind `observeActivity()`, replacing the racy
// check-then-act `throttleHarnessPoll()` (see that field's removal note in
// `browserUser.ts`'s module doc and `activityFetchInFlight`'s field doc).
//
// This locks the actual bug: under `maxInflightLapsPerUser` concurrency,
// several callers (multiple in-flight laps, each able to call
// `observeActivity()`/`readState()` independently) could all read the same
// stale throttle timestamp and all fire a REAL fetch together. The fix must
// make N concurrent `observeActivity()` calls inside one
// `harnessPollIntervalMs` window collapse onto exactly ONE real
// `page.evaluate` fetch, with every caller still getting a correct (never
// staler than the TTL) result.
//
// The rest of `browserUser.ts` needs a real Chromium/Playwright context and
// is exercised live (S10/S24 acceptance runs), not here — mirrors
// `pool.test.ts`'s "only test the pure/isolable piece" scoping. This test
// bypasses `init()` entirely and pokes the private `page` field directly so
// `observeActivity()` can run against a fake `page.evaluate` with no real
// browser.
import { describe, expect, it, vi } from 'vitest';

import type { LoadtestChain } from '../../config/schema';
import type { HopSpec } from '../../core/types';
import type { BrowserPool } from './pool';

import { createCollector } from '../../metrics/collector';
import { BrowserUser } from './browserUser';

const TEST_PRIVATE_KEY =
  '0x0a7e0bab4de92cadc79ea1747dd9d5042411051ab69806ad905bc917432fc08e' as const;

const CHAIN: LoadtestChain = {
  key: 'l1',
  chainId: 1,
  networkId: 0,
  rpcUrl: 'http://localhost:8545',
  nativeSymbol: 'ETH',
  bridgeAddress: '0x0000000000000000000000000000000000000001',
  explorerUrl: 'http://localhost:4000'
};

// S25 tests need a second chain — `bridge()` looks up both `fromChainKey`
// and `toChainKey` via `chainByKey()`.
const CHAIN_L2: LoadtestChain = {
  key: 'l2',
  chainId: 2,
  networkId: 1,
  rpcUrl: 'http://localhost:8546',
  nativeSymbol: 'ETH',
  bridgeAddress: '0x0000000000000000000000000000000000000002',
  explorerUrl: 'http://localhost:4001'
};

const ETH_HOP: HopSpec = {
  hopIndex: 0,
  hopRoute: 'l1->l2',
  fromChainKey: 'l1',
  toChainKey: 'l2',
  fromNetworkId: 0,
  toNetworkId: 1,
  assetIndex: 0,
  assetKind: 'eth',
  amount: '1000000000000000',
  decimals: 18,
  autoclaim: { expected: false }
};

// No real BrowserPool needed: the construction path never calls into it,
// and `runGuarded()`'s crash race only needs `addCrashListener` to exist
// and never fire for these tests (no crash is simulated).
const fakePool = {
  addCrashListener: () => () => {},
  reportOperationCrash: () => {}
} as unknown as BrowserPool;

const makeClock = () => {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    }
  };
};

const makeDriver = (
  evaluate: (...args: unknown[]) => unknown,
  clock: { now(): number }
): BrowserUser => {
  const user = new BrowserUser({
    userId: 'u1',
    privateKey: TEST_PRIVATE_KEY,
    pool: fakePool,
    chains: [CHAIN],
    aggkitProxyUrl: 'http://localhost:9000',
    collector: createCollector(),
    clock,
    refreshEveryNPolls: 0, // no DOM refresh side effect needed for this test
    harnessPollIntervalMs: 5000
  });
  // `init()` (real Playwright launch) is intentionally never called — set
  // the private `page` field directly, same escape hatch `pool.test.ts`
  // avoids needing entirely by only testing pure helpers; here we DO need
  // an instance because the bug lives in instance state.
  (user as unknown as { page: { evaluate: typeof evaluate; isClosed(): boolean } }).page = {
    evaluate,
    isClosed: () => false
  };
  return user;
};

const emptyActivityResponse = () => JSON.stringify({ bridges: [] });

describe('BrowserUser.observeActivity — S24 retry #1 single-flight + TTL cache', () => {
  it('N concurrent calls inside one interval window issue exactly ONE real fetch', async () => {
    const evaluate = vi.fn(async () => emptyActivityResponse());
    const user = makeDriver(evaluate, makeClock());

    const results = await Promise.all([
      user.observeActivity(),
      user.observeActivity(),
      user.observeActivity(),
      user.observeActivity(),
      user.observeActivity()
    ]);

    expect(evaluate).toHaveBeenCalledTimes(1);
    for (const rows of results) expect(rows).toEqual([]);
  });

  it('serves cached result for repeated calls inside the TTL, then re-fetches once it elapses', async () => {
    const evaluate = vi.fn(async () => emptyActivityResponse());
    const clock = makeClock();
    const user = makeDriver(evaluate, clock);

    await user.observeActivity();
    expect(evaluate).toHaveBeenCalledTimes(1);

    // Still inside the 5s TTL — served from cache, no second fetch.
    clock.advance(4000);
    await user.observeActivity();
    expect(evaluate).toHaveBeenCalledTimes(1);

    // Past the TTL — a fresh fetch is issued (never staler than the TTL promises).
    clock.advance(2000);
    await user.observeActivity();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers that arrive while a fetch is already in flight join it rather than starting a second one', async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const evaluate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const user = makeDriver(evaluate, makeClock());

    const first = user.observeActivity();
    await Promise.resolve(); // let the first call's fetch actually start
    const second = user.observeActivity();
    const third = user.observeActivity();

    expect(evaluate).toHaveBeenCalledTimes(1);
    resolveFetch?.(emptyActivityResponse());

    const [firstRows, secondRows, thirdRows] = await Promise.all([first, second, third]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(secondRows).toEqual(firstRows);
    expect(thirdRows).toEqual(firstRows);
  });

  it('retries a transient fetch failure internally (single-flight amplifies one failure to every joined caller, so it must self-heal)', async () => {
    // Two failures then a success — `fetchActivityTextWithRetry`'s 3-attempt
    // budget absorbs both before ever rejecting to the caller.
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('TypeError: Failed to fetch'))
      .mockRejectedValueOnce(new Error('TypeError: Failed to fetch'))
      .mockResolvedValueOnce(emptyActivityResponse());
    const user = makeDriver(evaluate, makeClock());

    await expect(user.observeActivity()).resolves.toEqual([]);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('does not poison the cache once retries are exhausted — the very next call gets a fresh attempt', async () => {
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('TypeError: Failed to fetch'))
      .mockRejectedValueOnce(new Error('TypeError: Failed to fetch'))
      .mockRejectedValueOnce(new Error('TypeError: Failed to fetch'))
      .mockResolvedValueOnce(emptyActivityResponse());
    const user = makeDriver(evaluate, makeClock());

    // All 3 retry attempts fail — this call rejects.
    await expect(user.observeActivity()).rejects.toThrow('Failed to fetch');
    expect(evaluate).toHaveBeenCalledTimes(3);

    // The next call is a fresh single-flight attempt, not a frozen
    // stale-on-error snapshot, and succeeds on its own first try.
    await expect(user.observeActivity()).resolves.toEqual([]);
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a crash-like failure — it propagates immediately so the crash race can react', async () => {
    const evaluate = vi
      .fn()
      .mockRejectedValue(new Error('Target page, context or browser has been closed'));
    const user = makeDriver(evaluate, makeClock());

    await expect(user.observeActivity()).rejects.toThrow('has been closed');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// S25 (plan §7 root-cause fix): `runExclusive` serializes every operation
// that touches this driver's shared page — proven here at the `bridge()`
// level specifically (the plan's own acceptance wording), not just on the
// abstract queue primitive, so this locks the ACTUAL user-facing behavior:
// two lap tasks calling `driver.bridge()` concurrently (exactly what
// `runner.ts`'s per-cell lap loop does under `maxInflightLapsPerUser`/
// multiple assets) must never have both in the middle of driving the page
// at once.
//
// `bridge()` drives a real `BridgePage` (Playwright locators) end to end —
// too much to construct with a real browser here (mirrors this file's own
// module doc: "the rest of browserUser.ts needs a real Chromium/Playwright
// context ... exercised live, not here"). Instead we replace the private
// `bridgePage` field with a fake that implements only the methods `bridge()`
// calls, and stub `getPublicClient` so the post-success receipt-decode step
// (real node-side RPC in production) never touches the network. This keeps
// the test deterministic while exercising the REAL `bridge()` method body,
// not a reimplementation of it.
// ---------------------------------------------------------------------------

/** A `bridgePage` stub covering only what `bridge()` (native/ETH path) calls. */
interface FakeBridgePage {
  navigate: () => Promise<void>;
  connectWallet: () => Promise<void>;
  selectFromChain: (chainId: number) => Promise<void>;
  selectToChain: (chainId: number) => Promise<void>;
  fillAmount: (amount: string) => Promise<void>;
  submitBridge: () => Promise<void>;
  waitForTransactionModal: () => Promise<void>;
  waitForBridgeSuccess: (timeoutMs: number) => Promise<void>;
  bridgeSuccessExplorerLink: { getAttribute: (name: string) => Promise<string> };
  bridgeSuccessCta: { click: () => Promise<void> };
}

const FAKE_TX_HASH = `0x${'a'.repeat(64)}`;

const makeFakeBridgePage = (overrides: Partial<FakeBridgePage> = {}): FakeBridgePage => ({
  navigate: async () => {},
  connectWallet: async () => {},
  selectFromChain: async () => {},
  selectToChain: async () => {},
  fillAmount: async () => {},
  submitBridge: async () => {},
  waitForTransactionModal: async () => {},
  waitForBridgeSuccess: async () => {},
  bridgeSuccessExplorerLink: { getAttribute: async () => `https://explorer/tx/${FAKE_TX_HASH}` },
  bridgeSuccessCta: { click: async () => {} },
  ...overrides
});

/** Builds a `BrowserUser` with `bridgePage` and `getPublicClient` swapped for
 * test doubles — same escape-hatch convention this file already uses for
 * `page` above (`init()` is never called; instance state is poked directly). */
const makeBridgeDriver = (bridgePage: FakeBridgePage): BrowserUser => {
  const user = new BrowserUser({
    userId: 'u1',
    privateKey: TEST_PRIVATE_KEY,
    pool: fakePool,
    chains: [CHAIN, CHAIN_L2],
    aggkitProxyUrl: 'http://localhost:9000',
    collector: createCollector(),
    clock: makeClock()
  });
  (user as unknown as { bridgePage: FakeBridgePage }).bridgePage = bridgePage;
  // Stub out the receipt-decode step's client so it never makes a real
  // network call — `bridge()` already tolerates this failing (it classifies
  // and reports `bridgeEventDecodeError` rather than throwing), but stubbing
  // it keeps the test deterministic and network-free rather than relying on
  // that fallback.
  (
    user as unknown as {
      getPublicClient: (chainKey: string) => { getTransactionReceipt: () => Promise<{ logs: [] }> };
    }
  ).getPublicClient = () => ({ getTransactionReceipt: async () => ({ logs: [] }) });
  return user;
};

describe('BrowserUser — S25 one-page-at-a-time serialization', () => {
  it('N concurrent bridge() calls on one driver execute strictly one at a time', async () => {
    let active = 0;
    let overlapDetected = false;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstCallCount = 0;

    // Deterministic gate: resolves the instant the FIRST call's own
    // `waitForBridgeSuccess` has actually been entered and is blocked —
    // never a fixed number of `await Promise.resolve()` ticks, which would
    // be guessing how many microtask hops `bridge()`'s real `await` chain
    // takes before reaching that point.
    let signalFirstBlocked: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      signalFirstBlocked = resolve;
    });

    const enter = (label: string): void => {
      active += 1;
      if (active > 1) overlapDetected = true;
      order.push(`${label}:enter`);
    };
    const exit = (label: string): void => {
      order.push(`${label}:exit`);
      active -= 1;
    };

    const bridgePage = makeFakeBridgePage({
      // `navigate()` is the FIRST thing `bridge()`'s `gotoHome()` calls —
      // marks the start of a lap actually touching the page.
      navigate: async () => {
        enter('navigate');
      },
      // `waitForBridgeSuccess()` is where the FIRST call deliberately
      // blocks (held open by `releaseFirst`) so a second, concurrently-
      // started `bridge()` call has every opportunity to slip in and touch
      // the page — if serialization were broken, its OWN `navigate()`
      // would fire here, overlapping the first call's still-open turn.
      waitForBridgeSuccess: async () => {
        firstCallCount += 1;
        if (firstCallCount === 1) {
          const blockedPromise = new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          signalFirstBlocked();
          await blockedPromise;
        }
      },
      bridgeSuccessCta: {
        click: async () => {
          // Last page-touching step in the native-asset path — marks the
          // end of this lap's turn.
          exit('cta-click');
        }
      }
    });
    const user = makeBridgeDriver(bridgePage);

    const first = user.bridge(ETH_HOP);
    const second = user.bridge(ETH_HOP);

    // Wait until the FIRST call is genuinely blocked mid-flight. At this
    // point a broken (unserialized) implementation would already have let
    // the SECOND call's own `navigate()` run concurrently — a correctly
    // serialized one has not even started the second call yet.
    await firstBlocked;

    expect(order).toEqual(['navigate:enter']); // only the FIRST call has touched the page so far
    expect(overlapDetected).toBe(false);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(overlapDetected).toBe(false);
    // Exactly one full enter/exit cycle for lap 1, THEN one for lap 2 — never
    // interleaved (an "enter" always immediately follows the previous "exit").
    expect(order).toEqual(['navigate:enter', 'cta-click:exit', 'navigate:enter', 'cta-click:exit']);
  });

  it('a failure in one queued lap does not fail or deadlock the others', async () => {
    let navigateCalls = 0;
    const bridgePage = makeFakeBridgePage({
      navigate: async () => {
        navigateCalls += 1;
        // Only the FIRST queued lap's own page-touching work fails — a
        // plain rejection `bridge()` does not internally catch (unlike
        // `waitForBridgeSuccess`'s failure path, which is swallowed into a
        // classified result), so it propagates as a rejected `bridge()`
        // promise — the real failure shape this test needs.
        if (navigateCalls === 1) throw new Error('boom: lap 1 navigate failed');
      }
    });
    const user = makeBridgeDriver(bridgePage);

    const lap1 = user.bridge(ETH_HOP);
    const lap2 = user.bridge(ETH_HOP);
    const lap3 = user.bridge(ETH_HOP);

    await expect(lap1).rejects.toThrow('boom: lap 1 navigate failed');
    // Neither queued behind the failure nor failed BY it — each ran its own
    // work and got its own (successful) result.
    await expect(lap2).resolves.toMatchObject({ bridge: { txHash: FAKE_TX_HASH } });
    await expect(lap3).resolves.toMatchObject({ bridge: { txHash: FAKE_TX_HASH } });
    // All three actually attempted their own `navigate()` — lap 2/3 were
    // never skipped as a side effect of lap 1's failure.
    expect(navigateCalls).toBe(3);
  });
});

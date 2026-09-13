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

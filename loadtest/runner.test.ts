// R0 (loadtest/REVIEW.md, CRITICAL): the mainnet confirmation gate used to
// live ONLY inside `wallets/fund.ts`'s `fundViaTransfer`, reached only
// `if (options.fund)` — so `run` against an already-funded `env: "mainnet"`
// config broadcast a full load test with NO confirmation and NO --fund
// flag needed at all. This suite proves `runLoadTest` itself now refuses,
// unconditionally, before touching wallets/network/filesystem — the
// regression this finding is about is specifically the `fund: false` case,
// since the `fund: true` case was already covered (indirectly) by
// `wallets/fund.test.ts`'s existing `MAINNET_CONFIRMATION_REQUIRED` tests.
import { describe, expect, it, vi } from 'vitest';

import type { Hop } from './core/types';
import type { ClaimSubmission, TxStepResult } from './core/userDriver';
import type { HopMeasureState, LapRunCtx } from './runner';

import { ClassifiedFetchError } from './metrics/errors';
import {
  classifyActivityPollError,
  hopMeasurementRecord,
  MainnetConfirmationRequiredError,
  OBSERVE_ACTIVITY_DEFAULT_RETRY_MS,
  pumpStatusSuffix,
  reportActivityPollError,
  runLoadTest
} from './runner';
import {
  buildTestDevnetConfig,
  TEST_FUNDER_PRIVATE_KEY,
  TEST_MNEMONIC
} from './wallets/testHelpers';
import { NON_TERMINAL_INTERVAL_MS, SingleFlightPoller } from './workers/headless/uiCallset';

const setTestSecretEnv = (): void => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
};

describe('runLoadTest — R0 mainnet confirmation gate', () => {
  it('refuses env "mainnet" with no --fund and no --i-know-this-is-mainnet (the exact R0 repro)', async () => {
    setTestSecretEnv();
    // A devnet-shaped config is enough here: the point under test is
    // runner.ts's OWN gate, checked before any wallet derivation, funding,
    // preflight, or driver work — nothing below the gate should ever run.
    const config = { ...buildTestDevnetConfig(), env: 'mainnet' as const };

    await expect(
      runLoadTest({
        config,
        activeAssetIndices: [0],
        configPath: '/nonexistent/loadtest.config.json',
        repoRoot: '/nonexistent-repo-root',
        fund: false,
        mainnetConfirmed: false,
        outDir: '/nonexistent/out'
      })
    ).rejects.toThrow(MainnetConfirmationRequiredError);
  });

  it('the thrown error names the flag and cites R0, not a generic message', async () => {
    setTestSecretEnv();
    const config = { ...buildTestDevnetConfig(), env: 'mainnet' as const };

    await expect(
      runLoadTest({
        config,
        activeAssetIndices: [0],
        configPath: '/nonexistent/loadtest.config.json',
        repoRoot: '/nonexistent-repo-root',
        fund: false,
        mainnetConfirmed: false,
        outDir: '/nonexistent/out'
      })
    ).rejects.toThrow(/MAINNET_CONFIRMATION_REQUIRED[\s\S]*--i-know-this-is-mainnet/);
  });
});

describe('hopMeasurementRecord — the hop_measurement record built at hop end (S45 C3)', () => {
  const step = (
    over: Partial<TxStepResult> & { gas?: NonNullable<TxStepResult['receipt']>['gas'] } = {}
  ): TxStepResult => ({
    txHash: `0x${'1'.repeat(64)}`,
    submit: { startedAt: 100, durationMs: 20 },
    receipt: {
      status: 'success',
      timing: { startedAt: 120, durationMs: 80 },
      ...(over.gas !== undefined ? { gas: over.gas } : {})
    },
    ...(over.error !== undefined ? { error: over.error } : {})
  });

  const hop = {
    id: 'u0-l0-h1',
    spec: {
      hopIndex: 1,
      hopRoute: 'BALI_85->BALI_82',
      fromChainKey: 'BALI_85',
      toChainKey: 'BALI_82',
      fromNetworkId: 85,
      toNetworkId: 82,
      assetIndex: 1,
      assetKind: 'erc20',
      amount: '0.001',
      decimals: 18,
      autoclaim: { expected: false }
    },
    outcome: 'hop_completed_manual',
    depositCount: 7,
    bridgeTxHash: '0xb',
    claimTxHash: '0xc',
    readyAt: 9000
  } as unknown as Hop;

  const ctx = {
    userId: 'u0',
    mode: 'headless',
    assets: [
      { kind: 'eth', amount: '1', decimals: 18 },
      { kind: 'erc20', address: '0x01', originNetworkId: 82, amount: '1', decimals: 18 }
    ]
  } as unknown as LapRunCtx;

  it('stitches bridge, probe stages, ready time and claim gas into one record', () => {
    const claim: ClaimSubmission = {
      isClaimedBefore: false,
      isClaimedTiming: { startedAt: 0, durationMs: 1 },
      claimInputs: null,
      claim: step({
        gas: {
          blockNumber: '55',
          gasUsed: '120000',
          effectiveGasPrice: '1000251',
          l1Fee: '150',
          wrapperDeployed: false
        }
      }),
      isClaimedRecheck: null
    };
    const st: HopMeasureState = {
      bridge: step({ gas: { blockNumber: '40', gasUsed: '1', effectiveGasPrice: '1' } }),
      depositCount: 7,
      claim,
      stages: {
        l1InfoTreeIndexAt: 1,
        l1InfoTreeIndex: 3,
        injectedLeafAt: 2,
        injectedLeafIndex: 4,
        claimProofAt: 2,
        polls: 5
      },
      probeAbort: null
    };

    const record = hopMeasurementRecord(ctx, hop, 'u0-l0', st);

    expect(record).toMatchObject({
      hopId: 'u0-l0-h1',
      lapId: 'u0-l0',
      hopRoute: 'BALI_85->BALI_82',
      fromNetworkId: 85,
      toNetworkId: 82,
      assetKind: 'erc20',
      tokenOriginNetworkId: 82,
      outcome: 'hop_completed_manual',
      depositCount: 7,
      readyObservedAt: 9000,
      bridge: { blockNumber: '40', minedObservedAt: 200 },
      claim: {
        blockNumber: '55',
        sentAt: 120,
        minedObservedAt: 200,
        claimKind: 'erc20_origin_unlock',
        gas: { l1Fee: '150' }
      }
    });
    expect(record.stages?.polls).toBe(5);
  });

  it('records a hop that never claimed (no probe, no claim) with claimKind none and null gas', () => {
    const st: HopMeasureState = {
      bridge: null,
      depositCount: null,
      claim: null,
      stages: null,
      probeAbort: null
    };
    const record = hopMeasurementRecord(ctx, { ...hop, depositCount: null, readyAt: null } as Hop, 'l', st);
    expect(record.claim).toMatchObject({ claimKind: 'none', gas: null, sentAt: null });
    expect(record.stages).toBeNull();
    expect(record.bridge.minedObservedAt).toBeNull();
  });
});

// S53 / heavy-load design F3.
describe('classifyActivityPollError — what the runner does with a failed activity poll', () => {
  it('a tracker error that kept its class is reported under that class, not re-classified as internal', () => {
    const out = classifyActivityPollError(
      new ClassifiedFetchError({ errorClass: 'proxy_5xx', message: 'HTTP 502' }, 502)
    );
    expect(out.classified).toStrictEqual({ errorClass: 'proxy_5xx', message: 'HTTP 502' });
  });

  it('backs off for the UI non-terminal cadence (5 s) on any classified tracker error, tracker_not_ready included', () => {
    for (const errorClass of ['tracker_not_ready', 'proxy_5xx', 'proxy_4xx'] as const) {
      const out = classifyActivityPollError(
        new ClassifiedFetchError({ errorClass, message: 'x' }, 503)
      );
      expect(out.retryAfterMs).toBe(NON_TERMINAL_INTERVAL_MS);
    }
    expect(NON_TERMINAL_INTERVAL_MS).toBe(5000);
  });

  it('an unclassified failure keeps the old 1 s retry and the old classification', () => {
    const out = classifyActivityPollError(new Error('socket hang up'));
    expect(out.retryAfterMs).toBe(OBSERVE_ACTIVITY_DEFAULT_RETRY_MS);
    expect(OBSERVE_ACTIVITY_DEFAULT_RETRY_MS).toBe(1000);
    expect(out.classified.errorClass).toBe('internal');
  });
});

// S58a M2: the single-flight activity poller hands every joined caller the SAME rejection.
// Each waiting hop then reports it, so one failed fetch became one error record per in-flight
// lap of that wallet (16 laps -> 16 `proxy_5xx`), inflating SC4. It is one failed fetch.
describe('reportActivityPollError — one error record per failed fetch, not per waiting hop (S58a M2)', () => {
  const ctxWith = (error: ReturnType<typeof vi.fn>) =>
    ({ collector: { error }, userId: 'u0', mode: 'headless' }) as unknown as LapRunCtx;

  it('16 hops joined onto one failed poll write one error record, and every hop still backs off', async () => {
    let realFetches = 0;
    const poller = new SingleFlightPoller<number[]>({
      sleepFn: async () => {},
      isFatal: (e) => e instanceof ClassifiedFetchError && e.errorClass === 'tracker_not_ready'
    });
    const fetchFn = async (): Promise<number[]> => {
      realFetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new ClassifiedFetchError({ errorClass: 'proxy_5xx', message: 'HTTP 502' }, 502);
    };
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => poller.run(() => 0, fetchFn))
    );
    const error = vi.fn();
    const ctx = ctxWith(error);
    const retries = results.map((r, i) =>
      reportActivityPollError(ctx, `u0:a0:l${i}:h0`, (r as PromiseRejectedResult).reason)
    );

    expect(realFetches).toBe(3); // 3 attempts of ONE shared chain
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({ errorClass: 'proxy_5xx', userId: 'u0' });
    expect(retries).toStrictEqual(Array.from({ length: 16 }, () => NON_TERMINAL_INTERVAL_MS));
  });

  it('two separate failed fetches are two records (the dedupe is per error instance)', () => {
    const error = vi.fn();
    const ctx = ctxWith(error);
    reportActivityPollError(ctx, 'h0', new ClassifiedFetchError({ errorClass: 'proxy_5xx', message: 'a' }, 502));
    reportActivityPollError(ctx, 'h0', new ClassifiedFetchError({ errorClass: 'proxy_5xx', message: 'a' }, 502));
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('a non-object rejection is still reported (nothing to dedupe on)', () => {
    const error = vi.fn();
    const ctx = ctxWith(error);
    reportActivityPollError(ctx, 'h0', 'boom');
    reportActivityPollError(ctx, 'h0', 'boom');
    expect(error).toHaveBeenCalledTimes(2);
  });
});

// S58a L9: the plan counted the run duration only, but the pump keeps firing during the drain
// (up to hopMs after the last lap start), so a long drain read as `20/13`.
describe('pumpStatusSuffix — the status-line pump plan never reads settled > planned (S58a L9)', () => {
  const ETH1 = BigInt(10) ** BigInt(18);
  it('plans floor(duration / interval) + 1 deposits while the run is inside its duration', () => {
    expect(pumpStatusSuffix(3, ETH1 / BigInt(100), 120, 600)).toBe(' pump=on(3/13,0.01ETH)');
  });
  it('grows the plan with the drain instead of showing 20/13', () => {
    expect(pumpStatusSuffix(20, BigInt(0), 120, 600)).toBe(' pump=on(20/20,0ETH)');
  });
});

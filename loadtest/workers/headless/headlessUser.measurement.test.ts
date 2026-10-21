// S45 C1/C2 on the headless driver: receipt gas capture through `sendAndWait`
// / `claim()`, wrapper-deploy detection from the claim receipt logs, and the
// stage probe (fake timers: each stage timestamp is the first poll that
// returned ready, a stage is never re-polled, the probe stops, and every probe
// request runs in the `harness` fetch origin).
import type { Address, Hex } from 'viem';

import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadtestChain } from '../../config/schema';
import type { HopSpec, ObservedRow } from '../../core/types';

import { createCollector } from '../../metrics/collector';
import { buildTestDevnetConfig } from '../../wallets/testHelpers';
import { HeadlessUser } from './headlessUser';
import { NEW_WRAPPED_TOKEN_ABI } from './receiptGas';
import { installTimingFetch } from './uiCallset';

const USER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TX_HASH: Hex = `0x${'cd'.repeat(32)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

const build = async () => {
  const config = buildTestDevnetConfig({ usersTotal: 1 });
  const toChain = config.chains.find((c) => c.key === 'L2B') as LoadtestChain;
  const user = new HeadlessUser({
    userId: 'u1',
    account: { address: USER } as never,
    chains: config.chains,
    assets: config.assets,
    aggkitProxyUrl: 'http://127.0.0.1:1',
    bridgeGasOffset: 0,
    collector: createCollector()
  });
  await user.init();
  return { user, toChain };
};

const newWrappedTokenLog = (address: string) => ({
  address,
  topics: encodeEventTopics({ abi: NEW_WRAPPED_TOKEN_ABI, eventName: 'NewWrappedToken' }),
  data: encodeAbiParameters(
    [{ type: 'uint32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }],
    [1, USER, USER, '0x']
  )
});

const claimHop: HopSpec = {
  hopIndex: 0,
  hopRoute: 'L2A->L2B',
  fromChainKey: 'L2A',
  toChainKey: 'L2B',
  fromNetworkId: 1,
  toNetworkId: 2,
  assetIndex: 0,
  assetKind: 'erc20',
  assetAddress: USER,
  amount: '0.001',
  decimals: 18,
  autoclaim: { expected: false }
};

const row = {
  rowKey: `${TX_HASH}:3`,
  depositCount: 3,
  sourceNetwork: 1,
  destinationNetwork: 2,
  globalIndex: '5'
} as unknown as ObservedRow;

const wireClaim = (
  h: Awaited<ReturnType<typeof build>>,
  receipt: Record<string, unknown>
) => {
  const fake = h.user as unknown as Record<string, unknown>;
  fake.native = {
    bridge: () => ({
      isClaimed: vi.fn(async () => false),
      buildClaimAsset: vi.fn(async () => ({ to: h.toChain.bridgeAddress, data: '0x12' }))
    })
  };
  fake.aggregator = {
    getClaimInputs: vi.fn(async () => ({
      claimable: true,
      proof: {
        proof_local_exit_root: [ZERO32],
        proof_rollup_exit_root: [ZERO32],
        l1_info_tree_leaf: {
          block_num: 1,
          block_pos: 0,
          l1_info_tree_index: 9,
          previous_block_hash: '0x',
          timestamp: 1,
          mainnet_exit_root: ZERO32,
          rollup_exit_root: ZERO32,
          global_exit_root: ZERO32,
          hash: ZERO32
        }
      }
    }))
  };
  (fake.depositInfo as Map<string, unknown>).set(row.rowKey, {
    amount: BigInt(1),
    metadata: '0x',
    originNetwork: 1,
    originTokenAddress: USER,
    destinationNetwork: 2,
    destinationAddress: USER
  });
  fake.runtimes = new Map([
    [
      h.toChain.key,
      {
        chain: h.toChain,
        public: { waitForTransactionReceipt: vi.fn(async () => receipt) },
        wallet: { sendTransaction: vi.fn(async () => TX_HASH) }
      }
    ]
  ]);
};

const opReceipt = (logs: unknown[]) => ({
  status: 'success',
  blockNumber: BigInt(77),
  gasUsed: BigInt(250000),
  effectiveGasPrice: BigInt(1000251),
  l1Fee: '0x78',
  l1GasUsed: '0x1388',
  logs
});

describe('HeadlessUser.claim — receipt gas capture and wrapper-deploy detection', () => {
  it('keeps gas + OP L1-fee fields and flags wrapperDeployed when the bridge emitted NewWrappedToken', async () => {
    const h = await build();
    wireClaim(h, opReceipt([newWrappedTokenLog(h.toChain.bridgeAddress)]));

    const result = await h.user.claim(claimHop, row);

    expect(result.claim?.receipt?.status).toBe('success');
    expect(result.claim?.receipt?.gas).toStrictEqual({
      blockNumber: '77',
      gasUsed: '250000',
      effectiveGasPrice: '1000251',
      l1Fee: '120',
      l1GasUsed: '5000',
      wrapperDeployed: true
    });
  });

  it('flags wrapperDeployed=false on a repeat claim (no NewWrappedToken log)', async () => {
    const h = await build();
    wireClaim(h, opReceipt([]));

    const result = await h.user.claim(claimHop, row);

    expect(result.claim?.receipt?.gas?.wrapperDeployed).toBe(false);
    expect(result.claim?.receipt?.gas?.gasUsed).toBe('250000');
  });
});

// ---------------------------------------------------------------------------
// Stage probe
// ---------------------------------------------------------------------------

type Probe = { ready: true; value: unknown } | { ready: false; reason: string; detail: string };
const notReady: Probe = { ready: false, reason: 'X', detail: '' };

const wireProbe = (
  user: HeadlessUser,
  script: { index: Probe[]; leaf: Probe[]; proof: Probe[] }
) => {
  const take = (list: Probe[]) => vi.fn(async () => (list.length > 1 ? list.shift() : list[0]));
  const getL1InfoTreeIndex = take(script.index);
  const getInjectedL1InfoLeaf = take(script.leaf);
  const getClaimProof = take(script.proof);
  (user as unknown as Record<string, unknown>).aggregator = {
    clientFor: () => ({ getL1InfoTreeIndex, getInjectedL1InfoLeaf, getClaimProof })
  };
  return { getL1InfoTreeIndex, getInjectedL1InfoLeaf, getClaimProof };
};

describe('HeadlessUser.probeClaimStages', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timestamps each stage at the first ready poll, never re-polls a ready stage, and stops at claim-proof', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = await build();
    const calls = wireProbe(h.user, {
      index: [notReady, { ready: true, value: 42 }],
      leaf: [
        notReady,
        {
          ready: true,
          value: { l1_info_tree_index: 44, injected_l2_block_num: 900, injected_l2_block_timestamp: 1234 }
        }
      ],
      proof: [notReady, { ready: true, value: {} }]
    });
    const progress: number[] = [];

    const promise = h.user.probeClaimStages({
      sourceNetwork: 1,
      destinationNetwork: 2,
      depositCount: 3,
      intervalMs: 5000,
      deadlineAt: 1_000_000 + 3_600_000,
      onProgress: (p) => progress.push(p.polls)
    });
    await vi.advanceTimersByTimeAsync(0); // round 1 at t0: index not ready
    await vi.advanceTimersByTimeAsync(5000); // round 2 at +5s: index ready, leaf not ready
    await vi.advanceTimersByTimeAsync(5000); // round 3 at +10s: leaf ready, proof not ready
    await vi.advanceTimersByTimeAsync(5000); // round 4 at +15s: proof ready -> stop
    const result = await promise;

    expect(result).toStrictEqual({
      l1InfoTreeIndexAt: 1_005_000,
      l1InfoTreeIndex: 42,
      injectedLeafAt: 1_010_000,
      injectedLeafIndex: 44,
      injectedL2BlockNum: 900,
      injectedL2BlockTimestamp: 1234,
      claimProofAt: 1_015_000,
      polls: 6 // index x2, leaf x2, proof x2
    });
    // a ready stage is not polled again
    expect(calls.getL1InfoTreeIndex).toHaveBeenCalledTimes(2);
    expect(calls.getInjectedL1InfoLeaf).toHaveBeenCalledTimes(2);
    expect(calls.getClaimProof).toHaveBeenCalledTimes(2);
    // proof was requested against the INJECTED leaf index (SDK order)
    expect(calls.getClaimProof).toHaveBeenLastCalledWith({ networkId: 1, leafIndex: 44, depositCount: 3 });
    // stopped: nothing more is polled
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.getL1InfoTreeIndex).toHaveBeenCalledTimes(2);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('issues its requests in the harness origin, keeping them out of the UI-parity numbers', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const collector = createCollector();
    const handle = installTimingFetch(collector, { now: () => Date.now() });
    try {
      const config = buildTestDevnetConfig({ usersTotal: 1 });
      const user = new HeadlessUser({
        userId: 'u1',
        account: { address: USER } as never,
        chains: config.chains,
        assets: config.assets,
        aggkitProxyUrl: 'http://127.0.0.1:1',
        bridgeGasOffset: 0,
        collector
      });
      await user.init();
      const url = 'http://127.0.0.1:1/bridge/v1/l1-info-tree-index?network_id=1&deposit_count=3';
      const ready = async () => {
        await fetch(url);
        return { ready: true, value: 1 };
      };
      (user as unknown as Record<string, unknown>).aggregator = {
        clientFor: () => ({
          getL1InfoTreeIndex: ready,
          getInjectedL1InfoLeaf: async () => ({ ready: true, value: { l1_info_tree_index: 1 } }),
          getClaimProof: async () => ({ ready: true, value: {} })
        })
      };
      await user.probeClaimStages({
        sourceNetwork: 1,
        destinationNetwork: 2,
        depositCount: 3,
        intervalMs: 1000,
        deadlineAt: Date.now() + 60_000
      });
      const http = Object.values(collector.snapshot().http);
      expect(http).toHaveLength(1);
      expect(http[0].headless.harness?.n).toBe(1);
      expect(http[0].headless.ui).toBeNull();
    } finally {
      handle.uninstall();
      globalThis.fetch = original;
    }
  });

  it('stops on abort and resolves with the partial result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const h = await build();
    wireProbe(h.user, {
      index: [{ ready: true, value: 7 }],
      leaf: [notReady],
      proof: [notReady]
    });
    const abort = new AbortController();
    const promise = h.user.probeClaimStages({
      sourceNetwork: 1,
      destinationNetwork: 2,
      depositCount: 0,
      intervalMs: 1000,
      deadlineAt: 2_000_000 + 3_600_000,
      signal: abort.signal
    });
    await vi.advanceTimersByTimeAsync(2500);
    abort.abort();
    const result = await promise;

    expect(result.l1InfoTreeIndex).toBe(7);
    expect(result.injectedLeafAt).toBeNull();
    expect(result.claimProofAt).toBeNull();
  });

  it('stops at the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const h = await build();
    const calls = wireProbe(h.user, { index: [notReady], leaf: [notReady], proof: [notReady] });
    const promise = h.user.probeClaimStages({
      sourceNetwork: 1,
      destinationNetwork: 2,
      depositCount: 0,
      intervalMs: 1000,
      deadlineAt: 3_000_000 + 2500
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.l1InfoTreeIndexAt).toBeNull();
    expect(calls.getL1InfoTreeIndex).toHaveBeenCalledTimes(3);
  });
});

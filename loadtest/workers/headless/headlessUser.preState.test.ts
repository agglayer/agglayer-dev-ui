// S53 M9 (`measurement.claimPreState`): wrapped-token supply and recipient
// balance read just before a wrapped-token claim. Off by default; harness-origin
// reads; best effort (a failed read never touches the claim).
import type { Address, Hex } from 'viem';

import { describe, expect, it, vi } from 'vitest';

import type { LoadtestChain } from '../../config/schema';
import type { HopSpec, ObservedRow } from '../../core/types';

import { createCollector } from '../../metrics/collector';
import { buildTestDevnetConfig } from '../../wallets/testHelpers';
import { HeadlessUser } from './headlessUser';
import { installTimingFetch } from './uiCallset';

const USER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const WRAPPED: Address = '0x00000000000000000000000000000000000000d4';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const TX_HASH: Hex = `0x${'cd'.repeat(32)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

// assets[1] of the fixture is the erc20 whose origin is network 0 (the L1).
const WRAPPED_MINT_HOP: HopSpec = {
  hopIndex: 0,
  hopRoute: 'L1->L2B',
  fromChainKey: 'L1',
  toChainKey: 'L2B',
  fromNetworkId: 0,
  toNetworkId: 2,
  assetIndex: 1,
  assetKind: 'erc20',
  assetAddress: USER,
  amount: '0.001',
  decimals: 18,
  autoclaim: { expected: false }
};
const ORIGIN_UNLOCK_HOP: HopSpec = {
  ...WRAPPED_MINT_HOP,
  hopRoute: 'L2B->L1',
  fromChainKey: 'L2B',
  toChainKey: 'L1',
  fromNetworkId: 2,
  toNetworkId: 0
};
const ETH_HOP: HopSpec = { ...WRAPPED_MINT_HOP, assetIndex: 0, assetKind: 'eth' };

const row = {
  rowKey: `${TX_HASH}:3`,
  depositCount: 3,
  sourceNetwork: 0,
  destinationNetwork: 2,
  globalIndex: '5'
} as unknown as ObservedRow;

interface Wiring {
  events: string[];
  readContract: ReturnType<typeof vi.fn>;
  sendTransaction: ReturnType<typeof vi.fn>;
}

const build = async (
  claimPreState: boolean | undefined,
  over: { wrapped?: Address; read?: (name: string) => unknown } = {}
) => {
  const config = buildTestDevnetConfig({ usersTotal: 1 });
  const collector = createCollector();
  const user = new HeadlessUser({
    userId: 'u1',
    account: { address: USER } as never,
    chains: config.chains,
    assets: config.assets,
    aggkitProxyUrl: 'http://127.0.0.1:1',
    bridgeGasOffset: 0,
    collector,
    ...(claimPreState !== undefined ? { claimPreState } : {})
  });
  await user.init();
  const claimChain = (key: string) => config.chains.find((c) => c.key === key) as LoadtestChain;
  const events: string[] = [];
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    events.push(`read:${functionName}`);
    if (over.read !== undefined) return over.read(functionName);
    return functionName === 'totalSupply' ? BigInt(1_000_000) : BigInt(250);
  });
  const sendTransaction = vi.fn(async () => {
    events.push('send');
    return TX_HASH;
  });
  const fake = user as unknown as Record<string, unknown>;
  const buildClaimAsset = vi.fn(async () => ({
    to: claimChain('L2B').bridgeAddress,
    data: '0x12'
  }));
  fake.native = {
    bridge: () => ({ isClaimed: vi.fn(async () => false), buildClaimAsset })
  };
  fake.aggregator = {
    clientFor: () => ({
      getTokenMappings: async () => ({
        token_mappings: [{ wrapped_token_address: over.wrapped ?? WRAPPED }]
      })
    }),
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
    originNetwork: 0,
    originTokenAddress: USER,
    destinationNetwork: 2,
    destinationAddress: USER
  });
  const receipt = {
    status: 'success',
    blockNumber: BigInt(77),
    gasUsed: BigInt(177166),
    effectiveGasPrice: BigInt(1),
    logs: []
  };
  fake.runtimes = new Map(
    ['L1', 'L2B'].map((key) => [
      key,
      {
        chain: claimChain(key),
        public: { waitForTransactionReceipt: vi.fn(async () => receipt), readContract },
        wallet: { sendTransaction }
      }
    ])
  );
  const wiring: Wiring = { events, readContract, sendTransaction };
  return { user, collector, ...wiring };
};

describe('HeadlessUser.claim — claim pre-state (M9)', () => {
  it('reads totalSupply and the recipient balance of the wrapped token BEFORE sending the claim', async () => {
    const h = await build(true);
    const result = await h.user.claim(WRAPPED_MINT_HOP, row);

    expect(result.preState).toStrictEqual({
      wrappedSupplyBefore: '1000000',
      recipientBalanceBefore: '250'
    });
    expect(h.events.indexOf('send')).toBe(2);
    expect([...h.events.slice(0, 2)].sort()).toStrictEqual(['read:balanceOf', 'read:totalSupply']);
    const calls = h.readContract.mock.calls.map(([args]) => args as Record<string, unknown>);
    expect(calls.every((c) => c.address === WRAPPED)).toBe(true);
    expect(calls.find((c) => c.functionName === 'balanceOf')?.args).toStrictEqual([USER]);
    expect(result.claim?.receipt?.status).toBe('success');
  });

  it('is off by default: no read at all and no preState key on the result', async () => {
    for (const option of [undefined, false]) {
      const h = await build(option);
      const result = await h.user.claim(WRAPPED_MINT_HOP, row);
      expect(h.readContract).not.toHaveBeenCalled();
      expect('preState' in result).toBe(false);
    }
  });

  it('does nothing for an ETH hop or a claim on the token origin network', async () => {
    const h = await build(true);
    expect('preState' in (await h.user.claim(ETH_HOP, row))).toBe(false);
    expect('preState' in (await h.user.claim(ORIGIN_UNLOCK_HOP, row))).toBe(false);
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('skips a claim whose wrapper is not deployed yet (zero wrapped address): that claim deploys it', async () => {
    const h = await build(true, { wrapped: ZERO });
    // `lookupWrapped` is the on-chain fallback; make it answer zero too.
    const native = (h.user as unknown as Record<string, Record<string, unknown>>).native;
    const original = native.bridge as (...args: unknown[]) => Record<string, unknown>;
    native.bridge = (...args: unknown[]) => ({
      ...original(...args),
      getWrappedTokenAddress: vi.fn(async () => ZERO)
    });
    const result = await h.user.claim(WRAPPED_MINT_HOP, row);
    expect('preState' in result).toBe(false);
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('a failing read never affects the claim: it is sent, and there is simply no preState', async () => {
    const h = await build(true, {
      read: () => {
        throw new Error('rpc unavailable');
      }
    });
    const result = await h.user.claim(WRAPPED_MINT_HOP, row);
    expect('preState' in result).toBe(false);
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.claim?.receipt?.status).toBe('success');
  });

  it('runs its reads (and the wrapper lookup) in a harness fetch context, never counted as UI traffic', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const collector = createCollector();
    const handle = installTimingFetch(collector, { now: () => Date.now() });
    try {
      const h = await build(true, {
        read: (name) => {
          // Stand-in for viem's HTTP transport: the read performs a real fetch.
          void globalThis.fetch('http://rpc.example.invalid/', {
            method: 'POST',
            body: JSON.stringify({ method: name === 'totalSupply' ? 'eth_call' : 'eth_call' })
          });
          return BigInt(1);
        }
      });
      await h.user.claim(WRAPPED_MINT_HOP, row);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      handle.uninstall();
      globalThis.fetch = original;
    }
    const entries = Object.values(collector.snapshot().http);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.headless.harness?.n).toBe(2);
      expect(entry.headless.ui).toBeNull();
    }
    expect(collector.snapshot().uncontextedRequests).toBe(0);
  });
});

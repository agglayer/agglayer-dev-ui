// `gas.claimGasOffset`: headless-only additive margin on the CLAIM send's gas
// limit (ring J stage 2: first-mint claims ran out of gas at the bare estimate).
import type { Address, Hex } from 'viem';

import { describe, expect, it, vi } from 'vitest';

import type { LoadtestChain } from '../../config/schema';
import type { HopSpec, ObservedRow } from '../../core/types';

import { createCollector } from '../../metrics/collector';
import { buildTestDevnetConfig } from '../../wallets/testHelpers';
import { HeadlessUser } from './headlessUser';

const USER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TX_HASH: Hex = `0x${'cd'.repeat(32)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

const ETH_HOP: HopSpec = {
  hopIndex: 0,
  hopRoute: 'L1->L2B',
  fromChainKey: 'L1',
  toChainKey: 'L2B',
  fromNetworkId: 0,
  toNetworkId: 2,
  assetIndex: 0,
  assetKind: 'eth',
  assetAddress: USER,
  amount: '0.001',
  decimals: 18,
  autoclaim: { expected: false }
};
const row = {
  rowKey: `${TX_HASH}:3`,
  depositCount: 3,
  sourceNetwork: 0,
  destinationNetwork: 2,
  globalIndex: '5'
} as unknown as ObservedRow;

const build = async (opts: { claimGasOffset?: number; sdkGas?: bigint; estimate?: bigint }) => {
  const config = buildTestDevnetConfig({ usersTotal: 1 });
  const user = new HeadlessUser({
    userId: 'u1',
    account: { address: USER } as never,
    chains: config.chains,
    assets: config.assets,
    aggkitProxyUrl: 'http://127.0.0.1:1',
    bridgeGasOffset: 0,
    collector: createCollector(),
    ...(opts.claimGasOffset !== undefined ? { claimGasOffset: opts.claimGasOffset } : {})
  });
  await user.init();
  const chain = (key: string) => config.chains.find((c) => c.key === key) as LoadtestChain;
  const sendTransaction = vi.fn(async (_args: Record<string, unknown>) => TX_HASH);
  const estimateGas = vi.fn(async () => opts.estimate ?? BigInt(0));
  const fake = user as unknown as Record<string, unknown>;
  fake.native = {
    bridge: () => ({
      isClaimed: vi.fn(async () => false),
      buildClaimAsset: vi.fn(async () => ({
        to: chain('L2B').bridgeAddress,
        data: '0x12',
        ...(opts.sdkGas !== undefined ? { gas: opts.sdkGas } : {})
      }))
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
        chain: chain(key),
        public: { waitForTransactionReceipt: vi.fn(async () => receipt), estimateGas },
        wallet: { sendTransaction }
      }
    ])
  );
  return { user, sendTransaction, estimateGas };
};

const sentGas = (h: Awaited<ReturnType<typeof build>>) =>
  h.sendTransaction.mock.calls[0]?.[0]?.gas;

describe('HeadlessUser.claim — claimGasOffset', () => {
  it('adds the margin to the SDK claim gas', async () => {
    const h = await build({ claimGasOffset: 60_000, sdkGas: BigInt(202_542) });
    await h.user.claim(ETH_HOP, row);
    expect(sentGas(h)).toBe(BigInt(262_542));
    expect(h.estimateGas).not.toHaveBeenCalled();
  });

  it('estimates once and adds the margin when the SDK params carry no gas', async () => {
    const h = await build({ claimGasOffset: 60_000, estimate: BigInt(200_000) });
    await h.user.claim(ETH_HOP, row);
    expect(h.estimateGas).toHaveBeenCalledTimes(1);
    expect(sentGas(h)).toBe(BigInt(260_000));
  });

  it('falls back to viem own estimate (no gas field) when the estimate fails', async () => {
    const h = await build({ claimGasOffset: 60_000 });
    h.estimateGas.mockRejectedValueOnce(new Error('boom'));
    await h.user.claim(ETH_HOP, row);
    expect('gas' in (h.sendTransaction.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it('applies no margin when the offset is 0 or unset', async () => {
    for (const claimGasOffset of [0, undefined]) {
      const h = await build({ sdkGas: BigInt(202_542), ...(claimGasOffset !== undefined ? { claimGasOffset } : {}) });
      await h.user.claim(ETH_HOP, row);
      expect('gas' in (h.sendTransaction.mock.calls[0]?.[0] ?? {})).toBe(false);
    }
  });
});

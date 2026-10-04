// S07: how `HeadlessUser.bridge()` builds the bridge call and checks the leaf
// identity for the `eth` asset on ETH-gas vs gas-token chains (Design B, SD4).
//
// `init()` is run for real (it only constructs clients, no I/O); the SDK
// handle and per-chain viem runtimes are then replaced by in-memory fakes, so
// there is no network and no RPC. The fake `buildBridgeAsset` mirrors the
// pinned SDK's one relevant rule (`dist/index.js:720-735`): `value = amount`
// iff `token == 0x0`, otherwise no value.
import type { Address, Hex } from 'viem';

import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import type { LoadtestChain } from '../../config/schema';
import type { HopSpec } from '../../core/types';

import { createCollector } from '../../metrics/collector';
import { buildTestDevnetConfig } from '../../wallets/testHelpers';
import { HeadlessUser } from './headlessUser';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const WETH: Address = '0x77290275947F166793b8d10428670e1fcA26960a';
const USER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const AMOUNT = BigInt(1_000_000_000_000_000); // "0.001" at 18 decimals
const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;

const BRIDGE_EVENT = parseAbiItem(
  'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)'
);

const bridgeEventLog = (bridgeAddress: string, originNetwork: number, originAddress: Address) => ({
  address: bridgeAddress,
  topics: encodeEventTopics({ abi: [BRIDGE_EVENT], eventName: 'BridgeEvent' }),
  data: encodeAbiParameters(
    [
      { type: 'uint8' },
      { type: 'uint32' },
      { type: 'address' },
      { type: 'uint32' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'uint32' }
    ],
    [0, originNetwork, originAddress, 2, USER, AMOUNT, '0x', 7]
  )
});

interface Harness {
  user: HeadlessUser;
  buildBridgeAsset: ReturnType<typeof vi.fn>;
  erc20: ReturnType<typeof vi.fn>;
  sendTransaction: ReturnType<typeof vi.fn>;
  fromChain: LoadtestChain;
}

/** One user on the devnet config; the receipt carries a BridgeEvent with the given leaf origin. */
const buildHarness = async (leaf: { network: number; address: Address }): Promise<Harness> => {
  const config = buildTestDevnetConfig({ usersTotal: 1 });
  const fromChain = config.chains.find((c) => c.key === 'L2A') as LoadtestChain;

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

  const buildBridgeAsset = vi.fn(async (params: { token: Address; amount: string }) => ({
    to: fromChain.bridgeAddress,
    data: '0x1234',
    value: params.token === ZERO ? params.amount : undefined
  }));
  const erc20 = vi.fn(() => ({
    getBalance: vi.fn(async () => '1'),
    getAllowance: vi.fn(async () => '0'),
    buildApprove: vi.fn(async () => {
      throw new Error('approve must not be built for a WETH burn');
    }),
    bridgeTo: vi.fn(async () => {
      throw new Error('ERC20.bridgeTo must not be used for the eth asset');
    })
  }));
  const sendTransaction = vi.fn(async () => TX_HASH);

  const fake = user as unknown as Record<string, unknown>;
  fake.native = {
    getNativeBalance: vi.fn(async () => '1'),
    erc20,
    bridge: () => ({ buildBridgeAsset })
  };
  fake.runtimes = new Map([
    [
      fromChain.key,
      {
        chain: fromChain,
        public: {
          getGasPrice: vi.fn(async () => BigInt(1)),
          waitForTransactionReceipt: vi.fn(async () => ({
            status: 'success',
            logs: [bridgeEventLog(fromChain.bridgeAddress, leaf.network, leaf.address)]
          }))
        },
        wallet: { sendTransaction }
      }
    ]
  ]);

  return { user, buildBridgeAsset, erc20, sendTransaction, fromChain };
};

const ethHop = (overrides: Partial<HopSpec> = {}): HopSpec => ({
  hopIndex: 0,
  hopRoute: 'L2A->L2B',
  fromChainKey: 'L2A',
  toChainKey: 'L2B',
  fromNetworkId: 1,
  toNetworkId: 2,
  assetIndex: 0,
  assetKind: 'eth',
  amount: '0.001',
  decimals: 18,
  autoclaim: { expected: true, waitMs: 1000 } as HopSpec['autoclaim'],
  ...overrides
});

describe('HeadlessUser.bridge — the eth asset on an ETH-gas chain (unchanged behaviour)', () => {
  it('bridges token = 0x0 with msg.value = amount, no ERC20 call and no approval', async () => {
    const h = await buildHarness({ network: 0, address: ZERO });

    const result = await h.user.bridge(ethHop());

    expect(result.bridgeEventFound).toBe(true);
    expect(result.approve).toBeNull();
    expect(result.allowance).toBeNull();
    expect(h.buildBridgeAsset).toHaveBeenCalledTimes(1);
    expect(h.buildBridgeAsset.mock.calls[0][0]).toMatchObject({ token: ZERO });
    expect(h.erc20).not.toHaveBeenCalled();
    expect(h.sendTransaction.mock.calls[0][0]).toMatchObject({ value: AMOUNT });
  });
});

describe('HeadlessUser.bridge — the eth asset leaving a gas-token chain (Design B)', () => {
  it('bridges token = WETHToken with no msg.value, no approval and no ERC20 helper', async () => {
    const h = await buildHarness({ network: 0, address: ZERO });

    const result = await h.user.bridge(
      ethHop({ fromWethToken: WETH, expectedOrigin: { networkId: 0, address: ZERO } })
    );

    expect(result.bridgeEventFound).toBe(true);
    expect(result.approve).toBeNull();
    expect(result.allowance).toBeNull();
    expect(h.buildBridgeAsset).toHaveBeenCalledTimes(1);
    expect(h.buildBridgeAsset.mock.calls[0][0]).toMatchObject({
      token: WETH,
      amount: AMOUNT.toString()
    });
    // The fake mirrors the SDK: token != 0 yields no value; assert what was SENT.
    const sent = h.sendTransaction.mock.calls[0][0] as { value?: bigint };
    expect(sent.value ?? BigInt(0)).toBe(BigInt(0));
    // Only the P7 display balance read touches `erc20(...)`; never approve/bridgeTo.
    const erc20Handle = h.erc20.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(erc20Handle.buildApprove).not.toHaveBeenCalled();
    expect(erc20Handle.bridgeTo).not.toHaveBeenCalled();
    expect(h.erc20.mock.calls.every(([token]) => token === WETH)).toBe(true);
  });
});

describe('HeadlessUser.bridge — leaf identity check (SD4)', () => {
  it('passes when the bridge leaf origin matches the expected origin', async () => {
    const h = await buildHarness({ network: 0, address: ZERO });

    const result = await h.user.bridge(
      ethHop({ fromWethToken: WETH, expectedOrigin: { networkId: 0, address: ZERO } })
    );

    expect(result.bridgeEventFound).toBe(true);
    expect(result.depositCount).toBe(7);
  });

  it('throws ASSET_IDENTITY_MISMATCH when the leaf is the chain gas token (63, sentinel) instead of ETH (0, 0x0)', async () => {
    // The silent-switch the check exists for: token=0x0 on a gas-token chain
    // bridges the native gas token, whose leaf origin is the chain itself.
    const sentinel: Address = '0x0000003f0000003f0000003f0000003f0000003f';
    const h = await buildHarness({ network: 63, address: sentinel });

    await expect(
      h.user.bridge(ethHop({ expectedOrigin: { networkId: 0, address: ZERO } }))
    ).rejects.toThrow(/ASSET_IDENTITY_MISMATCH/);
  });

  it('throws ASSET_IDENTITY_MISMATCH when only the origin network differs', async () => {
    const h = await buildHarness({ network: 63, address: ZERO });

    await expect(
      h.user.bridge(ethHop({ expectedOrigin: { networkId: 0, address: ZERO } }))
    ).rejects.toThrow(/ASSET_IDENTITY_MISMATCH/);
  });

  it('does not check identity when the hop has no expectedOrigin (ETH-gas hops are unaffected)', async () => {
    const h = await buildHarness({ network: 63, address: ZERO });

    await expect(h.user.bridge(ethHop())).resolves.toMatchObject({ bridgeEventFound: true });
  });
});

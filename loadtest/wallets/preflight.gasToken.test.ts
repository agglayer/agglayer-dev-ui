// S07: gas-token discovery in preflight (Design B; S05 SD1 iii = auto-discover,
// no config declaration). The mock answers the three bridge views by selector:
// gasTokenAddress(), gasTokenNetwork(), WETHToken(). No network.
//
// The memo's §2.3 five-row matrix assumed a config declaration; under SD1 (iii)
// the rows collapse to the five discovery outcomes asserted below.
import { encodeFunctionData, encodeAbiParameters, parseUnits } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChainClientFactory, ChainClientSet } from './chainClients';

import { deriveWallets } from './derive';
import { runPreflight } from './preflight';
import { buildTestDevnetConfig, TEST_FUNDER_PRIVATE_KEY, TEST_MNEMONIC } from './testHelpers';

beforeEach(() => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
});

const selectorOf = (name: string) =>
  encodeFunctionData({
    abi: [{ name, type: 'function', inputs: [], outputs: [], stateMutability: 'view' }],
    functionName: name
  });
const GAS_TOKEN_ADDRESS = selectorOf('gasTokenAddress');
const GAS_TOKEN_NETWORK = selectorOf('gasTokenNetwork');
const WETH_TOKEN = selectorOf('WETHToken');

const word = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);
const addressWord = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;

const ZERO_WORD = word(BigInt(0));
const GAS_TOKEN = '0x0000003f0000003f0000003f0000003f0000003f';
const WETH = '0x77290275947f166793b8d10428670e1fca26960a';

type Reply = string | undefined;
interface GasTokenChainMock {
  gasTokenAddress: Reply;
  gasTokenNetwork?: Reply;
  weth?: Reply;
}

const GOOD_GAS_TOKEN: GasTokenChainMock = {
  gasTokenAddress: addressWord(GAS_TOKEN),
  gasTokenNetwork: word(BigInt(63)),
  weth: addressWord(WETH)
};

const buildFactory = (
  perChain: Record<string, GasTokenChainMock> = {}
): { factory: ChainClientFactory; calls: string[] } => {
  const calls: string[] = [];
  const factory: ChainClientFactory = (chain) => {
    const mock = perChain[chain.key];
    return {
      public: {
        getChainId: vi.fn(async () => chain.chainId),
        getCode: vi.fn(async () => '0x1234' as const),
        getBalance: vi.fn(async () => parseUnits('1', 18)),
        readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
          if (functionName === 'balanceOf') return parseUnits('1', 18);
          if (functionName === 'allowance') return BigInt(0);
          throw new Error(`unexpected readContract in mock: ${functionName}`);
        }),
        call: vi.fn(async ({ data }: { data?: string }) => {
          calls.push(`${chain.key}:${data}`);
          if (mock === undefined) return { data: ZERO_WORD };
          if (data === GAS_TOKEN_ADDRESS) return { data: mock.gasTokenAddress };
          if (data === GAS_TOKEN_NETWORK) return { data: mock.gasTokenNetwork };
          if (data === WETH_TOKEN) return { data: mock.weth };
          throw new Error(`unexpected call data in mock: ${data}`);
        })
      },
      test: {},
      wallet: () => ({})
    } as unknown as ChainClientSet;
  };
  return { factory, calls };
};

const fetchOk = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/tracker/v1/health')) {
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }
  if (url.includes('/bridge/v1/sync-status')) {
    return new Response(
      JSON.stringify({
        l1_info: { is_synced: true, is_active: true },
        l2_info: { is_synced: true, is_active: true }
      }),
      { status: 200 }
    );
  }
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

const preflight = (
  perChain: Record<string, GasTokenChainMock>,
  mutate?: (config: ReturnType<typeof buildTestDevnetConfig>) => ReturnType<typeof buildTestDevnetConfig>
) => {
  const config = mutate
    ? mutate(buildTestDevnetConfig({ usersTotal: 1 }))
    : buildTestDevnetConfig({ usersTotal: 1 });
  const { factory, calls } = buildFactory(perChain);
  return runPreflight({
    config,
    wallets: deriveWallets(config),
    clientFactory: factory,
    fetchImpl: fetchOk
  }).then((result) => ({ result, calls }));
};

describe('runPreflight — gas-token discovery matrix (S05 SD1 iii / memo §2.3)', () => {
  it('row 1: zero gasTokenAddress() stays ETH mode — no identity, only one eth_call per chain (rings A/B unchanged)', async () => {
    const { result, calls } = await preflight({});

    expect(result.ok).toBe(true);
    expect(result.gasTokenChains).toStrictEqual({});
    expect(result.chains.every((row) => row.gasTokenStatus === 'pass')).toBe(true);
    expect(calls.every((c) => c.endsWith(GAS_TOKEN_ADDRESS))).toBe(true);
    expect(result.table).not.toContain('gas-token chain');
  });

  it('row 2: non-zero gasTokenAddress() with a resolvable WETHToken() switches the chain to gas-token mode and records its identity', async () => {
    const { result } = await preflight({ L2A: GOOD_GAS_TOKEN });

    expect(result.ok).toBe(true);
    expect(result.failures).toStrictEqual([]);
    expect(result.gasTokenChains).toStrictEqual({
      L2A: { chainKey: 'L2A', gasTokenAddress: GAS_TOKEN, gasTokenNetwork: 63, wethToken: WETH }
    });
    // Only L2A is a gas-token chain; the others stay ETH mode.
    expect(Object.keys(result.gasTokenChains)).toStrictEqual(['L2A']);
    expect(result.chains.find((row) => row.chainKey === 'L2A')!.gasTokenStatus).toBe('pass');
    // The identity is logged (the table is what the runner logs).
    expect(result.table).toContain(`gas-token chain "L2A"`);
    expect(result.table).toContain(GAS_TOKEN);
    expect(result.table).toContain(WETH);
    expect(result.table).toContain('originNetwork=63');
  });

  it('row 3: non-zero gas token whose WETHToken() is zero fails GAS_TOKEN_NOT_ETHER and records no identity', async () => {
    const { result } = await preflight({ L2A: { ...GOOD_GAS_TOKEN, weth: ZERO_WORD } });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('GAS_TOKEN_NOT_ETHER');
    expect(result.gasTokenChains).toStrictEqual({});
    expect(result.chains.find((row) => row.chainKey === 'L2A')!.gasTokenStatus).toBe('fail');
  });

  it('row 4: non-zero gas token whose WETHToken() returns no data fails GAS_TOKEN_NOT_ETHER', async () => {
    const { result } = await preflight({ L2A: { ...GOOD_GAS_TOKEN, weth: undefined } });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('GAS_TOKEN_NOT_ETHER');
    expect(result.gasTokenChains).toStrictEqual({});
  });

  it('row 5: gasTokenAddress() returning no data fails GAS_TOKEN_NOT_ETHER (cannot prove the chain is ETH)', async () => {
    const { result } = await preflight({ L2A: { gasTokenAddress: undefined } });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('GAS_TOKEN_NOT_ETHER');
    expect(result.gasTokenChains).toStrictEqual({});
  });

  it('a non-zero gas token whose gasTokenNetwork() returns no data cannot be identified and fails GAS_TOKEN_NOT_ETHER', async () => {
    const { result } = await preflight({ L2A: { ...GOOD_GAS_TOKEN, gasTokenNetwork: undefined } });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('GAS_TOKEN_NOT_ETHER');
    expect(result.gasTokenChains).toStrictEqual({});
  });
});

describe('runPreflight — RING_ETH_START_ON_GAS_TOKEN_CHAIN', () => {
  const ringStartingAt = (first: string) => (config: ReturnType<typeof buildTestDevnetConfig>) =>
    ({
      ...config,
      // A closed ring starting at `first`; only the order matters to preflight.
      ring: [first, ...config.ring.filter((k) => k !== first).slice(0, 2), first]
    }) as ReturnType<typeof buildTestDevnetConfig>;

  it('fires when an eth asset has a gas-token chain as ring[0]', async () => {
    const { result } = await preflight({ L2A: GOOD_GAS_TOKEN }, ringStartingAt('L2A'));

    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.code === 'RING_ETH_START_ON_GAS_TOKEN_CHAIN');
    expect(failure).toBeDefined();
    expect(failure!.message).toContain('L2A');
    expect(result.assets.find((a) => a.kind === 'eth')!.assetStatus).toBe('fail');
    // The erc20 asset is not an eth asset: it is not caught by this rule.
    expect(result.assets.find((a) => a.kind === 'erc20')!.assetStatus).not.toBe('fail');
  });

  it('does not fire when the gas-token chain is not ring[0]', async () => {
    const { result } = await preflight({ L2A: GOOD_GAS_TOKEN });

    expect(result.failures.map((f) => f.code)).not.toContain('RING_ETH_START_ON_GAS_TOKEN_CHAIN');
    expect(result.ok).toBe(true);
  });

  it('does not fire for an ETH-gas ring[0] even when it starts at a non-L1 chain', async () => {
    const { result } = await preflight({}, ringStartingAt('L2A'));

    expect(result.failures.map((f) => f.code)).not.toContain('RING_ETH_START_ON_GAS_TOKEN_CHAIN');
  });
});


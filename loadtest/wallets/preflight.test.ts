// Unit tests for wallets/preflight.ts (DESIGN §4.5). The devnet acceptance
// run (`pnpm loadtest preflight`, and its deliberately-underfunded-wallet
// failure case) is recorded live in the S05 feedback pack; these tests
// cover the pure decision logic against a mocked ChainClientFactory +
// fetch, including the two live-verified [VERIFY@S05] answers (tracker/v1/
// health exists; anvil_setBalance works through haproxy — irrelevant to
// preflight itself, which never calls anvil_setBalance).
import type { Address } from 'viem';

import { encodeFunctionData, parseUnits } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChainClientFactory, ChainClientSet } from './chainClients';

import { derivePumpAccount, deriveWallets } from './derive';
import { runPreflight, SYNC_LAG_ENV } from './preflight';
import { buildTestDevnetConfig, TEST_FUNDER_PRIVATE_KEY, TEST_MNEMONIC } from './testHelpers';

const MNEMONIC_ENV = 'LOADTEST_TEST_MNEMONIC';
const FUNDER_ENV = 'LOADTEST_TEST_FUNDER_KEY';

beforeEach(() => {
  process.env[MNEMONIC_ENV] = TEST_MNEMONIC;
  process.env[FUNDER_ENV] = TEST_FUNDER_PRIVATE_KEY;
});

const ZERO_ADDRESS_PADDED = `0x${'0'.repeat(64)}`;
const WETH_TOKEN_SELECTOR = encodeFunctionData({
  abi: [{ name: 'WETHToken', type: 'function', inputs: [], outputs: [], stateMutability: 'view' }],
  functionName: 'WETHToken'
});
const NON_ZERO_GAS_TOKEN_PADDED = `0x${'0'.repeat(24)}${'ab'.repeat(20)}`;

interface HappyPathOptions {
  chainIdOverride?: Partial<Record<string, number>>;
  bridgeBytecodeMissing?: Set<string>;
  underfundedWallets?: Set<string>; // wallet addresses to leave at zero gas balance
  gasTokenNonZero?: Set<string>;
  /** Overrides every wallet's ERC20 `balanceOf` response (default: `1` token). */
  erc20Balance?: bigint;
}

const buildHappyClientFactory = (
  config: ReturnType<typeof buildTestDevnetConfig>,
  options: HappyPathOptions = {}
): ChainClientFactory => {
  return (chain) => {
    const liveChainId = options.chainIdOverride?.[chain.key] ?? chain.chainId;
    const hasBridgeBytecode = !options.bridgeBytecodeMissing?.has(chain.key);
    const gasTokenIsNonZero = options.gasTokenNonZero?.has(chain.key) ?? false;
    return {
      public: {
        getChainId: vi.fn(async () => liveChainId),
        getCode: vi.fn(async () => (hasBridgeBytecode ? ('0x1234' as const) : ('0x' as const))),
        getBalance: vi.fn(async ({ address }: { address: Address }) =>
          options.underfundedWallets?.has(address) ? BigInt(0) : parseUnits('1', 18)
        ),
        readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
          if (functionName === 'balanceOf') return options.erc20Balance ?? parseUnits('1', 18);
          if (functionName === 'allowance') return BigInt(0);
          throw new Error(`unexpected readContract in mock: ${functionName}`);
        }),
        // `WETHToken()` returns zero even on a gas-token chain, so the gas
        // token cannot be resolved to a WETH and GAS_TOKEN_NOT_ETHER fires.
        call: vi.fn(async ({ data }: { data?: string }) => ({
          data:
            gasTokenIsNonZero && data !== WETH_TOKEN_SELECTOR
              ? NON_ZERO_GAS_TOKEN_PADDED
              : ZERO_ADDRESS_PADDED
        }))
      },
      test: {},
      wallet: () => ({})
    } as unknown as ChainClientSet;
  };
};

const buildHappyFetch = (): typeof fetch =>
  vi.fn(async (input: RequestInfo | URL) => {
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

describe('runPreflight — happy path (DESIGN §4.5)', () => {
  it('passes every check and renders a per-chain table', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config);
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.failures).toStrictEqual([]);
    expect(result.trackerHealthStatus).toBe('pass');
    expect(result.chains.every((row) => row.chainIdStatus === 'pass')).toBe(true);
    expect(result.chains.every((row) => row.bridgeBytecodeStatus === 'pass')).toBe(true);
    expect(result.chains.every((row) => row.syncStatusStatus === 'pass')).toBe(true);
    expect(result.chains.every((row) => row.gasTokenStatus === 'pass')).toBe(true);
    // Table format: a header row naming every column DESIGN §4.5 lists.
    expect(result.table).toContain('CHAIN_ID');
    expect(result.table).toContain('BRIDGE');
    expect(result.table).toContain('SYNC');
    expect(result.table).toContain('GAS');
    expect(result.table).toContain('GAS_TOKEN');
    expect(result.table).toContain('tracker/v1/health: pass');
  });

  it('records ERC20 allowance informationally, without failing preflight', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 2 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config);
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });
    const erc20Asset = result.assets.find((asset) => asset.kind === 'erc20');
    expect(erc20Asset).toBeDefined();
    expect(erc20Asset!.allowanceRecorded).toHaveLength(2);
    expect(erc20Asset!.assetStatus).toBe('pass');
  });
});

describe('runPreflight — failure cases (DESIGN §4.5)', () => {
  it('PREFLIGHT_GAS fails clearly when one wallet is deliberately underfunded', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config, {
      underfundedWallets: new Set([wallets[1].address])
    });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failures[0].code).toBe('PREFLIGHT_GAS');
    expect(result.failures[0].message).toContain(wallets[1].userId);
    const l1Row = result.chains.find((row) => row.chainKey === 'L1')!;
    expect(l1Row.gasStatus).toBe('fail');
  });

  it('PREFLIGHT_CHAIN_ID fails when the live chainId does not match config', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config, { chainIdOverride: { L2A: 999 } });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.code === 'PREFLIGHT_CHAIN_ID')).toBe(true);
  });

  it('PREFLIGHT_BRIDGE_BYTECODE fails when the bridge has no bytecode on a chain', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config, {
      bridgeBytecodeMissing: new Set(['L2B'])
    });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.code === 'PREFLIGHT_BRIDGE_BYTECODE')).toBe(
      true
    );
  });

  it('PREFLIGHT_SYNC_STATUS fails when a network reports not synced', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tracker/v1/health'))
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url.includes('network_id=2')) {
        return new Response(
          JSON.stringify({
            l1_info: { is_synced: true, is_active: true },
            l2_info: { is_synced: false, is_active: false }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          l1_info: { is_synced: true, is_active: true },
          l2_info: { is_synced: true, is_active: true }
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.code === 'PREFLIGHT_SYNC_STATUS')).toBe(true);
  });

  it('PREFLIGHT_TRACKER_HEALTH fails when the health endpoint is unreachable', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tracker/v1/health')) return new Response('down', { status: 503 });
      return new Response(
        JSON.stringify({
          l1_info: { is_synced: true, is_active: true },
          l2_info: { is_synced: true, is_active: true }
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.trackerHealthStatus).toBe('fail');
    expect(result.failures.some((failure) => failure.code === 'PREFLIGHT_TRACKER_HEALTH')).toBe(
      true
    );
  });

  it('GAS_TOKEN_NOT_ETHER fails when a ring chain reports a non-zero gasTokenAddress() but WETHToken() is zero (DESIGN §10)', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config, { gasTokenNonZero: new Set(['L2A']) });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.code === 'GAS_TOKEN_NOT_ETHER')).toBe(true);
    const l2aRow = result.chains.find((row) => row.chainKey === 'L2A')!;
    expect(l2aRow.gasTokenStatus).toBe('fail');
    const l1Row = result.chains.find((row) => row.chainKey === 'L1')!;
    expect(l1Row.gasTokenStatus).toBe('pass');
  });

  // S16/A1 (VALIDATION-1.md A1): the run this fixes funded every user
  // `assetTopUp: "0.04"` = exactly 4 × `amount: "0.01"` — enough for 4 erc20
  // laps — while `load` (`bridgesPerMinutePerUser: 2, durationMinutes: 20`)
  // implies a worst case of `ceil(2 × 20) = 40` laps if every lap picks the
  // erc20 asset. Every existing test above runs at most a handful of laps,
  // so none of them would ever have caught a budget sized for only 4. This
  // is the budget invariant, not a lap-count test: it must fail preflight
  // BEFORE the run starts, printing the required `assetTopUp`.
  it('PREFLIGHT_ASSET fails fast when the ERC20 balance covers only 4 laps but the run can demand 40 (A1 budget invariant)', async () => {
    const config = {
      ...buildTestDevnetConfig({ usersTotal: 3 }),
      load: {
        ...buildTestDevnetConfig({ usersTotal: 3 }).load,
        bridgesPerMinutePerUser: 2,
        durationMinutes: 20
      }
    };
    const wallets = deriveWallets(config);
    // Simulates a wallet funded to `assetTopUp: "0.04"` against
    // `amount: "0.01"` — the exact ratio VALIDATION-1.md A1 measured live.
    const clientFactory = buildHappyClientFactory(config, { erc20Balance: parseUnits('0.04', 18) });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.code === 'PREFLIGHT_ASSET');
    expect(failure).toBeDefined();
    // The error message must print the required assetTopUp (A1's fix #1).
    expect(failure!.message).toContain('0.4');
    expect(failure!.message).toContain('assetTopUp');
    const erc20Asset = result.assets.find((asset) => asset.kind === 'erc20');
    expect(erc20Asset!.assetStatus).toBe('fail');
  });

  it('PREFLIGHT_ASSET passes when the ERC20 balance covers the full worst-case lap budget (A1 boundary)', async () => {
    const config = {
      ...buildTestDevnetConfig({ usersTotal: 3 }),
      load: {
        ...buildTestDevnetConfig({ usersTotal: 3 }).load,
        bridgesPerMinutePerUser: 2,
        durationMinutes: 20
      }
    };
    const wallets = deriveWallets(config);
    // ceil(2 * 20) = 40 laps * amount 0.01 = 0.4 required per user, exactly
    // the balance a `users.funder.assetTopUp: "0.4"` funding pass would
    // leave — this is the boundary (`balance >= target`), so it must pass.
    const clientFactory = buildHappyClientFactory(config, { erc20Balance: parseUnits('0.4', 18) });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });

    expect(result.ok).toBe(true);
    const erc20Asset = result.assets.find((asset) => asset.kind === 'erc20');
    expect(erc20Asset!.assetStatus).toBe('pass');
  });

  it('failures are ordered by DESIGN §4.5 priority (GAS before CHAIN_ID)', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 2 });
    const wallets = deriveWallets(config);
    const clientFactory = buildHappyClientFactory(config, {
      underfundedWallets: new Set([wallets[0].address]),
      chainIdOverride: { L2A: 999 }
    });
    const fetchImpl = buildHappyFetch();

    const result = await runPreflight({ config, wallets, clientFactory, fetchImpl });
    expect(result.failures[0].code).toBe('PREFLIGHT_GAS');
    expect(result.failures.map((failure) => failure.code)).toContain('PREFLIGHT_CHAIN_ID');
  });
});

describe('runPreflight — opt-in sync lag tolerance (LOADTEST_PREFLIGHT_SYNC_LAG_BLOCKS)', () => {
  const saved = process.env[SYNC_LAG_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[SYNC_LAG_ENV];
    else process.env[SYNC_LAG_ENV] = saved;
  });

  const run = async (l1: Record<string, unknown>, lagEnv?: string) => {
    if (lagEnv === undefined) delete process.env[SYNC_LAG_ENV];
    else process.env[SYNC_LAG_ENV] = lagEnv;
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const wallets = deriveWallets(config);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tracker/v1/health'))
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      return new Response(
        JSON.stringify({ l1_info: l1, l2_info: { is_synced: true, is_active: true } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    return runPreflight({
      config,
      wallets,
      clientFactory: buildHappyClientFactory(config),
      fetchImpl
    });
  };
  const trailing = (lag: number, extra: Record<string, unknown> = {}) => ({
    is_synced: false,
    is_active: true,
    last_processed_block: 1000,
    network_block: 1000 + lag,
    ...extra
  });
  const codes = (r: { failures: Array<{ code: string }> }) => r.failures.map((f) => f.code);

  it('unset -> strict: is_synced=false fails as before', async () => {
    const result = await run(trailing(2));
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('PREFLIGHT_SYNC_STATUS');
    expect(result.syncToleranceNotes).toStrictEqual([]);
  });

  it('lag within N passes and prints the tolerance line', async () => {
    const result = await run(trailing(12), '20');
    expect(result.ok).toBe(true);
    expect(result.syncToleranceNotes.length).toBeGreaterThan(0);
    expect(result.syncToleranceNotes[0]).toContain('l1 trails by 12 blocks (<= 20) — proceeding');
    expect(result.table).toContain('sync tolerance: chain');
  });

  it('lag equal to N passes, lag above N fails', async () => {
    expect((await run(trailing(20), '20')).ok).toBe(true);
    const over = await run(trailing(21), '20');
    expect(over.ok).toBe(false);
    expect(codes(over)).toContain('PREFLIGHT_SYNC_STATUS');
  });

  it('missing block fields fail even with N set', async () => {
    const result = await run({ is_synced: false, is_active: true }, '20');
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('PREFLIGHT_SYNC_STATUS');
  });

  it('is_active=false fails even within N', async () => {
    const result = await run(trailing(1, { is_active: false }), '20');
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('PREFLIGHT_SYNC_STATUS');
  });

  it.each(['abc', '-3', '1.5'])(
    'invalid value %s fails with PREFLIGHT_SYNC_LAG_INVALID',
    async (bad) => {
      const result = await run({ is_synced: true, is_active: true }, bad);
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain('PREFLIGHT_SYNC_LAG_INVALID');
    }
  );
});

// S53 (heavy-load design §1.3): pump checks only exist when `pump.enabled`.
describe('runPreflight — L1 deposit pump wallet (S53)', () => {
  const PUMP_INDEX = 999;
  const withPump = (over: Record<string, unknown> = {}) => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    return {
      ...config,
      pump: {
        enabled: true,
        chainKey: 'L1',
        destinationNetworkId: 1,
        walletIndex: PUMP_INDEX,
        amount: '0',
        intervalSeconds: 600,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 5,
        ...over
      }
    };
  };
  const pumpAddress = (config: ReturnType<typeof withPump>) =>
    derivePumpAccount(config as never).address;

  // The shared mock funds every wallet with 1 ETH; override the pump wallet only.
  const factoryWithPumpBalance = (config: ReturnType<typeof withPump>, balance: bigint) => {
    const base = buildHappyClientFactory(config as never);
    const pump = pumpAddress(config);
    const seen: string[] = [];
    const factory: ChainClientFactory = (chain) => {
      const set = base(chain);
      const getBalance = set.public.getBalance as unknown as (a: {
        address: Address;
      }) => Promise<bigint>;
      return {
        ...set,
        public: {
          ...set.public,
          getBalance: vi.fn(async (args: { address: Address }) => {
            if (args.address === pump) {
              seen.push(chain.key);
              return balance;
            }
            return getBalance(args);
          })
        }
      } as unknown as ChainClientSet;
    };
    return { factory, seen };
  };

  it('passes when the pump wallet holds at least maxTotalSpend, reads it on the pump chain, and says so in the table', async () => {
    const config = withPump();
    const { factory, seen } = factoryWithPumpBalance(config, parseUnits('0.07', 18));
    const result = await runPreflight({
      config: config as never,
      wallets: deriveWallets(config as never),
      clientFactory: factory,
      fetchImpl: buildHappyFetch()
    });
    expect(result.ok).toBe(true);
    expect(result.pumpStatus).toBe('pass');
    expect(result.table).toContain('pump wallet: pass');
    expect(seen).toStrictEqual(['L1']);
  });

  it('PUMP_UNDERFUNDED when the balance is a wei short of maxTotalSpend, naming the wallet and the shortfall', async () => {
    const config = withPump();
    const { factory } = factoryWithPumpBalance(config, parseUnits('0.07', 18) - BigInt(1));
    const result = await runPreflight({
      config: config as never,
      wallets: deriveWallets(config as never),
      clientFactory: factory,
      fetchImpl: buildHappyFetch()
    });
    expect(result.ok).toBe(false);
    expect(result.pumpStatus).toBe('fail');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].code).toBe('PUMP_UNDERFUNDED');
    expect(result.failures[0].message).toContain(pumpAddress(config));
    expect(result.failures[0].message).toContain('0.07');
    expect(result.table).toContain('pump wallet: fail');
  });

  it('a chain id mismatch on the pump chain still fails through the existing per-chain check', async () => {
    const config = withPump();
    const { factory } = factoryWithPumpBalance(config, parseUnits('1', 18));
    const mismatched: ChainClientFactory = (chain) => {
      const set = factory(chain);
      return chain.key === 'L1'
        ? ({ ...set, public: { ...set.public, getChainId: vi.fn(async () => 999) } } as never)
        : set;
    };
    const result = await runPreflight({
      config: config as never,
      wallets: deriveWallets(config as never),
      clientFactory: mismatched,
      fetchImpl: buildHappyFetch()
    });
    expect(result.failures.map((f) => f.code)).toContain('PREFLIGHT_CHAIN_ID');
  });

  it('a disabled pump block, and no pump block, add nothing: no pumpStatus, no table line, no balance read of the pump wallet', async () => {
    const disabled = withPump({ enabled: false });
    const none = buildTestDevnetConfig({ usersTotal: 3 });
    for (const config of [disabled, none]) {
      const result = await runPreflight({
        config: config as never,
        wallets: deriveWallets(config as never),
        clientFactory: buildHappyClientFactory(config as never),
        fetchImpl: buildHappyFetch()
      });
      expect(result.ok).toBe(true);
      expect('pumpStatus' in result).toBe(false);
      expect(result.table).not.toContain('pump wallet');
    }
  });

  it('an unresolvable mnemonic is a PREFLIGHT_PUMP_WALLET failure, not an exception', async () => {
    const config = withPump();
    delete process.env[MNEMONIC_ENV];
    const factory = buildHappyClientFactory(config as never);
    const wallets = (() => {
      process.env[MNEMONIC_ENV] = TEST_MNEMONIC;
      const w = deriveWallets(config as never);
      delete process.env[MNEMONIC_ENV];
      return w;
    })();
    const result = await runPreflight({
      config: config as never,
      wallets,
      clientFactory: factory,
      fetchImpl: buildHappyFetch()
    });
    process.env[MNEMONIC_ENV] = TEST_MNEMONIC;
    expect(result.failures.map((f) => f.code)).toContain('PREFLIGHT_PUMP_WALLET');
  });
});

// Unit tests for wallets/preflight.ts (DESIGN §4.5). The devnet acceptance
// run (`pnpm loadtest preflight`, and its deliberately-underfunded-wallet
// failure case) is recorded live in the S05 feedback pack; these tests
// cover the pure decision logic against a mocked ChainClientFactory +
// fetch, including the two live-verified [VERIFY@S05] answers (tracker/v1/
// health exists; anvil_setBalance works through haproxy — irrelevant to
// preflight itself, which never calls anvil_setBalance).
import type { Address } from 'viem';

import { parseUnits } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChainClientFactory, ChainClientSet } from './chainClients';

import { deriveWallets } from './derive';
import { runPreflight } from './preflight';
import { buildTestDevnetConfig, TEST_FUNDER_PRIVATE_KEY, TEST_MNEMONIC } from './testHelpers';

const MNEMONIC_ENV = 'LOADTEST_TEST_MNEMONIC';
const FUNDER_ENV = 'LOADTEST_TEST_FUNDER_KEY';

beforeEach(() => {
  process.env[MNEMONIC_ENV] = TEST_MNEMONIC;
  process.env[FUNDER_ENV] = TEST_FUNDER_PRIVATE_KEY;
});

const ZERO_ADDRESS_PADDED = `0x${'0'.repeat(64)}`;
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
        call: vi.fn(async () => ({
          data: gasTokenIsNonZero ? NON_ZERO_GAS_TOKEN_PADDED : ZERO_ADDRESS_PADDED
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

  it('GAS_TOKEN_NOT_ETHER fails when a ring chain reports a non-zero gasTokenAddress() (DESIGN §10)', async () => {
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

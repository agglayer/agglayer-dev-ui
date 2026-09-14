// Unit tests for wallets/fund.ts (DESIGN §4.2/§4.3). The devnet AND
// testnet/mainnet paths are exercised entirely against a MOCKED
// `ChainClientFactory` — no network I/O — so these tests run in CI without
// a live devnet. The live-devnet acceptance run (`pnpm loadtest fund
// --users 20`) is a separate, manual verification recorded in the S05
// feedback pack, not reproduced here.
import type { Address } from 'viem';

import { parseUnits } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChainClientFactory, ChainClientSet } from './chainClients';

import { decimalTimesFour, defaultAssetTopUp, FundingError, fundWallets } from './fund';
import { buildTestDevnetConfig, TEST_FUNDER_PRIVATE_KEY, TEST_MNEMONIC } from './testHelpers';

const MNEMONIC_ENV = 'LOADTEST_TEST_MNEMONIC';
const FUNDER_ENV = 'LOADTEST_TEST_FUNDER_KEY';

beforeEach(() => {
  process.env[MNEMONIC_ENV] = TEST_MNEMONIC;
  process.env[FUNDER_ENV] = TEST_FUNDER_PRIVATE_KEY;
});

// ---------------------------------------------------------------------------
// A minimal mocked viem client set per chain: enough surface for fund.ts's
// calls (getBalance, getTransactionCount, getCode, readContract,
// setBalance, sendTransaction, writeContract) and nothing more.
// ---------------------------------------------------------------------------

interface MockChainState {
  nativeBalances: Map<string, bigint>;
  erc20Balances: Map<string, bigint>;
  nonce: number;
  setBalanceCalls: Array<{ address: string; value: bigint }>;
  sendTransactionCalls: Array<{ to: string; value: bigint; nonce: number }>;
  writeContractCalls: Array<{ functionName: string; args: unknown[]; nonce: number }>;
  failNextSend?: boolean;
}

const buildMockChainState = (): MockChainState => ({
  nativeBalances: new Map(),
  erc20Balances: new Map(),
  nonce: 0,
  setBalanceCalls: [],
  sendTransactionCalls: [],
  writeContractCalls: []
});

const buildMockClientFactory = (states: Map<string, MockChainState>): ChainClientFactory => {
  return (chain) => {
    const state = states.get(chain.key)!;

    const publicClient = {
      getBalance: vi.fn(
        async ({ address }: { address: Address }) => state.nativeBalances.get(address) ?? BigInt(0)
      ),
      getTransactionCount: vi.fn(async () => state.nonce),
      getCode: vi.fn(async () => '0x1234' as const),
      readContract: vi.fn(
        async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
          if (functionName === 'balanceOf') {
            const [owner] = args as [Address];
            return state.erc20Balances.get(owner) ?? BigInt(0);
          }
          if (functionName === 'allowance') return BigInt(0);
          throw new Error(`unexpected readContract functionName in mock: ${functionName}`);
        }
      ),
      // fund.ts awaits this on the last submitted send of every funding
      // loop before returning (found live in S22's validation ladder: a
      // caller reading balances right after `fundWallets` resolved could
      // race an unmined transfer) — the mock only needs to resolve.
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' }) as const)
    };

    const testClient = {
      setBalance: vi.fn(async ({ address, value }: { address: Address; value: bigint }) => {
        state.setBalanceCalls.push({ address, value });
        state.nativeBalances.set(address, value);
      })
    };

    return {
      public: publicClient,
      test: testClient,
      wallet: () => ({
        sendTransaction: vi.fn(
          async ({ to, value, nonce }: { to: Address; value: bigint; nonce: number }) => {
            if (state.failNextSend) {
              state.failNextSend = false;
              throw new Error(`simulated RPC failure sending to ${to}`);
            }
            state.sendTransactionCalls.push({ to, value, nonce });
            return '0xhash';
          }
        ),
        writeContract: vi.fn(
          async ({
            functionName,
            args,
            nonce
          }: {
            functionName: string;
            args: unknown[];
            nonce: number;
          }) => {
            if (state.failNextSend) {
              state.failNextSend = false;
              throw new Error('simulated RPC failure writing contract');
            }
            state.writeContractCalls.push({ functionName, args, nonce });
            if (functionName === 'transfer') {
              const [to, amount] = args as [Address, bigint];
              state.erc20Balances.set(to, (state.erc20Balances.get(to) ?? BigInt(0)) + amount);
            }
            return '0xhash';
          }
        )
      })
    } as unknown as ChainClientSet;
  };
};

describe('decimalTimesFour', () => {
  it.each([
    ['0.001', '0.004'],
    ['0.01', '0.04'],
    ['10', '40'],
    ['2.5', '10.0']
  ])('%s * 4 == %s', (input, expected) => {
    expect(decimalTimesFour(input)).toBe(expected);
  });
});

// S16/A1 (VALIDATION-1.md): replaces the old flat "amount x 4" default,
// which sized every user for exactly 4 erc20 bridges regardless of run
// length (336 underflow reverts from the 5th erc20 lap onward).
describe('defaultAssetTopUp (S16/A1 duration-derived default)', () => {
  it('sizes the default for the worst case (every lap picks this asset) plus an in-flight-lap margin', () => {
    // ceil(2 * 20) = 40 laps + maxInflightLapsPerUser 3 = 43 * 0.01 = 0.43
    expect(
      defaultAssetTopUp('0.01', {
        bridgesPerMinutePerUser: 2,
        durationMinutes: 20,
        maxInflightLapsPerUser: 3
      })
    ).toBe('0.43');
  });

  it('rounds a fractional worst-case lap count up, never down', () => {
    // ceil(1.5 * 3) = ceil(4.5) = 5 laps + margin 1 = 6 * 0.01 = 0.06
    expect(
      defaultAssetTopUp('0.01', {
        bridgesPerMinutePerUser: 1.5,
        durationMinutes: 3,
        maxInflightLapsPerUser: 1
      })
    ).toBe('0.06');
  });
});

describe('fundWallets — devnet anvil_setBalance path (DESIGN §4.2)', () => {
  it('funds every wallet to gasPerChain on every ring chain via anvil_setBalance', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);

    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    // The ERC20 usability pre-check (DESIGN §4.2) reads the funder's
    // balance of the configured token — seed it so this test exercises the
    // "usable" branch instead of tripping the real dockerized-forge
    // fallback deploy path against a live devnet.
    states
      .get('L1')!
      .erc20Balances.set(deriveFunderAccount(config).address, BigInt('1000000000000000000000'));

    const result = await fundWallets({ config, wallets, clientFactory });

    expect(result.strategy).toBe('anvil_setBalance');
    for (const chainKey of ['L1', 'L2A', 'L2B']) {
      const state = states.get(chainKey)!;
      const target = parseUnits(config.users.funder!.gasPerChain[chainKey], 18);
      expect(state.setBalanceCalls).toHaveLength(3);
      for (const wallet of wallets) {
        expect(state.nativeBalances.get(wallet.address)).toBe(target);
      }
    }
  });

  it('never lowers an already-funded wallet (setBalance SETS, not adds)', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 2 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    states
      .get('L1')!
      .erc20Balances.set(deriveFunderAccount(config).address, BigInt('1000000000000000000000'));

    // Pre-fund wallet 0 on L1 far above target.
    const l1State = states.get('L1')!;
    const hugeBalance = BigInt('999999999999999999999');
    l1State.nativeBalances.set(wallets[0].address, hugeBalance);

    await fundWallets({ config, wallets, clientFactory });

    // setBalance must never have been called for the already-funded wallet.
    expect(l1State.setBalanceCalls.some((call) => call.address === wallets[0].address)).toBe(false);
    expect(l1State.nativeBalances.get(wallets[0].address)).toBe(hugeBalance);
    // The other wallet, starting at 0, must have been funded.
    expect(l1State.setBalanceCalls.some((call) => call.address === wallets[1].address)).toBe(true);
  });

  it('transfers the ERC20 top-up from the funder with sequential nonces', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    const funder = deriveFunderAccount(config);

    const l1State = states.get('L1')!;
    l1State.erc20Balances.set(funder.address, BigInt('1000000000000000000000')); // funder holds supply
    l1State.nonce = 7;

    await fundWallets({ config, wallets, clientFactory });

    const transfers = l1State.writeContractCalls.filter((call) => call.functionName === 'transfer');
    expect(transfers).toHaveLength(3);
    expect(transfers.map((call) => call.nonce)).toStrictEqual([7, 8, 9]);
    for (const wallet of wallets) {
      expect(l1State.erc20Balances.get(wallet.address)).toBeGreaterThan(BigInt(0));
    }
  });

  it('skips a wallet already at or above the ERC20 top-up target', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 2 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    const funder = deriveFunderAccount(config);

    const l1State = states.get('L1')!;
    l1State.erc20Balances.set(funder.address, BigInt('1000000000000000000000'));
    // Pre-fund wallet 0 with far more than the top-up target.
    l1State.erc20Balances.set(wallets[0].address, BigInt('1000000000000000000000'));

    await fundWallets({ config, wallets, clientFactory });

    const transfersToWallet0 = l1State.writeContractCalls.filter(
      (call) => call.functionName === 'transfer' && (call.args[0] as string) === wallets[0].address
    );
    expect(transfersToWallet0).toHaveLength(0);
  });

  it('completes 20 users well under 60s against the mocked (zero-latency) client', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 20 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    const funder = deriveFunderAccount(config);
    states.get('L1')!.erc20Balances.set(funder.address, BigInt('1000000000000000000000'));

    const result = await fundWallets({ config, wallets, clientFactory });
    expect(result.durationMs).toBeLessThan(60_000);
  });
});

describe('fundWallets — no private key ever logged', () => {
  it('logger never receives the funder private key or mnemonic', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 2 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    const funder = deriveFunderAccount(config);
    states.get('L1')!.erc20Balances.set(funder.address, BigInt('1000000000000000000000'));

    const logged: string[] = [];
    await fundWallets({
      config,
      wallets,
      clientFactory,
      logger: (message) => logged.push(message)
    });

    for (const message of logged) {
      expect(message).not.toContain(TEST_FUNDER_PRIVATE_KEY);
      expect(message).not.toContain(TEST_MNEMONIC);
    }
  });

  it('a thrown FundingError never contains the raw private key, even when the underlying viem error does', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 1 });
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory: ChainClientFactory = (chain) => {
      const base = buildMockClientFactory(states)(chain);
      if (chain.key !== 'L1') return base;
      return {
        ...base,
        wallet: () => ({
          ...base.wallet({} as never),
          writeContract: vi.fn(async () => {
            throw new Error(`node rejected signed raw tx from ${TEST_FUNDER_PRIVATE_KEY}`);
          })
        })
      } as unknown as ChainClientSet;
    };
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    const funder = deriveFunderAccount(config);
    states.get('L1')!.erc20Balances.set(funder.address, BigInt('1000000000000000000000'));

    let caught: unknown;
    try {
      await fundWallets({ config, wallets, clientFactory });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FundingError);
    expect((caught as Error).message).not.toContain(TEST_FUNDER_PRIVATE_KEY);
  });
});

describe('fundWallets — testnet/mainnet transfer path (DESIGN §4.3)', () => {
  const buildTransferConfig = (usersTotal: number) => {
    const config = buildTestDevnetConfig({ usersTotal });
    return {
      ...config,
      env: 'testnet' as const,
      users: { ...config.users, devnetFunding: undefined }
    };
  };

  it('enforces the spend cap: refuses the whole fund, sending nothing, when planned outlay exceeds maxTotalSpend', async () => {
    const config = buildTransferConfig(5);
    const capped = {
      ...config,
      users: {
        ...config.users,
        funder: {
          ...config.users.funder!,
          maxTotalSpend: { ...config.users.funder!.maxTotalSpend, L1: '0.01' } // far below 5 * 0.05
        }
      }
    };
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets } = await import('./derive');
    const wallets = deriveWallets(capped);

    await expect(fundWallets({ config: capped, wallets, clientFactory })).rejects.toThrow(
      /FUNDING_CAP_EXCEEDED/
    );

    for (const chainKey of ['L1', 'L2A', 'L2B']) {
      expect(states.get(chainKey)!.sendTransactionCalls).toHaveLength(0);
    }
  });

  it('does NOT refuse when planned outlay equals maxTotalSpend exactly (boundary: the guard is `>`, not `>=`)', async () => {
    const config = buildTransferConfig(5);
    // 5 users x gasPerChain.L1 "0.05" = exactly "0.25" planned outlay.
    const exact = {
      ...config,
      users: {
        ...config.users,
        funder: {
          ...config.users.funder!,
          maxTotalSpend: { ...config.users.funder!.maxTotalSpend, L1: '0.25' }
        }
      }
    };
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets } = await import('./derive');
    const wallets = deriveWallets(exact);

    await expect(fundWallets({ config: exact, wallets, clientFactory })).resolves.not.toThrow();
    expect(states.get('L1')!.sendTransactionCalls).toHaveLength(5);
    expect(
      states.get('L1')!.sendTransactionCalls.reduce((sum, call) => sum + call.value, BigInt(0))
    ).toBe(parseUnits('0.25', 18));
  });

  it('sends native gas top-ups with sequential nonces per chain', async () => {
    const config = buildTransferConfig(3);
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    states.get('L1')!.nonce = 3;
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets } = await import('./derive');
    const wallets = deriveWallets(config);

    const result = await fundWallets({ config, wallets, clientFactory });

    expect(result.strategy).toBe('transfer');
    const l1Sends = states.get('L1')!.sendTransactionCalls;
    expect(l1Sends).toHaveLength(3);
    expect(l1Sends.map((call) => call.nonce)).toStrictEqual([3, 4, 5]);
  });

  it('skips a wallet already funded at or above target (skip-if-funded)', async () => {
    const config = buildTransferConfig(2);
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets } = await import('./derive');
    const wallets = deriveWallets(config);
    states.get('L1')!.nativeBalances.set(wallets[0].address, BigInt('999999999999999999'));

    await fundWallets({ config, wallets, clientFactory });

    const l1Sends = states.get('L1')!.sendTransactionCalls;
    expect(l1Sends.some((call) => call.to === wallets[0].address)).toBe(false);
    expect(l1Sends.some((call) => call.to === wallets[1].address)).toBe(true);
  });

  it('mainnet refuses without --i-know-this-is-mainnet', async () => {
    const config = { ...buildTransferConfig(1), env: 'mainnet' as const };
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets } = await import('./derive');
    const wallets = deriveWallets(config);

    await expect(fundWallets({ config, wallets, clientFactory })).rejects.toThrow(
      /MAINNET_CONFIRMATION_REQUIRED/
    );
  });

  it('mainnet proceeds when mainnetConfirmed is true', async () => {
    const config = { ...buildTransferConfig(1), env: 'mainnet' as const };
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets } = await import('./derive');
    const wallets = deriveWallets(config);

    const result = await fundWallets({ config, wallets, clientFactory, mainnetConfirmed: true });
    expect(result.env).toBe('mainnet');
  });

  // R19 (loadtest/REVIEW.md, added S21): `maxTotalSpend` capped native
  // currency only — the erc20 top-up loop on this path had NO cap at all.
  describe('R19: erc20 top-ups are capped by maxTotalErc20Spend', () => {
    it('refuses the whole erc20 fund, sending nothing, when planned outlay exceeds the cap', async () => {
      const config = buildTransferConfig(5);
      const capped = {
        ...config,
        users: {
          ...config.users,
          funder: {
            ...config.users.funder!,
            assetTopUp: '10', // 5 users x 10 = 50 planned
            maxTotalErc20Spend: '1' // far below
          }
        }
      };
      const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
      const clientFactory = buildMockClientFactory(states);
      const { deriveWallets, deriveFunderAccount } = await import('./derive');
      const wallets = deriveWallets(capped);
      const funder = deriveFunderAccount(capped);
      const ringStartState = states.get(capped.ring[0])!;
      ringStartState.erc20Balances.set(funder.address, BigInt('1000000000000000000000'));

      await expect(fundWallets({ config: capped, wallets, clientFactory })).rejects.toThrow(
        /FUNDING_CAP_EXCEEDED/
      );
      expect(
        ringStartState.writeContractCalls.filter((call) => call.functionName === 'transfer')
      ).toHaveLength(0);
    });

    it('sends when the planned outlay is within maxTotalErc20Spend', async () => {
      const config = buildTransferConfig(3);
      const capped = {
        ...config,
        users: {
          ...config.users,
          funder: {
            ...config.users.funder!,
            assetTopUp: '10', // 3 users x 10 = 30 planned
            maxTotalErc20Spend: '1000'
          }
        }
      };
      const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
      const clientFactory = buildMockClientFactory(states);
      const { deriveWallets, deriveFunderAccount } = await import('./derive');
      const wallets = deriveWallets(capped);
      const funder = deriveFunderAccount(capped);
      const ringStartState = states.get(capped.ring[0])!;
      ringStartState.erc20Balances.set(funder.address, BigInt('1000000000000000000000'));

      await expect(fundWallets({ config: capped, wallets, clientFactory })).resolves.not.toThrow();
      expect(
        ringStartState.writeContractCalls.filter((call) => call.functionName === 'transfer')
      ).toHaveLength(3);
    });
  });

  // R19: on devnet's anvil_setBalance path (no real-funds risk), the schema
  // does not require maxTotalErc20Spend and the erc20 mint stays uncapped
  // by design — asserted here so a future change doesn't silently start
  // requiring it there too.
  it('R19: the devnet anvil_setBalance path stays uncapped (maxTotalErc20Spend not required)', async () => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    expect(config.users.funder?.maxTotalErc20Spend).toBeUndefined();
    const states = new Map(config.chains.map((chain) => [chain.key, buildMockChainState()]));
    const clientFactory = buildMockClientFactory(states);
    const { deriveWallets, deriveFunderAccount } = await import('./derive');
    const wallets = deriveWallets(config);
    states
      .get(config.ring[0])!
      .erc20Balances.set(deriveFunderAccount(config).address, BigInt('1000000000000000000000'));

    await expect(fundWallets({ config, wallets, clientFactory })).resolves.not.toThrow();
  });
});

// S08: offline end-to-end test of the tool's ROUTE HANDLING for a 3-hop ring.
//
// What is real: `runLoadTest` (scheduler, ring engine/state machine, collector,
// report writer), the REAL `runPreflight` (including gas-token auto-discovery
// from `gasTokenAddress()`/`WETHToken()`), `buildHopSpecs`, and the REAL
// `HeadlessUser.bridge()` (WETH-burn vs native, `msg.value`, BridgeEvent decode
// and the leaf-identity check `ASSET_IDENTITY_MISMATCH`).
//
// What is faked (all in-process, no network, no secrets, no VPN, no Kurtosis):
//   * viem chain clients + SDK handle behind `HeadlessUser.bridge()` — a tiny
//     "bridge contract" model that derives the leaf origin the way the real
//     contract does (token 0x0 on an ETH-gas chain = ETH (0, 0x0); token 0x0 on a
//     gas-token chain = the gas token; token = WETH = ETH (0, 0x0));
//   * `HeadlessUser.observeActivity()` / `.claim()` — replaced by a model of the
//     aggkit tracker + autoclaim service whose per-route policy the test sets:
//     'auto' (the service claims the deposit shortly after it is ready),
//     'instant' (it claims in the same step the row becomes ready) or
//     'never' (it never claims; only a manual claim does).
//
// The five behaviours demonstrated, for an ETH-gas ring and a gas-token ring:
//   1. all three hops reach a completed outcome;
//   2. autoclaim hops (expected: true) resolve as `hop_completed_auto`;
//   3. the L2->L1 hop (expected: false) resolves via manual claim;
//   4. expected-true hop that is never auto-claimed -> `autoclaimOverdue`
//      (+ `hop_completed_escalated` after the manual claim);
//   5. expected-false hop that IS auto-claimed -> `unexpectedAutoclaim`
//      (+ `hop_completed_auto`).
import type { Address, Hex } from 'viem';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbiItem } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadtestConfig } from './config/schema';
import type { ObservedRow } from './core/types';
import type { ClaimSubmission } from './core/userDriver';
import type { ChainClientFactory, ChainClientSet } from './wallets/chainClients';
import type * as headlessModule from './workers/headless/headlessUser';

import { parseLoadtestConfig } from './config/schema';
import { runLoadTest } from './runner';
import {
  buildTestDevnetConfig,
  TEST_FUNDER_PRIVATE_KEY,
  TEST_MNEMONIC
} from './wallets/testHelpers';

// ---------------------------------------------------------------------------
// Constants and the in-memory "world"
// ---------------------------------------------------------------------------

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const WETH: Address = '0x77290275947f166793b8d10428670e1fca26960a';
const GAS_TOKEN: Address = '0x0000003f0000003f0000003f0000003f0000003f';
const GAS_TOKEN_NETWORK = 63;

// Model timings (ms): PENDING -> READY after READY_MS; an 'auto' route is
// claimed by the service AUTO_MS later. The config's autoclaim waitMs
// (WAIT_MS) is comfortably above READY_MS + AUTO_MS, so an auto-claim always
// beats the grace window, and a 'never' route always blows through it.
const READY_MS = 60;
const AUTO_MS = 60;
const WAIT_MS = 500;

const BRIDGE_EVENT = parseAbiItem(
  'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)'
);

type Policy = 'auto' | 'instant' | 'never';

interface ChainInfo {
  key: string;
  networkId: number;
  bridgeAddress: string;
  gasToken: { address: Address; network: number } | null;
}

interface Build {
  fromChain: ChainInfo;
  token: Address;
  destinationNetwork: number;
  amount: string;
}

interface Deposit {
  rowKey: string;
  route: string;
  fromChain: string;
  toChain: string;
  txHash: Hex;
  depositCount: number;
  sourceNetwork: number;
  destinationNetwork: number;
  createdAt: number;
  claimedBy: 'auto' | 'manual' | null;
  leaf: { originNetwork: number; originAddress: Address };
}

interface SendRecord {
  route: string;
  token: Address;
  value: bigint;
}

interface ManualClaim {
  route: string;
  arrivesAs: 'WETH' | 'native ETH';
}

interface World {
  chains: ChainInfo[];
  policyByRoute: Record<string, Policy>;
  deposits: Deposit[];
  sends: SendRecord[];
  manualClaims: ManualClaim[];
  builds: Map<string, Build>;
  receipts: Map<string, { status: 'success'; logs: unknown[] }>;
  depositCounters: Map<string, number>;
  seq: number;
}

const newWorld = (chains: ChainInfo[], policyByRoute: Record<string, Policy>): World => ({
  chains,
  policyByRoute,
  deposits: [],
  sends: [],
  manualClaims: [],
  builds: new Map(),
  receipts: new Map(),
  depositCounters: new Map(),
  seq: 0
});

const mocks = vi.hoisted(() => ({
  world: null as unknown,
  chainClientFactory: null as unknown,
  fetchImpl: null as unknown
}));

const getWorld = (): World => mocks.world as World;

// -- bridge contract model -------------------------------------------------

const leafOrigin = (
  chain: ChainInfo,
  token: Address
): { originNetwork: number; originAddress: Address } => {
  if (token.toLowerCase() === ZERO) {
    // token 0x0 = the chain's native currency: ETH on an ETH-gas chain, the
    // custom gas token on a gas-token chain.
    return chain.gasToken
      ? { originNetwork: chain.gasToken.network, originAddress: chain.gasToken.address }
      : { originNetwork: 0, originAddress: ZERO };
  }
  // Burning the bridge's own WETH leaves a leaf whose origin is ETH.
  if (token.toLowerCase() === WETH) return { originNetwork: 0, originAddress: ZERO };
  throw new Error(`world: unmodelled token ${token}`);
};

const bridgeEventLog = (
  bridgeAddress: string,
  leaf: { originNetwork: number; originAddress: Address },
  destinationNetwork: number,
  amount: bigint,
  depositCount: number
) => ({
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
    [
      0,
      leaf.originNetwork,
      leaf.originAddress,
      destinationNetwork,
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amount,
      '0x',
      depositCount
    ]
  )
});

const hex32 = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

const worldSend = (chainKey: string, to: string, data: string, value: bigint | undefined): Hex => {
  const world = getWorld();
  const build = world.builds.get(data);
  if (build === undefined || build.fromChain.key !== chainKey) {
    throw new Error(`world: unknown tx data ${data} on ${chainKey}`);
  }
  const dest = world.chains.find((c) => c.networkId === build.destinationNetwork);
  if (dest === undefined) throw new Error('world: unknown destination network');

  const route = `${build.fromChain.key}->${dest.key}`;
  const amountWei = BigInt(build.amount);
  const leaf = leafOrigin(build.fromChain, build.token);
  world.sends.push({ route, token: build.token, value: value ?? BigInt(0) });

  const depositCount = world.depositCounters.get(chainKey) ?? 0;
  world.depositCounters.set(chainKey, depositCount + 1);
  world.seq += 1;
  const txHash = hex32(world.seq);
  world.deposits.push({
    rowKey: `${txHash}:${depositCount}`,
    route,
    fromChain: build.fromChain.key,
    toChain: dest.key,
    txHash,
    depositCount,
    sourceNetwork: build.fromChain.networkId,
    destinationNetwork: dest.networkId,
    createdAt: Date.now(),
    claimedBy: null,
    leaf
  });
  world.receipts.set(txHash, {
    status: 'success',
    logs: [bridgeEventLog(to, leaf, dest.networkId, amountWei, depositCount)]
  });
  return txHash;
};

// -- tracker + autoclaim-service model ---------------------------------------

const rowStatus = (d: Deposit, now: number): ObservedRow['status'] => {
  const elapsed = now - d.createdAt;
  if (elapsed < READY_MS) return 'PENDING';
  if (d.claimedBy !== null) return 'CLAIMED';
  const policy = getWorld().policyByRoute[d.route];
  // 'instant': the service claims in the same indexing step the row becomes
  // ready, so the tool's first sight of it is already CLAIMED.
  if (policy === 'instant' || (policy === 'auto' && elapsed >= READY_MS + AUTO_MS)) {
    d.claimedBy = 'auto';
    return 'CLAIMED';
  }
  return 'READY_TO_CLAIM';
};

const arrivesAs = (dest: ChainInfo | undefined): 'WETH' | 'native ETH' =>
  dest?.gasToken ? 'WETH' : 'native ETH';

const toRow = (d: Deposit, now: number): ObservedRow => ({
  rowKey: d.rowKey,
  status: rowStatus(d, now),
  transactionHash: d.txHash,
  depositCount: d.depositCount,
  sourceNetwork: d.sourceNetwork,
  destinationNetwork: d.destinationNetwork,
  globalIndex: '1'
});

// -- install fakes behind the REAL HeadlessUser ---------------------------------

const installFakes = (user: Record<string, unknown>, chainKeys: string[]): void => {
  const world = getWorld();
  const byBridge = (address: string) =>
    world.chains.find((c) => c.bridgeAddress.toLowerCase() === address.toLowerCase());
  let buildSeq = 0;

  user.native = {
    getNativeBalance: async () => '1',
    erc20: () => ({ getBalance: async () => '1' }),
    bridge: (bridgeAddress: string) => ({
      isClaimed: async () => false,
      buildBridgeAsset: async (params: {
        destinationNetwork: number;
        amount: string;
        token: Address;
      }) => {
        const fromChain = byBridge(bridgeAddress);
        if (fromChain === undefined) throw new Error(`world: unknown bridge ${bridgeAddress}`);
        buildSeq += 1;
        const data = `0x${buildSeq.toString(16).padStart(8, '0')}`;
        world.builds.set(data, {
          fromChain,
          token: params.token,
          destinationNetwork: params.destinationNetwork,
          amount: params.amount
        });
        // Mirrors the pinned SDK: value = amount iff token == 0x0.
        return {
          to: bridgeAddress,
          data,
          value: params.token.toLowerCase() === ZERO ? params.amount : undefined
        };
      }
    })
  };

  user.runtimes = new Map(
    chainKeys.map((key) => [
      key,
      {
        chain: { key },
        public: {
          getGasPrice: async () => BigInt(1),
          waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
            const receipt = world.receipts.get(hash);
            if (receipt === undefined) throw new Error(`world: no receipt for ${hash}`);
            return receipt;
          }
        },
        wallet: {
          sendTransaction: async (tx: { to: string; data: string; value?: bigint }) =>
            worldSend(key, tx.to, tx.data, tx.value)
        }
      }
    ])
  );
};

vi.mock('./workers/headless/headlessUser', async (importOriginal) => {
  const actual = await importOriginal<typeof headlessModule>();
  class ScriptedHeadlessUser extends actual.HeadlessUser {
    async init(): Promise<void> {
      await super.init(); // real: only constructs clients, no I/O
      installFakes(
        this as unknown as Record<string, unknown>,
        getWorld().chains.map((c) => c.key)
      );
    }
    // Emulates the polled tracker/activity endpoint (real cadence is 5-10 s).
    async observeActivity(): Promise<ObservedRow[]> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const now = Date.now();
      return getWorld().deposits.map((d) => toRow(d, now));
    }
    async claim(
      hop: Parameters<headlessModule.HeadlessUser['claim']>[0],
      row: ObservedRow
    ): Promise<ClaimSubmission> {
      const world = getWorld();
      const deposit = world.deposits.find((d) => d.rowKey === row.rowKey);
      const timing = { startedAt: Date.now(), durationMs: 1 };
      if (deposit === undefined) throw new Error(`world: no deposit for ${row.rowKey}`);
      if (deposit.claimedBy !== null) {
        return {
          isClaimedBefore: true,
          isClaimedTiming: timing,
          claimInputs: null,
          claim: null,
          isClaimedRecheck: null
        };
      }
      deposit.claimedBy = 'manual';
      const dest = world.chains.find((c) => c.key === hop.toChainKey);
      world.manualClaims.push({
        route: deposit.route,
        arrivesAs: arrivesAs(dest)
      });
      return {
        isClaimedBefore: false,
        isClaimedTiming: timing,
        claimInputs: { claimable: true, timing },
        claim: {
          txHash: hex32(900_000 + world.seq),
          submit: timing,
          receipt: { status: 'success', timing }
        },
        isClaimedRecheck: null
      };
    }
  }
  return { ...actual, HeadlessUser: ScriptedHeadlessUser };
});

// Real preflight (gas-token discovery included) against fake clients.
vi.mock('./wallets/preflight', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runPreflight: (options: Record<string, unknown>) =>
      (actual.runPreflight as (o: Record<string, unknown>) => Promise<unknown>)({
        ...options,
        clientFactory: mocks.chainClientFactory,
        fetchImpl: mocks.fetchImpl
      })
  };
});

// -- fake chain clients for preflight ----------------------------------------

const selectorOf = (name: string) =>
  encodeFunctionData({
    abi: [{ name, type: 'function', inputs: [], outputs: [], stateMutability: 'view' }],
    functionName: name
  });
const word = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);
const addressWord = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;

const buildClientFactory = (gasTokenChainKeys: string[]): ChainClientFactory => {
  const gasTokenAddressSel = selectorOf('gasTokenAddress');
  const gasTokenNetworkSel = selectorOf('gasTokenNetwork');
  const wethSel = selectorOf('WETHToken');
  return (chain) => {
    const isGas = gasTokenChainKeys.includes(chain.key);
    return {
      public: {
        getChainId: async () => chain.chainId,
        getCode: async () => '0x1234' as const,
        getBalance: async () => BigInt(10) ** BigInt(18),
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'balanceOf') return BigInt(10) ** BigInt(18);
          if (functionName === 'allowance') return BigInt(0);
          throw new Error(`unexpected readContract: ${functionName}`);
        },
        call: async ({ data }: { data?: string }) => {
          if (data === gasTokenAddressSel)
            return { data: isGas ? addressWord(GAS_TOKEN) : word(BigInt(0)) };
          if (data === gasTokenNetworkSel) return { data: word(BigInt(GAS_TOKEN_NETWORK)) };
          if (data === wethSel) return { data: addressWord(WETH) };
          throw new Error(`unexpected call data: ${data}`);
        }
      },
      test: {},
      wallet: () => ({})
    } as unknown as ChainClientSet;
  };
};

const fetchOk = (async (input: RequestInfo | URL) => {
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

// ---------------------------------------------------------------------------
// Ring fixtures
// ---------------------------------------------------------------------------

interface RingFixture {
  name: string;
  ring: [string, string, string, string];
  gasTokenChainKeys: string[];
  config: LoadtestConfig;
  chains: ChainInfo[];
  routes: [string, string, string];
}

const buildRing = (kind: 'eth' | 'gas'): RingFixture => {
  const base = buildTestDevnetConfig({ usersTotal: 1 });
  const [l1, l2a, l2b] = base.chains;
  // Gas ring: SEPOLIA -> L2G -> L2A -> SEPOLIA, L2G is a gas-token chain.
  const ring: RingFixture['ring'] =
    kind === 'eth' ? ['SEPOLIA', 'L2A', 'L2B', 'SEPOLIA'] : ['SEPOLIA', 'L2G', 'L2A', 'SEPOLIA'];
  const gasTokenChainKeys = kind === 'eth' ? [] : ['L2G'];
  // Distinct bridge addresses: the devnet fixture reuses one address for every
  // chain, but the world model identifies the source chain by bridge address.
  const bridgeAddr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  const chains =
    kind === 'eth'
      ? [
          { ...l1, key: 'SEPOLIA', bridgeAddress: bridgeAddr(0xa0) },
          { ...l2a, key: 'L2A', bridgeAddress: bridgeAddr(0xa1) },
          { ...l2b, key: 'L2B', bridgeAddress: bridgeAddr(0xa2) }
        ]
      : [
          { ...l1, key: 'SEPOLIA', bridgeAddress: bridgeAddr(0xa0) },
          {
            ...l2b,
            key: 'L2G',
            networkId: GAS_TOKEN_NETWORK,
            chainId: 20263,
            bridgeAddress: bridgeAddr(0xa3)
          },
          { ...l2a, key: 'L2A', bridgeAddress: bridgeAddr(0xa1) }
        ];
  const routes: RingFixture['routes'] = [
    `${ring[0]}->${ring[1]}`,
    `${ring[1]}->${ring[2]}`,
    `${ring[2]}->${ring[3]}`
  ];
  const config = parseLoadtestConfig({
    ...base,
    chains,
    ring,
    autoclaim: {
      [routes[0]]: { expected: true, waitMs: WAIT_MS },
      [routes[1]]: { expected: true, waitMs: WAIT_MS },
      [routes[2]]: { expected: false }
    },
    users: {
      ...base.users,
      browser: 0,
      funder: {
        ...base.users.funder,
        gasPerChain: Object.fromEntries(chains.map((c) => [c.key, '0.05'])),
        maxTotalSpend: Object.fromEntries(chains.map((c) => [c.key, '1']))
      }
    },
    load: {
      bridgesPerMinutePerUser: 600,
      durationMinutes: 0.04,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 1
    },
    timeouts: {
      ...base.timeouts,
      txReceiptMs: 5_000,
      appearsInActivityMs: 5_000,
      readyToClaimMs: 8_000,
      claimedMs: 8_000,
      hopMs: 20_000,
      lapMs: 60_000
    },
    output: { ...base.output, activityLog: false }
  });
  return {
    name: kind === 'eth' ? 'ETH-gas ring' : 'gas-token ring',
    ring,
    gasTokenChainKeys,
    config,
    chains: chains.map((c) => ({
      key: c.key,
      networkId: c.networkId,
      bridgeAddress: c.bridgeAddress,
      gasToken: gasTokenChainKeys.includes(c.key)
        ? { address: GAS_TOKEN, network: GAS_TOKEN_NETWORK }
        : null
    })),
    routes
  };
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ResultsShape {
  hops: { byRoute: Record<string, { byOutcome: Record<string, number> }> };
  laps: { byOutcome: Record<string, number> };
  policy: { autoclaimOverdue: number; unexpectedAutoclaim: number; claimRaceLost: number };
  errors: { byClass: Record<string, unknown> };
  gasTokenChains?: Record<string, { gasTokenAddress: string; wethToken: string }>;
}

let outDir: string;
beforeEach(() => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-ringroutes-'));
});
afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

const runRing = async (
  fixture: RingFixture,
  policyOverrides: Partial<Record<0 | 1 | 2, Policy>>
): Promise<{ results: ResultsShape; world: World }> => {
  // expected-true hops are auto-claimed, the expected-false hop is not.
  const policies: [Policy, Policy, Policy] = [
    policyOverrides[0] ?? 'auto',
    policyOverrides[1] ?? 'auto',
    policyOverrides[2] ?? 'never'
  ];
  const world = newWorld(fixture.chains, {
    [fixture.routes[0]]: policies[0],
    [fixture.routes[1]]: policies[1],
    [fixture.routes[2]]: policies[2]
  });
  mocks.world = world;
  mocks.chainClientFactory = buildClientFactory(fixture.gasTokenChainKeys);
  mocks.fetchImpl = fetchOk;

  const result = await runLoadTest({
    config: fixture.config,
    activeAssetIndices: [0],
    configPath: '/nonexistent/loadtest.config.json',
    repoRoot: '/nonexistent-repo-root',
    fund: false,
    mainnetConfirmed: false,
    outDir,
    logger: () => {}
  });
  expect(result.aborted).toBe(false);
  const results = JSON.parse(fs.readFileSync(result.resultsPath, 'utf8')) as ResultsShape;
  return { results, world };
};

const outcomesOf = (results: ResultsShape, route: string): Record<string, number> =>
  results.hops.byRoute[route]?.byOutcome ?? {};
const total = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
const depositsOn = (world: World, route: string): Deposit[] =>
  world.deposits.filter((d) => d.route === route);
const manualClaimsOn = (world: World, route: string): ManualClaim[] =>
  world.manualClaims.filter((c) => c.route === route);

// ---------------------------------------------------------------------------
// The E2E
// ---------------------------------------------------------------------------

describe.each([['eth' as const], ['gas' as const]])(
  'runLoadTest E2E route handling — %s ring (offline, in-process mocks)',
  (kind) => {
    const fixture = buildRing(kind);
    const isGas = kind === 'gas';
    const TIMEOUT = 40_000;

    it(
      'completes all three hops: autoclaim hops resolve auto, the L2->L1 hop via manual claim',
      async () => {
        const { results, world } = await runRing(fixture, {});
        const [r0, r1, r2] = fixture.routes;

        const n = depositsOn(world, r0).length;
        expect(n).toBeGreaterThanOrEqual(1);
        expect(depositsOn(world, r1)).toHaveLength(n);
        expect(depositsOn(world, r2)).toHaveLength(n);

        // (1)+(2) every hop completed; expected:true hops resolved by autoclaim.
        expect(outcomesOf(results, r0)).toStrictEqual({ hop_completed_auto: n });
        expect(outcomesOf(results, r1)).toStrictEqual({ hop_completed_auto: n });
        // (3) expected:false hop: completed through OUR manual claim.
        expect(outcomesOf(results, r2)).toStrictEqual({ hop_completed_manual: n });
        expect(manualClaimsOn(world, r0)).toHaveLength(0);
        expect(manualClaimsOn(world, r1)).toHaveLength(0);
        expect(manualClaimsOn(world, r2)).toHaveLength(n);
        expect(depositsOn(world, r2).every((d) => d.claimedBy === 'manual')).toBe(true);

        // Laps all completed; no policy counters, no errors.
        expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0, LAP_ABORTED: 0 });
        expect(results.policy).toStrictEqual({
          autoclaimOverdue: 0,
          unexpectedAutoclaim: 0,
          claimRaceLost: 0
        });
        expect(results.errors.byClass).toStrictEqual({});

        // Leaf identity: ETH is (0, 0x0) on every hop in both rings...
        for (const d of world.deposits) {
          expect(d.leaf).toStrictEqual({ originNetwork: 0, originAddress: ZERO });
        }
        const sendsOn = (route: string) => world.sends.filter((s) => s.route === route);
        if (!isGas) {
          // ETH-gas ring: every hop bridges native ETH (token 0x0, msg.value > 0).
          for (const s of world.sends) {
            expect(s.token).toBe(ZERO);
            expect(s.value > BigInt(0)).toBe(true);
          }
          expect(results.gasTokenChains).toBeUndefined();
          expect(world.manualClaims.every((c) => c.arrivesAs === 'native ETH')).toBe(true);
        } else {
          // ...but on the gas-token ring the hop LEAVING L2G burns WETH instead
          // (token = WETH, no msg.value), and ETH ARRIVES on L2G as WETH.
          expect(sendsOn(r0).every((s) => s.token === ZERO && s.value > BigInt(0))).toBe(true);
          expect(sendsOn(r1).every((s) => s.token === WETH && s.value === BigInt(0))).toBe(true);
          expect(sendsOn(r2).every((s) => s.token === ZERO && s.value > BigInt(0))).toBe(true);
          expect(results.gasTokenChains?.L2G).toMatchObject({
            gasTokenAddress: GAS_TOKEN,
            wethToken: WETH
          });
        }

        // Where ETH lands: as WETH on a gas-token chain, as native ETH elsewhere.
        for (const d of world.deposits) {
          const dest = world.chains.find((c) => c.key === d.toChain);
          expect(arrivesAs(dest)).toBe(d.toChain === 'L2G' ? 'WETH' : 'native ETH');
        }
        expect(depositsOn(world, r0).every((d) => d.toChain === (isGas ? 'L2G' : 'L2A'))).toBe(
          true
        );
      },
      TIMEOUT
    );

    it(
      'forced "never auto-claims" on an expected:true hop -> autoclaimOverdue, escalated manual claim',
      async () => {
        const { results, world } = await runRing(fixture, { 1: 'never' });
        const [r0, r1, r2] = fixture.routes;

        const n = depositsOn(world, r1).length;
        expect(n).toBeGreaterThanOrEqual(1);

        expect(outcomesOf(results, r1)).toStrictEqual({ hop_completed_escalated: n });
        expect(manualClaimsOn(world, r1)).toHaveLength(n);
        expect(results.policy.autoclaimOverdue).toBe(n);
        expect(results.policy.unexpectedAutoclaim).toBe(0);

        // The other hops are unaffected.
        expect(outcomesOf(results, r0)).toStrictEqual({ hop_completed_auto: n });
        expect(outcomesOf(results, r2)).toStrictEqual({ hop_completed_manual: n });
        expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0, LAP_ABORTED: 0 });
        expect(results.errors.byClass).toStrictEqual({});
      },
      TIMEOUT
    );

    it(
      'forced auto-claim of the expected:false L2->L1 hop -> unexpectedAutoclaim, completed as auto',
      async () => {
        const { results, world } = await runRing(fixture, { 2: 'instant' });
        const [r0, r1, r2] = fixture.routes;

        const n = depositsOn(world, r2).length;
        expect(n).toBeGreaterThanOrEqual(1);

        expect(outcomesOf(results, r2)).toStrictEqual({ hop_completed_auto: n });
        expect(manualClaimsOn(world, r2)).toHaveLength(0);
        expect(depositsOn(world, r2).every((d) => d.claimedBy === 'auto')).toBe(true);
        expect(results.policy.unexpectedAutoclaim).toBe(n);
        expect(results.policy.autoclaimOverdue).toBe(0);

        expect(outcomesOf(results, r0)).toStrictEqual({ hop_completed_auto: n });
        expect(outcomesOf(results, r1)).toStrictEqual({ hop_completed_auto: n });
        expect(total(outcomesOf(results, r0))).toBe(n);
        expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0, LAP_ABORTED: 0 });
        expect(results.errors.byClass).toStrictEqual({});
      },
      TIMEOUT
    );
  }
);

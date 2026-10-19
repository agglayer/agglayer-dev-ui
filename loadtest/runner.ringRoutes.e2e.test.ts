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
import type { RunLoadTestOptions } from './runner';
import type { ChainClientFactory, ChainClientSet } from './wallets/chainClients';
import type * as headlessModule from './workers/headless/headlessUser';

import { parseLoadtestConfig } from './config/schema';
import { ClassifiedFetchError } from './metrics/errors';
import { generateRunReport, renderReportAfterRun } from './metrics/html/index';
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
  // S53: how many upcoming `observeActivity()` calls answer like a tracker that
  // has not registered the address yet (503 "not ready yet"), and when each
  // call happened — the back-off test reads the gap after a refusal.
  trackerNotReadyBudget: number;
  activityCalls: { at: number; refused: boolean }[];
  // S53: the `claimPreState` option each user driver was constructed with.
  claimPreStateSeen: unknown[];
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
  seq: 0,
  trackerNotReadyBudget: 0,
  activityCalls: [],
  claimPreStateSeen: []
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
      getWorld().claimPreStateSeen.push(
        (this as unknown as { claimPreState: unknown }).claimPreState
      );
      installFakes(
        this as unknown as Record<string, unknown>,
        getWorld().chains.map((c) => c.key)
      );
    }
    // Emulates the polled tracker/activity endpoint (real cadence is 5-10 s).
    async observeActivity(): Promise<ObservedRow[]> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const now = Date.now();
      const world = getWorld();
      if (world.trackerNotReadyBudget > 0) {
        world.trackerNotReadyBudget -= 1;
        world.activityCalls.push({ at: now, refused: true });
        throw new ClassifiedFetchError(
          {
            errorClass: 'tracker_not_ready',
            message: 'activity for this address is not ready yet, retry after 5s'
          },
          503
        );
      }
      world.activityCalls.push({ at: now, refused: false });
      return world.deposits.map((d) => toRow(d, now));
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
  [key: string]: unknown;
  hops: {
    byOutcome?: Record<string, number>;
    byRoute: Record<string, { byOutcome: Record<string, number> }>;
  };
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

// S53: optional extras so the heavy-load tests can reuse this harness without
// changing what the original tests above run.
interface RunExtras {
  config?: LoadtestConfig;
  setup?: (world: World) => void;
  runOptions?: Partial<RunLoadTestOptions>;
  logger?: (line: string) => void;
}

const runRing = async (
  fixture: RingFixture,
  policyOverrides: Partial<Record<0 | 1 | 2, Policy>>,
  extra: RunExtras = {}
): Promise<{ results: ResultsShape; world: World; outDir: string }> => {
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
  extra.setup?.(world);

  const result = await runLoadTest({
    config: extra.config ?? fixture.config,
    activeAssetIndices: [0],
    configPath: '/nonexistent/loadtest.config.json',
    repoRoot: '/nonexistent-repo-root',
    fund: false,
    mainnetConfirmed: false,
    outDir,
    logger: extra.logger ?? (() => {}),
    ...extra.runOptions
  });
  expect(result.aborted).toBe(false);
  const results = JSON.parse(fs.readFileSync(result.resultsPath, 'utf8')) as ResultsShape;
  return { results, world, outDir };
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

// ---------------------------------------------------------------------------
// S53 / heavy-load design F3 through the real runner: a tracker "not ready yet"
// refusal is its own class, never fails a hop, and the retry waits the UI cadence.
// ---------------------------------------------------------------------------

describe('runLoadTest — tracker "not ready yet" handling (S53 F3)', () => {
  const fixture = buildRing('eth');

  it('records tracker_not_ready, does not fail the hop, and waits the 5 s UI cadence before polling again', async () => {
    // The default fixture gives a hop only 5 s to appear in the activity feed;
    // the back-off alone is 5 s, so widen that one budget (nothing else).
    const config: LoadtestConfig = {
      ...fixture.config,
      timeouts: { ...fixture.config.timeouts, appearsInActivityMs: 30_000, hopMs: 60_000 }
    };
    const { results, world } = await runRing(
      fixture,
      {},
      {
        config,
        setup: (w) => {
          w.trackerNotReadyBudget = 1;
        }
      }
    );

    const refusedIndex = world.activityCalls.findIndex((c) => c.refused);
    expect(refusedIndex).toBeGreaterThanOrEqual(0);
    const next = world.activityCalls[refusedIndex + 1];
    expect(next).toBeDefined();
    // 5 000 ms back-off (timer granularity leaves a little slack).
    expect(next.at - world.activityCalls[refusedIndex].at).toBeGreaterThanOrEqual(4_900);

    // Its own class, counted once...
    expect(results.errors.byClass).toStrictEqual({ tracker_not_ready: 1 });
    // ...and no hop or lap failed because of it.
    const failed = Object.entries(results.hops.byOutcome ?? {}).filter(
      ([outcome]) => !outcome.startsWith('hop_completed')
    );
    expect(failed).toStrictEqual([]);
    expect(results.laps.byOutcome).toMatchObject({ LAP_FAILED: 0 });
  }, 90_000);
});

// ---------------------------------------------------------------------------
// S53 / heavy-load design §1.3-§1.5 through the real runner: the L1 deposit pump
// and the samplers run beside the users without changing what the users do, and
// a config without them produces none of their output.
// ---------------------------------------------------------------------------

const GER: Address = '0x00000000000000000000000000000000000000a1';

interface PumpWorld {
  head: bigint;
  sends: { hash: Hex; blockNumber: bigint }[];
  logs: { blockNumber: bigint; transactionHash: Hex; topics: readonly Hex[]; data: Hex }[];
  failSend: boolean;
  receiptDelayMs: number;
  balanceReads: { chain: string; address: string }[];
}

// One fake viem client set, shared by the pump (L1 sends), the wallet-balance
// sampler (`getBalance`) and the L1 info tree poller (`getBlockNumber`/`getLogs`).
const pumpClientFactory = (world: PumpWorld, l1BridgeAddress: string): ChainClientFactory => {
  const L1_INFO_TREE_V2 = parseAbiItem(
    'event UpdateL1InfoTreeV2(bytes32 currentL1InfoRoot, uint32 indexed leafCount, uint256 blockhash, uint64 minTimestamp)'
  );
  return (chain) =>
    ({
      public: {
        getChainId: async () => chain.chainId,
        getCode: async () => '0x1234' as const,
        getBalance: async ({ address }: { address: string }) => {
          world.balanceReads.push({ chain: chain.key, address });
          return BigInt(10) ** BigInt(18);
        },
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'globalExitRootManager') return GER;
          if (functionName === 'depositCount') return 500;
          if (functionName === 'balanceOf') return BigInt(10) ** BigInt(18);
          if (functionName === 'allowance') return BigInt(0);
          throw new Error(`unexpected readContract: ${functionName}`);
        },
        call: async () => ({ data: `0x${'0'.repeat(64)}` }),
        getGasPrice: async () => BigInt(1_000_000),
        estimateGas: async () => BigInt(440_000),
        estimateMaxPriorityFeePerGas: async () => BigInt(1_000_000),
        getTransactionCount: async () => 7,
        getBlockNumber: async () => world.head,
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
          world.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
        waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          await new Promise((resolve) => setTimeout(resolve, world.receiptDelayMs));
          const send = world.sends.find((s) => s.hash === hash);
          if (send === undefined) throw new Error('unknown pump tx');
          return {
            status: 'success' as const,
            blockNumber: send.blockNumber,
            gasUsed: BigInt(437_125),
            effectiveGasPrice: BigInt(1_000_000),
            logs: [
              bridgeEventLog(
                l1BridgeAddress,
                { originNetwork: 0, originAddress: ZERO },
                1,
                BigInt(0),
                42
              )
            ]
          };
        }
      },
      test: {},
      wallet: () => ({
        sendTransaction: async () => {
          if (world.failSend) throw new Error('replacement transaction underpriced');
          world.head += BigInt(1);
          const hash = hex32(0xf0_0000 + world.sends.length);
          world.sends.push({ hash, blockNumber: world.head });
          // The deposit shows up as a new L1 info tree leaf in its own block.
          world.logs.push({
            blockNumber: world.head,
            transactionHash: hash,
            topics: encodeEventTopics({
              abi: [L1_INFO_TREE_V2],
              eventName: 'UpdateL1InfoTreeV2',
              args: { leafCount: 501 }
            }) as readonly Hex[],
            data: encodeAbiParameters(
              [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
              [`0x${'11'.repeat(32)}`, BigInt(1), BigInt(1_700_000_000)]
            )
          });
          return hash;
        }
      })
    }) as unknown as ChainClientSet;
};

const readNdjson = (dir: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(dir, 'activity.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const NEW_KINDS = [
  'pump_state',
  'pump_deposit',
  'pump_skipped',
  'wallet_balance',
  'l1_info_leaf',
  'l1_info_poll_error',
  'http_window',
  'tx_sent',
  'tx_receipt'
];

describe('runLoadTest — optional heavy-load features through the runner (S53)', () => {
  const fixture = buildRing('eth');
  const l1BridgeAddress = fixture.chains[0].bridgeAddress;
  const withActivityLog = (config: LoadtestConfig): LoadtestConfig => ({
    ...config,
    output: { ...config.output, activityLog: true }
  });
  const heavyConfig = (extra: Partial<LoadtestConfig> = {}): LoadtestConfig =>
    withActivityLog({
      ...fixture.config,
      pump: {
        enabled: true,
        chainKey: 'SEPOLIA',
        destinationNetworkId: 1,
        walletIndex: 999,
        amount: '0',
        intervalSeconds: 60,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 5
      },
      measurement: {
        walletBalanceIntervalMs: 60_000,
        l1InfoTree: { pollIntervalMs: 15_000 },
        httpWindowMs: 10_000,
        claimPreState: true
      },
      ...extra
    });
  const newPumpWorld = (over: Partial<PumpWorld> = {}): PumpWorld => ({
    head: BigInt(1000),
    sends: [],
    logs: [],
    failSend: false,
    receiptDelayMs: 0,
    balanceReads: [],
    ...over
  });

  it('flag off: a config with no pump and no measurement writes none of the new kinds or keys, and the status line only gains inflightByRoute', async () => {
    const logs: string[] = [];
    // Slow the first poll so the run lives past the 5 s status interval.
    const { results, outDir: dir } = await runRing(
      fixture,
      {},
      {
        config: withActivityLog({
          ...fixture.config,
          timeouts: { ...fixture.config.timeouts, appearsInActivityMs: 30_000, hopMs: 60_000 }
        }),
        setup: (w) => {
          w.trackerNotReadyBudget = 1;
        },
        logger: (line) => logs.push(line)
      }
    );

    const lines = readNdjson(dir);
    const kinds = new Set(lines.map((l) => l.kind as string));
    for (const kind of NEW_KINDS) expect(kinds.has(kind), kind).toBe(false);
    for (const key of ['pump', 'walletBalances', 'l1InfoTree'])
      expect(key in results, key).toBe(false);
    const measurements = results.measurements as { approveGas?: unknown } | undefined;
    expect(measurements !== undefined && 'approveGas' in measurements).toBe(false);

    const status = logs.find((l) => l.startsWith('[status]'));
    expect(status).toBeDefined();
    expect(status).toMatch(
      /^\[status\] t=\d+s phase=\S+ usersActive=\d+\/\d+ lapStartsSubmitted=\d+ rate=[\d.]+\/min inflightHops=\d+ skippedBackpressure=\d+ errors=\d+ inflightByRoute=\S+$/
    );
    expect(status).not.toContain('pump=');
  }, 90_000);

  it('pump + samplers on: the pump runs beside the users, is accounted separately, and the users are unaffected', async () => {
    const pumpWorld = newPumpWorld();
    const logs: string[] = [];
    // One refused activity poll costs a 5 s back-off, so the run outlives the
    // first 5 s status interval and the status line can be checked.
    const {
      results,
      world,
      outDir: dir
    } = await runRing(
      fixture,
      {},
      {
        config: heavyConfig({
          timeouts: { ...fixture.config.timeouts, appearsInActivityMs: 30_000, hopMs: 60_000 }
        }),
        setup: (w) => {
          w.trackerNotReadyBudget = 1;
        },
        runOptions: { chainClientFactory: pumpClientFactory(pumpWorld, l1BridgeAddress) },
        logger: (line) => logs.push(line)
      }
    );

    // --- the users did what they always do ---
    const [r0, r1, r2] = fixture.routes;
    const n = depositsOn(world, r0).length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(outcomesOf(results, r0)).toStrictEqual({ hop_completed_auto: n });
    expect(outcomesOf(results, r1)).toStrictEqual({ hop_completed_auto: n });
    expect(outcomesOf(results, r2)).toStrictEqual({ hop_completed_manual: n });
    expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0, LAP_ABORTED: 0 });
    // Only the one scripted tracker refusal: the pump added no error of its own.
    expect(results.errors.byClass).toStrictEqual({ tracker_not_ready: 1 });
    // The pump's deposit is not a user deposit.
    expect(world.deposits.some((d) => d.txHash === pumpWorld.sends[0].hash)).toBe(false);
    expect(pumpWorld.sends).toHaveLength(1);

    // --- the pump block ---
    const pump = results.pump as {
      enabled: boolean;
      sender: string;
      deposits: { txHash: string; depositCount: number | null; status: string }[];
      skipped: Record<string, number>;
      totalSpendWei: string;
      pendingAtStop: boolean;
      destinationNetworkId: number;
    };
    expect(pump.enabled).toBe(true);
    expect(pump.destinationNetworkId).toBe(1);
    expect(pump.deposits).toHaveLength(1);
    expect(pump.deposits[0]).toMatchObject({
      txHash: pumpWorld.sends[0].hash,
      depositCount: 42,
      status: 'success'
    });
    expect(pump.skipped).toStrictEqual({
      gas_price: 0,
      cap_reached: 0,
      previous_pending: 0,
      send_error: 0
    });
    expect(pump.totalSpendWei).toBe((BigInt(437_125) * BigInt(1_000_000)).toString());
    expect(pump.pendingAtStop).toBe(false);
    expect(pump.sender).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // --- ndjson: pump kinds are harness:pump only, and never a hop record ---
    const lines = readNdjson(dir);
    const pumpLines = lines.filter((l) => String(l.kind).startsWith('pump_'));
    expect(pumpLines.map((l) => l.kind)).toStrictEqual([
      'pump_state',
      'pump_deposit',
      'pump_state'
    ]);
    for (const l of pumpLines) {
      expect(l.userId).toBe('harness:pump');
      expect(l.mode).toBeNull();
    }
    expect(
      lines.filter((l) => l.userId === 'harness:pump' && !String(l.kind).startsWith('pump_'))
    ).toStrictEqual([]);
    const hopEnds = lines.filter((l) => l.kind === 'hop_end');
    expect(hopEnds).toHaveLength(3 * n);
    // pump_state(started) comes after run_start and the stopped record before run_end.
    const order = lines.map((l) => l.kind);
    expect(order.indexOf('run_start')).toBeLessThan(order.indexOf('pump_state'));
    expect(order.lastIndexOf('pump_state')).toBeLessThan(order.indexOf('run_end'));

    // --- M7: tx_sent / tx_receipt now exist (a measurement block is present) ---
    const txSent = lines.filter((l) => l.kind === 'tx_sent');
    expect(txSent.filter((l) => l.step === 'bridge')).toHaveLength(world.sends.length);
    expect(txSent.filter((l) => l.step === 'claim')).toHaveLength(manualClaimsOn(world, r2).length);
    expect(lines.filter((l) => l.kind === 'tx_receipt').length).toBe(txSent.length);
    expect(txSent.some((l) => l.txHash === pumpWorld.sends[0].hash)).toBe(false);

    // --- M1: wallet balances on the non-L1 ring chains only ---
    const balances = results.walletBalances as {
      intervalMs: number;
      samples: { chainKey: string; n: number }[];
    };
    expect(balances.intervalMs).toBe(60_000);
    expect(new Set(balances.samples.map((s) => s.chainKey))).toStrictEqual(new Set(['L2A', 'L2B']));
    expect(balances.samples.every((s) => s.n === 1)).toBe(true);
    expect(pumpWorld.balanceReads.some((r) => r.chain === 'SEPOLIA')).toBe(false);

    // --- M3: GER discovered, baseline read, the pump's leaf picked up and attributed ---
    const tree = results.l1InfoTree as {
      gerManagerAddress: string;
      baselineLeafCount: number;
      leaves: { leafCount: number; fromPump: boolean; txHash: string }[];
      pollErrors: number;
    };
    expect(tree.gerManagerAddress).toBe(GER);
    expect(tree.baselineLeafCount).toBe(500);
    expect(tree.leaves).toMatchObject([
      { leafCount: 501, fromPump: true, txHash: pumpWorld.sends[0].hash }
    ]);
    expect(tree.pollErrors).toBe(0);

    // --- M4: the final partial window is flushed ---
    expect(lines.some((l) => l.kind === 'http_window')).toBe(true);

    // --- M9 plumbing: the option reaches every user driver ---
    expect(world.claimPreStateSeen.length).toBeGreaterThan(0);
    expect(world.claimPreStateSeen.every((v) => v === true)).toBe(true);

    // --- status line: appended fields only, pump progress shown ---
    const status = logs.find((l) => l.startsWith('[status]'));
    expect(status).toBeDefined();
    expect(status).toMatch(/ inflightByRoute=\S+ pump=on\(\d+\/1,[\d.]+ETH\)$/);

    // --- S54: the real artifacts of a heavy-load run render to the HTML report ---
    const generated = await generateRunReport({ dir });
    const html = fs.readFileSync(generated.htmlPath, 'utf8');
    expect(html).toContain('PUMP ON');
    expect(html).toContain(`data-metric="pump.deposits">${pump.deposits.length}<`);
    expect(html).toContain(`data-metric="l1.leaves">${tree.leaves.length}<`);
    expect(html).toContain('lowest wallet');
    expect(html).not.toMatch(/0x[0-9a-fA-F]{64}/);
  }, 90_000);

  it('a pump that cannot send never fails a user hop: the failure is a send_error skip and one rpc_error without a hopId', async () => {
    const pumpWorld = newPumpWorld({ failSend: true });
    const {
      results,
      world,
      outDir: dir
    } = await runRing(
      fixture,
      {},
      {
        config: heavyConfig(),
        runOptions: { chainClientFactory: pumpClientFactory(pumpWorld, l1BridgeAddress) }
      }
    );
    const [r0, , r2] = fixture.routes;
    const n = depositsOn(world, r0).length;
    expect(outcomesOf(results, r2)).toStrictEqual({ hop_completed_manual: n });
    expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0 });
    expect((results.pump as { skipped: Record<string, number> }).skipped.send_error).toBe(1);
    expect((results.pump as { deposits: unknown[] }).deposits).toHaveLength(0);
    expect(results.errors.byClass).toStrictEqual({ rpc_error: 1 });
    const errorLines = readNdjson(dir).filter((l) => l.kind === 'error');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatchObject({ userId: 'harness:pump', errorClass: 'rpc_error' });
    expect(errorLines[0].hopId).toBeUndefined();
  }, 90_000);

  it('waits for a pump receipt that arrives after the users finish, BEFORE the report is written', async () => {
    // The receipt lands ~4 s in, well after the last lap of a ~2.4 s load.
    const pumpWorld = newPumpWorld({ receiptDelayMs: 4_000 });
    const { results, outDir: dir } = await runRing(
      fixture,
      {},
      {
        config: heavyConfig(),
        runOptions: { chainClientFactory: pumpClientFactory(pumpWorld, l1BridgeAddress) }
      }
    );
    const pump = results.pump as { deposits: unknown[]; pendingAtStop: boolean };
    expect(pump.deposits).toHaveLength(1);
    expect(pump.pendingAtStop).toBe(false);
    const order = readNdjson(dir).map((l) => l.kind);
    expect(order.indexOf('pump_deposit')).toBeLessThan(order.indexOf('run_end'));
  }, 90_000);

  it('a pump wallet that falls inside the user range after --users grew it is refused before anything is derived or funded', async () => {
    const config = heavyConfig();
    const grown: LoadtestConfig = { ...config, users: { ...config.users, total: 1_000 } };
    await expect(
      runRing(
        fixture,
        {},
        {
          config: grown,
          runOptions: { chainClientFactory: pumpClientFactory(newPumpWorld(), l1BridgeAddress) }
        }
      )
    ).rejects.toThrow(/PUMP_WALLET_OVERLAPS_USERS/);
  });

  it('a disabled pump block starts nothing (no pump records, no pump key)', async () => {
    const config = heavyConfig();
    const disabled: LoadtestConfig = {
      ...config,
      pump: { ...(config.pump as NonNullable<LoadtestConfig['pump']>), enabled: false },
      measurement: undefined
    };
    const pumpWorld = newPumpWorld();
    const { results, outDir: dir } = await runRing(
      fixture,
      {},
      {
        config: disabled,
        runOptions: { chainClientFactory: pumpClientFactory(pumpWorld, l1BridgeAddress) }
      }
    );
    expect('pump' in results).toBe(false);
    expect(pumpWorld.sends).toHaveLength(0);
    expect(readNdjson(dir).some((l) => String(l.kind).startsWith('pump_'))).toBe(false);
  }, 90_000);
});

describe('runLoadTest artifacts render to the HTML report (S54)', () => {
  const fixture = buildRing('eth');
  const withActivityLog = (config: LoadtestConfig): LoadtestConfig => ({
    ...config,
    output: { ...config.output, activityLog: true }
  });

  it('a real run (no heavy-load blocks) writes report.html next to results.json, with the numbers of results.json', async () => {
    const startedAtMs = Date.now();
    const { results, outDir: dir } = await runRing(
      fixture,
      {},
      { config: withActivityLog(fixture.config) }
    );
    const logs: string[] = [];
    const generated = await renderReportAfterRun({
      outDir: dir,
      runStartedAtMs: startedAtMs,
      log: (l) => logs.push(l),
      warn: (l) => logs.push(`WARN ${l}`),
      redact: String
    });
    expect(generated?.htmlPath).toBe(path.join(dir, 'report.html'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^report: .*report\.html \(\d+ bytes\)$/);
    const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    const laps = results.laps.byOutcome as Record<string, number>;
    expect(html).toContain(`data-metric="laps.done">${laps.LAP_DONE}<`);
    expect(html).toContain('PASS');
    expect(html).not.toMatch(/https?:\/\//);
    // the other artifacts are still there
    expect(fs.existsSync(path.join(dir, 'summary.md'))).toBe(true);
  }, 90_000);

  it('a stale results.json from an earlier run is not rendered, and a render failure never throws', async () => {
    const { outDir: dir } = await runRing(fixture, {}, { config: withActivityLog(fixture.config) });
    const logs: string[] = [];
    // "this run" started an hour after results.json was written
    const stale = await renderReportAfterRun({
      outDir: dir,
      runStartedAtMs: Date.now() + 3_600_000,
      log: (l) => logs.push(l),
      warn: (l) => logs.push(`WARN ${l}`),
      redact: String
    });
    expect(stale).toBeNull();
    expect(logs[0]).toContain('no results.json written by this run');
    expect(fs.existsSync(path.join(dir, 'report.html'))).toBe(false);

    fs.writeFileSync(path.join(dir, 'results.json'), '{ not json');
    const broken = await renderReportAfterRun({
      outDir: dir,
      runStartedAtMs: 0,
      log: (l) => logs.push(l),
      warn: (l) => logs.push(`WARN ${l}`),
      redact: (e) => (e instanceof Error ? e.message : String(e))
    });
    expect(broken).toBeNull();
    expect(logs.some((l) => l.startsWith('WARN report: HTML report failed:'))).toBe(true);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// S56: the whole heavy-load path in one offline run, no funds and no network:
// several wallets, a ramp, the L1 pump ON and measurement ON, then everything a
// campaign operator reads (results.json, activity.ndjson, report.html) is
// checked against what the fake world actually did. A second run with the pump
// off proves the pump leaves no trace.
// ---------------------------------------------------------------------------

describe('runLoadTest heavy-load E2E: wallets + ramp + pump + measurement -> report.html (S56)', () => {
  const WALLETS = 4;
  const KEYED_URL_SECRET = 'FAKEKEY0123456789abcdef';
  const fixture = buildRing('eth');
  const l1BridgeAddress = fixture.chains[0].bridgeAddress;

  const config = (pumpEnabled: boolean): LoadtestConfig => {
    const base = fixture.config;
    return {
      ...base,
      chains: base.chains.map((c) => ({
        ...c,
        // a key-bearing endpoint: it must never reach results.json or the HTML
        rpcUrl: `http://127.0.0.1:8545/v2/${KEYED_URL_SECRET}`
      })),
      users: { ...base.users, total: WALLETS },
      load: {
        bridgesPerMinutePerUser: 600,
        durationMinutes: 0.1,
        rampUpSeconds: 2,
        maxInflightLapsPerUser: 1
      },
      timeouts: { ...base.timeouts, appearsInActivityMs: 30_000, hopMs: 60_000 },
      output: { ...base.output, activityLog: true },
      pump: {
        enabled: pumpEnabled,
        chainKey: 'SEPOLIA',
        destinationNetworkId: 1,
        walletIndex: 99,
        amount: '0',
        intervalSeconds: 60,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 5
      },
      measurement: {
        walletBalanceIntervalMs: 60_000,
        l1InfoTree: { pollIntervalMs: 15_000 },
        httpWindowMs: 10_000,
        claimPreState: true
      }
    };
  };

  const newPumpWorld = (): PumpWorld => ({
    head: BigInt(1000),
    sends: [],
    logs: [],
    failSend: false,
    receiptDelayMs: 0,
    balanceReads: []
  });

  // Like the CLI: run, then render report.html from the artifacts the run wrote.
  const runHeavy = async (pumpEnabled: boolean, pumpWorld: PumpWorld) => {
    const startedAtMs = Date.now();
    const ran = await runRing(
      fixture,
      {},
      {
        config: config(pumpEnabled),
        runOptions: { chainClientFactory: pumpClientFactory(pumpWorld, l1BridgeAddress) }
      }
    );
    const rendered = await renderReportAfterRun({
      outDir: ran.outDir,
      runStartedAtMs: startedAtMs,
      log: () => {},
      warn: (l) => {
        throw new Error(`report warning: ${l}`);
      },
      redact: String
    });
    expect(rendered?.htmlPath).toBe(path.join(ran.outDir, 'report.html'));
    return ran;
  };

  const embeddedModel = (html: string): Record<string, unknown> => {
    const match = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(
      html
    );
    expect(match).not.toBeNull();
    return JSON.parse((match as RegExpExecArray)[1]) as Record<string, unknown>;
  };

  it('pump ON: counters, ndjson records, per-wallet hop counts, verdict and stop-criteria table agree with the fake world', async () => {
    const pumpWorld = newPumpWorld();
    const { results, world, outDir: dir } = await runHeavy(true, pumpWorld);
    const [r0, r1, r2] = fixture.routes;

    // --- the load: every wallet took part and every lap completed ---
    const n = depositsOn(world, r0).length;
    expect(n).toBeGreaterThanOrEqual(WALLETS);
    expect(depositsOn(world, r1)).toHaveLength(n);
    expect(depositsOn(world, r2)).toHaveLength(n);
    expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0, LAP_ABORTED: 0 });
    expect(results.errors.byClass).toStrictEqual({});

    // --- results.json: the pump counters ---
    const pump = results.pump as {
      enabled: boolean;
      deposits: { txHash: string }[];
      totalSpendWei: string;
      pendingAtStop: boolean;
      skipped: Record<string, number>;
    };
    expect(pump.enabled).toBe(true);
    expect(pump.deposits).toHaveLength(pumpWorld.sends.length);
    expect(pump.deposits.length).toBeGreaterThanOrEqual(1);
    expect(pump.pendingAtStop).toBe(false);
    expect(BigInt(pump.totalSpendWei)).toBe(
      BigInt(pump.deposits.length) * BigInt(437_125) * BigInt(1_000_000)
    );
    // within the 0.07 ETH cap
    expect(BigInt(pump.totalSpendWei) <= BigInt(70_000_000_000_000_000)).toBe(true);
    // the pump's deposits are not user deposits
    for (const s of pumpWorld.sends) {
      expect(world.deposits.some((d) => d.txHash === s.hash)).toBe(false);
    }

    // --- activity.ndjson: pump records belong to the harness, never to a wallet ---
    const lines = readNdjson(dir);
    const pumpLines = lines.filter((l) => String(l.kind).startsWith('pump_'));
    expect(pumpLines.filter((l) => l.kind === 'pump_deposit')).toHaveLength(pump.deposits.length);
    expect(pumpLines.every((l) => l.userId === 'harness:pump')).toBe(true);
    const userIds = [...new Set(lines.filter((l) => l.kind === 'tick').map((l) => l.userId))];
    expect(userIds).toHaveLength(WALLETS);

    // --- report.html rendered from this run's artifacts ---
    const htmlPath = path.join(dir, 'report.html');
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('PUMP ON');
    expect(html).toContain(`data-metric="pump.deposits">${pump.deposits.length}<`);
    expect(html).toContain(`data-metric="laps.done">${n}<`);

    // verdict: PASS banner, and the campaign go/no-go note
    expect(html).toMatch(/<div class="stamp pass"[^>]*>[\s\S]*?<span>PASS<\/span>/);
    expect(html).toContain('Campaign go/no-go uses the stop criteria');

    // stop-criteria table: all SC1..SC13 rows, none fired in a clean run
    expect(html).toContain('<h2 id="stop-h">Stop criteria (post-hoc)</h2>');
    const model = embeddedModel(html) as {
      stop: { id: string; fired: boolean | null; kind: string }[];
      wallets: {
        rows: {
          userId: string;
          lapsDone: number;
          lapsFailed: number;
          hopsOk: number;
          hopsFailed: number;
        }[];
      };
    };
    const ids = model.stop.map((c) => c.id);
    for (let i = 1; i <= 13; i += 1) expect(ids).toContain(`SC${i}`);
    expect(model.stop.filter((c) => c.kind === 'stop' && c.fired === true)).toStrictEqual([]);

    // per-wallet hop counts: 3 hops per lap, one row per wallet, totals match
    expect(model.wallets.rows).toHaveLength(WALLETS);
    for (const row of model.wallets.rows) {
      expect(row.lapsFailed).toBe(0);
      expect(row.hopsFailed).toBe(0);
      expect(row.hopsOk).toBe(row.lapsDone * 3);
      expect(row.lapsDone).toBeGreaterThanOrEqual(1);
      expect(html).toContain(`<td>${row.userId}</td>`);
    }
    expect(model.wallets.rows.reduce((a, r) => a + r.lapsDone, 0)).toBe(n);
    expect(model.wallets.rows.reduce((a, r) => a + r.hopsOk, 0)).toBe(n * 3);

    // --- no secrets, tokens or network references anywhere in the HTML ---
    for (const secret of [
      KEYED_URL_SECRET,
      TEST_FUNDER_PRIVATE_KEY,
      TEST_FUNDER_PRIVATE_KEY.slice(2)
    ]) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toContain(TEST_MNEMONIC);
    expect(html).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(html).not.toMatch(/https?:\/\//);
    // and results.json carries the masked endpoint, not the keyed one
    expect(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')).not.toContain(KEYED_URL_SECRET);
  }, 120_000);

  it('pump OFF, same config: no pump records, no pump key, no pump section, wallets unchanged', async () => {
    const pumpWorld = newPumpWorld();
    const { results, world, outDir: dir } = await runHeavy(false, pumpWorld);

    expect(pumpWorld.sends).toHaveLength(0);
    expect('pump' in results).toBe(false);
    const lines = readNdjson(dir);
    expect(lines.some((l) => String(l.kind).startsWith('pump_'))).toBe(false);
    expect(lines.some((l) => l.userId === 'harness:pump')).toBe(false);

    const n = depositsOn(world, fixture.routes[0]).length;
    expect(n).toBeGreaterThanOrEqual(WALLETS);
    expect(results.laps.byOutcome).toMatchObject({ LAP_DONE: n, LAP_FAILED: 0, LAP_ABORTED: 0 });

    const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    expect(html).not.toContain('PUMP ON');
    expect(html).toContain('PUMP OFF');
    expect(html).not.toContain('data-metric="pump.deposits">1<');
    expect(html).not.toContain('Spend versus cap');
    expect(html).toContain(`data-metric="laps.done">${n}<`);
    expect(html).toContain('<h2 id="stop-h">Stop criteria (post-hoc)</h2>');
    expect(html).not.toContain(KEYED_URL_SECRET);
  }, 120_000);
});

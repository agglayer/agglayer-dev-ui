// S07: gas-token chains at the `runLoadTest` seam (Design B, S05 decisions).
//
// `buildHopSpecs` is not exported, so its wiring (preflight.gasTokenChains ->
// HopSpec.fromWethToken / expectedOrigin) is observed where it is consumed:
// the specs handed to `createRingEngine().startLap`. Preflight and the
// headless driver are mocked, so there is no network and no real RPC. The
// scheduler runs for ~1 s of real time against a driver whose `bridge()`
// fails immediately.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ringModule from './core/ring';
import type { HopSpec } from './core/types';
import type { PreflightResult } from './wallets/preflight';

import { runLoadTest } from './runner';
import {
  buildTestDevnetConfig,
  TEST_FUNDER_PRIVATE_KEY,
  TEST_MNEMONIC
} from './wallets/testHelpers';

const mocks = vi.hoisted(() => ({
  preflightResult: null as unknown,
  startedLaps: [] as Array<{ assetIndex: number; hopSpecs: unknown[] }>
}));

vi.mock('./wallets/preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPreflight: vi.fn(async () => mocks.preflightResult)
}));

vi.mock('./core/ring', async (importOriginal) => {
  const actual = await importOriginal<typeof ringModule>();
  return {
    ...actual,
    createRingEngine: (options: Parameters<typeof actual.createRingEngine>[0]) => {
      const engine = actual.createRingEngine(options);
      return {
        ...engine,
        startLap: (params: Parameters<typeof engine.startLap>[0]) => {
          mocks.startedLaps.push({ assetIndex: params.assetIndex, hopSpecs: [...params.hopSpecs] });
          return engine.startLap(params);
        }
      };
    }
  };
});

vi.mock('./workers/headless/headlessUser', () => ({
  HeadlessUser: class {
    readonly mode = 'headless' as const;
    constructor(readonly options: { userId: string }) {}
    get userId() {
      return this.options.userId;
    }
    async init() {}
    async bridge() {
      throw new Error('stub driver: bridge() is not under test here');
    }
  }
}));

const WETH = '0x77290275947f166793b8d10428670e1fca26960a';
const GAS_TOKEN = '0x0000003f0000003f0000003f0000003f0000003f';
const ZERO = '0x0000000000000000000000000000000000000000';

const preflightOk = (gasTokenChains: PreflightResult['gasTokenChains']): PreflightResult => ({
  ok: true,
  chains: [],
  assets: [],
  trackerHealthStatus: 'pass',
  failures: [],
  gasTokenChains,
  table: ''
});

const gasTokenOnL2A: PreflightResult['gasTokenChains'] = {
  L2A: { chainKey: 'L2A', gasTokenAddress: GAS_TOKEN, gasTokenNetwork: 63, wethToken: WETH }
};

let outDir: string;
beforeEach(() => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
  mocks.startedLaps.length = 0;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-gastoken-'));
});
afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

// ~1.2 s of scheduling at 600 bridges/min, no ramp, one lap in flight.
const fastConfig = (browser = 0) => {
  const base = buildTestDevnetConfig({ usersTotal: 1 });
  return {
    ...base,
    users: { ...base.users, browser },
    load: {
      ...base.load,
      bridgesPerMinutePerUser: 600,
      durationMinutes: 0.02,
      rampUpSeconds: 0,
      maxInflightLapsPerUser: 1
    },
    output: { ...base.output, activityLog: false }
  };
};

const run = (config: ReturnType<typeof fastConfig>, assetIndex: number, dir = outDir) =>
  runLoadTest({
    config,
    activeAssetIndices: [assetIndex],
    configPath: '/nonexistent/loadtest.config.json',
    repoRoot: '/nonexistent-repo-root',
    fund: false,
    mainnetConfirmed: false,
    outDir: dir,
    logger: () => {}
  });

const firstLapHops = (): HopSpec[] => {
  expect(mocks.startedLaps.length).toBeGreaterThan(0);
  return mocks.startedLaps[0].hopSpecs as HopSpec[];
};

describe('runLoadTest — HopSpec wiring for gas-token chains (Design B)', () => {
  it('ETH-gas config (no gas-token chains): eth hops carry neither fromWethToken nor expectedOrigin (ring A/B unchanged)', async () => {
    mocks.preflightResult = preflightOk({});
    await run(fastConfig(), 0);

    const hops = firstLapHops();
    expect(hops.map((h) => h.hopRoute)).toStrictEqual(['L1->L2A', 'L2A->L2B', 'L2B->L1']);
    for (const hop of hops) {
      expect(hop.assetKind).toBe('eth');
      expect(hop).not.toHaveProperty('fromWethToken');
      expect(hop).not.toHaveProperty('expectedOrigin');
    }
  });

  it('gas-token chain L2A: eth leaving L2A is a WETH burn; hops touching L2A expect leaf origin (0, 0x0)', async () => {
    mocks.preflightResult = preflightOk(gasTokenOnL2A);
    await run(fastConfig(), 0);

    const [inbound, outbound, untouched] = firstLapHops();
    // L1 -> L2A: native ETH leaves an ETH chain, arrives as WETH on L2A.
    expect(inbound).not.toHaveProperty('fromWethToken');
    expect(inbound.expectedOrigin).toStrictEqual({ networkId: 0, address: ZERO });
    // L2A -> L2B: bridged out of the gas-token chain as token = WETH.
    expect(outbound.fromWethToken).toBe(WETH);
    expect(outbound.expectedOrigin).toStrictEqual({ networkId: 0, address: ZERO });
    // L2B -> L1 touches no gas-token chain: exactly the pre-change spec.
    expect(untouched).not.toHaveProperty('fromWethToken');
    expect(untouched).not.toHaveProperty('expectedOrigin');
  });

  it('gas-token chain L2A: an erc20 asset is never WETH-burned; its leaf identity is the configured origin', async () => {
    mocks.preflightResult = preflightOk(gasTokenOnL2A);
    const config = fastConfig();
    await run(config, 1);

    const erc20 = config.assets[1];
    const hops = firstLapHops();
    for (const hop of hops) expect(hop).not.toHaveProperty('fromWethToken');
    expect(hops[0].expectedOrigin).toStrictEqual({
      networkId: erc20.kind === 'erc20' ? erc20.originNetworkId : -1,
      address: erc20.kind === 'erc20' ? erc20.address : ''
    });
    expect(hops[2]).not.toHaveProperty('expectedOrigin');
  });
});

describe('runLoadTest — BROWSER_GAS_TOKEN_UNSUPPORTED (SD5)', () => {
  it('refuses browser users when a ring chain is a gas-token chain', async () => {
    mocks.preflightResult = preflightOk(gasTokenOnL2A);
    await expect(run(fastConfig(1), 0)).rejects.toThrow(/BROWSER_GAS_TOKEN_UNSUPPORTED.*L2A/);
    expect(mocks.startedLaps).toHaveLength(0);
  });

  it('does not refuse browser users on an ETH-gas config', async () => {
    mocks.preflightResult = preflightOk({});
    // The gate passes and the run fails at the NEXT step (no `uiBaseUrl`,
    // so no UI is built or probed) — proving the refusal did not fire.
    const config = { ...fastConfig(1), uiBaseUrl: undefined };
    await expect(run(config, 0)).rejects.toThrow(/requires uiBaseUrl/);
  });

  it('accepts headless users on a gas-token chain (the gate is passed and laps start)', async () => {
    mocks.preflightResult = preflightOk(gasTokenOnL2A);
    await expect(run(fastConfig(0), 0)).resolves.toBeDefined();
    expect(mocks.startedLaps.length).toBeGreaterThan(0);
  });
});

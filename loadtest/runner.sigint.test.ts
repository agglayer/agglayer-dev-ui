// S58a M6: `stop --drain` sends one SIGINT. tsx's child preflight exits the process (code 130)
// when no SIGINT listener exists, and the runner used to hold one only around the main loop:
// a SIGINT during the 1-5 min of preflight / harness start-up, or while the report is written
// after the loop, killed the run with no `results.json` and no report. These tests deliver the
// signal at those moments through the real `runLoadTest`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ringModule from './core/ring';
import type { PreflightResult } from './wallets/preflight';

import { runLoadTest } from './runner';
import {
  buildTestDevnetConfig,
  TEST_FUNDER_PRIVATE_KEY,
  TEST_MNEMONIC
} from './wallets/testHelpers';

const mocks = vi.hoisted(() => ({
  /** Called inside the preflight stub (before the main loop). */
  duringPreflight: null as null | (() => void),
  /** Called inside the driver's dispose (after the main loop, before the report is written). */
  duringDispose: null as null | (() => void),
  startedLaps: 0
}));

vi.mock('./wallets/preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPreflight: vi.fn(async () => {
    mocks.duringPreflight?.();
    const ok: PreflightResult = {
      ok: true,
      chains: [],
      assets: [],
      trackerHealthStatus: 'pass',
      failures: [],
      gasTokenChains: {},
      syncToleranceNotes: [],
      table: ''
    };
    return ok;
  })
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
          mocks.startedLaps += 1;
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
    async dispose() {
      mocks.duringDispose?.();
    }
  }
}));

let outDir: string;
let baseline: number;
beforeEach(() => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
  mocks.duringPreflight = null;
  mocks.duringDispose = null;
  mocks.startedLaps = 0;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-sigint-'));
  baseline = process.listenerCount('SIGINT');
});
afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

const fastConfig = () => {
  const base = buildTestDevnetConfig({ usersTotal: 1 });
  return {
    ...base,
    users: { ...base.users, browser: 0 },
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

const run = (logger: (line: string) => void = () => {}) =>
  runLoadTest({
    config: fastConfig(),
    activeAssetIndices: [0],
    configPath: '/nonexistent/loadtest.config.json',
    repoRoot: '/nonexistent-repo-root',
    fund: false,
    mainnetConfirmed: false,
    outDir,
    logger
  });

describe('runLoadTest — SIGINT outside the main loop (S58a M6)', () => {
  it('a SIGINT during preflight is not fatal: the run starts, drains at once and writes its report', async () => {
    let listenersAtPreflight = -1;
    mocks.duringPreflight = () => {
      listenersAtPreflight = process.listenerCount('SIGINT');
      process.emit('SIGINT');
    };
    const lines: string[] = [];
    const result = await run((l) => lines.push(l));

    // tsx exits the process when the listener count is 0: it must be above the baseline here.
    expect(listenersAtPreflight).toBeGreaterThan(baseline);
    expect(result.aborted).toBe(true);
    expect(result.abortCause).toBe('sigint');
    // Stop-before-start: no lap was launched after the operator asked to drain.
    expect(mocks.startedLaps).toBe(0);
    expect(fs.existsSync(result.resultsPath)).toBe(true);
    expect(fs.existsSync(result.summaryPath)).toBe(true);
    expect(lines.join('\n')).toMatch(/SIGINT received/);
  });

  it('a SIGINT while the report is being written (after the main loop) is absorbed, not fatal', async () => {
    let listenersAtDispose = -1;
    mocks.duringDispose = () => {
      listenersAtDispose = process.listenerCount('SIGINT');
      process.emit('SIGINT');
    };
    const lines: string[] = [];
    const result = await run((l) => lines.push(l));

    expect(listenersAtDispose).toBeGreaterThan(baseline);
    // The run was a normal duration-elapsed one; the late signal must not relabel or lose it.
    expect(result.aborted).toBe(false);
    expect(fs.existsSync(result.resultsPath)).toBe(true);
    expect(lines.join('\n')).toMatch(/already stopping/);
  });

  it('leaves no SIGINT listener behind, after a normal run or a failed one', async () => {
    await run();
    expect(process.listenerCount('SIGINT')).toBe(baseline);

    mocks.duringPreflight = () => {
      throw new Error('preflight blew up');
    };
    await expect(run()).rejects.toThrow('preflight blew up');
    expect(process.listenerCount('SIGINT')).toBe(baseline);
  });
});

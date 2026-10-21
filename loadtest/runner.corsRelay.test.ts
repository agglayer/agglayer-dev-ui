// `browser.corsRelay` wiring through the real `runLoadTest`: the relay is started only when
// asked for, the UI is built against the relay's loopback URL (not the real proxy), and the
// relay is torn down with the run. Build/serve/browser-pool are stubbed; the relay is real.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreflightResult } from './wallets/preflight';

import { runLoadTest } from './runner';
import {
  buildTestDevnetConfig,
  TEST_FUNDER_PRIVATE_KEY,
  TEST_MNEMONIC
} from './wallets/testHelpers';

const mocks = vi.hoisted(() => ({
  buildUi: vi.fn(async (_options: Record<string, unknown>) => ({ outDir: '/nonexistent-out' })),
  serveUi: vi.fn(async (options: { uiBaseUrl: string }) => ({
    url: options.uiBaseUrl,
    close: async () => undefined
  })),
  browserUserOptions: [] as { aggkitProxyUrl: string }[]
}));

vi.mock('./wallets/preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPreflight: vi.fn(async () => {
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

vi.mock('./ui/build', () => ({ buildUi: mocks.buildUi }));
vi.mock('./ui/serve', () => ({ serveUi: mocks.serveUi }));

vi.mock('./workers/browser/browserUser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BrowserUser: class {
    constructor(options: { aggkitProxyUrl: string }) {
      mocks.browserUserOptions.push(options);
      throw new Error('stub browser launch');
    }
  }
}));

vi.mock('./workers/browser/pool', () => ({
  BrowserPool: class {
    async launch() {}
    async dispose() {}
    livePids() {
      return [];
    }
  }
}));

let outDir: string;
beforeEach(() => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
  mocks.buildUi.mockClear();
  mocks.serveUi.mockClear();
  mocks.browserUserOptions.length = 0;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-corsrelay-'));
});
afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const canConnect = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const browserConfig = async (corsRelay: boolean | undefined) => {
  const base = buildTestDevnetConfig({ usersTotal: 1 });
  const uiPort = await freePort();
  return {
    ...base,
    uiBaseUrl: `http://127.0.0.1:${uiPort}`,
    users: { ...base.users, browser: 1 },
    browser: { ...base.browser, corsRelay },
    output: { ...base.output, activityLog: false }
  };
};

const run = (config: Awaited<ReturnType<typeof browserConfig>>, lines: string[] = []) =>
  runLoadTest({
    config,
    activeAssetIndices: [0],
    configPath: '/nonexistent/loadtest.config.json',
    repoRoot: '/nonexistent-repo-root',
    fund: false,
    mainnetConfirmed: false,
    outDir,
    logger: (line) => lines.push(line)
  });

describe('runLoadTest — browser.corsRelay', () => {
  it('builds the UI against a loopback relay, logs the shim notice, and closes the relay at the end', async () => {
    const lines: string[] = [];
    await expect(run(await browserConfig(true), lines)).rejects.toThrow('stub browser launch');

    expect(mocks.buildUi).toHaveBeenCalledTimes(1);
    const override = mocks.buildUi.mock.calls[0][0].aggkitProxyUrlOverride as string;
    expect(override).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const relayLine = lines.find((line) => line.includes('CORS relay listening'));
    expect(relayLine).toContain(override);
    expect(relayLine).toMatch(/local-only CORS shim/);
    // The page-side tracker poll goes through the relay too, not the real proxy.
    expect(mocks.browserUserOptions[0].aggkitProxyUrl).toBe(override);
    // Relay is down again after the (failed) run.
    expect(await canConnect(Number(new URL(override).port))).toBe(false);
  });

  it('does not start a relay or override the proxy URL by default', async () => {
    const lines: string[] = [];
    const config = await browserConfig(undefined);
    await expect(run(config, lines)).rejects.toThrow('stub browser launch');

    expect(mocks.buildUi.mock.calls[0][0].aggkitProxyUrlOverride).toBeUndefined();
    expect(mocks.browserUserOptions[0].aggkitProxyUrl).toBe(config.aggkitProxyUrl);
    expect(lines.join('\n')).not.toMatch(/CORS relay/);
  });

  it('refuses to run when the UI is already served (the relay URL cannot be applied to it)', async () => {
    const config = await browserConfig(true);
    const existing = http.createServer((_req, res) => res.end('ui'));
    await new Promise<void>((resolve) =>
      existing.listen(Number(new URL(config.uiBaseUrl!).port), '127.0.0.1', () => resolve())
    );
    try {
      await expect(run(config)).rejects.toThrow(
        /browser\.corsRelay is enabled but a UI is already/
      );
      expect(mocks.buildUi).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => existing.close(() => resolve()));
    }
  });

  it('closes the relay when the UI build fails', async () => {
    mocks.buildUi.mockRejectedValueOnce(new Error('stub build failure'));
    const lines: string[] = [];
    await expect(run(await browserConfig(true), lines)).rejects.toThrow('stub build failure');

    const relayLine = lines.find((line) => line.includes('CORS relay listening')) ?? '';
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(relayLine)?.[1]);
    expect(port).toBeGreaterThan(0);
    expect(await canConnect(port)).toBe(false);
  });
});

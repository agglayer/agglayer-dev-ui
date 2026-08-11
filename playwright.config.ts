import { loadEnvConfig } from '@next/env';
import { defineConfig, devices } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';

import { isHexPrivateKey, normalizeEnvValue } from './app/utils/e2eEnv';

loadEnvConfig(process.cwd(), true);

const e2ePrivateKey = normalizeEnvValue(process.env.E2E_PRIVATE_KEY);
const projectId = normalizeEnvValue(process.env.NEXT_PUBLIC_PROJECT_ID);
const rawAggkitBridgeApis = normalizeEnvValue(process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS);

if (!isHexPrivateKey(e2ePrivateKey)) {
  throw new Error('Playwright E2E env invalid: set E2E_PRIVATE_KEY to a valid private key.');
}

if (!projectId) {
  throw new Error('Playwright E2E env invalid: set NEXT_PUBLIC_PROJECT_ID.');
}

if (!rawAggkitBridgeApis) {
  throw new Error(
    'Playwright E2E env invalid: set NEXT_PUBLIC_AGGKIT_BRIDGE_APIS ' +
      '(scripts/kurtosisDevnetEnv.mjs writes this for devnet mode; see README.md#testing).'
  );
}

let parsedAggkitBridgeApis: Record<string, string>;
try {
  parsedAggkitBridgeApis = JSON.parse(rawAggkitBridgeApis) as Record<string, string>;
} catch {
  throw new Error('Playwright E2E env invalid: NEXT_PUBLIC_AGGKIT_BRIDGE_APIS must be valid JSON.');
}

const e2eWalletAddress = privateKeyToAccount(e2ePrivateKey).address;

process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY = e2ePrivateKey;
process.env.NEXT_PUBLIC_E2E_WALLET_ADDRESS = e2eWalletAddress;
process.env.NEXT_PUBLIC_PROJECT_ID = projectId;

process.env.NEXT_PUBLIC_E2E_ENABLED = 'true';

const commonE2EEnv = {
  NEXT_PUBLIC_E2E_ENABLED: 'true',
  NEXT_PUBLIC_E2E_WALLET_ADDRESS: e2eWalletAddress,
  NEXT_PUBLIC_E2E_PRIVATE_KEY: e2ePrivateKey,
  NEXT_PUBLIC_PROJECT_ID: projectId
};

const PARTIAL_FAILURE_PORT = 3100;
// Extra bogus, unresolvable network injected only for the dedicated
// "partial-failure" project's own dev server below -- see
// tests/bridge/partial-failure.spec.ts and design.md §2.4 (partial fan-out
// failure contract) / manual-validation.md §6 for the manually-verified
// equivalent.
const bogusAggkitBridgeApis = JSON.stringify({
  ...parsedAggkitBridgeApis,
  '999': 'http://127.0.0.1:1/aggkitapi'
});

export default defineConfig({
  // Look for test files in the "tests" directory, relative to this configuration file.
  testDir: 'tests',

  // Resolves/deploys the devnet ERC20 used by
  // tests/bridge/erc20-approve-bridge.spec.ts before any spec file runs; a
  // no-op in testnet mode. See tests/e2e/globalSetup.ts.
  globalSetup: './tests/e2e/globalSetup.ts',

  // Fail the build on CI if you accidentally left test.only in the source code.
  forbidOnly: !!process.env.CI,

  // Retry on CI only.
  retries: process.env.CI ? 2 : 0,

  // Run serially to avoid nonce races on shared funded test wallets.
  workers: 1,

  // Reporter to use
  reporter: 'html',

  use: {
    // Base URL to use in actions like `await page.goto('/')`.
    baseURL: 'http://localhost:3000',

    testIdAttribute: 'data-test-id',

    // Collect trace when retrying the failed test.
    trace: 'on-first-retry'
  },
  // Configure projects for major browsers.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // partial-failure.spec.ts needs its own dev server with a different
      // NEXT_PUBLIC_AGGKIT_BRIDGE_APIS value (see the "partial-failure"
      // project below) -- it can't run against this project's shared server.
      testIgnore: [/partial-failure\.spec\.ts$/]
    },
    {
      name: 'partial-failure',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PARTIAL_FAILURE_PORT}` },
      testMatch: [/partial-failure\.spec\.ts$/]
    }
  ],
  // Run your local dev server(s) before starting the tests.
  webServer: [
    {
      command: 'pnpm run dev',
      env: commonE2EEnv,
      url: 'http://localhost:3000',
      // Always restart so the dev server picks up E2E-specific public env values.
      reuseExistingServer: !process.env.CI
    },
    {
      // Bypasses the `dev` script (which already chains the sync), so this
      // command needs its own public/config.json sync -- see
      // scripts/syncPublicConfig.mjs and design.md §1.4.
      command: `node ./scripts/syncPublicConfig.mjs && pnpm exec next dev -p ${PARTIAL_FAILURE_PORT}`,
      env: {
        ...commonE2EEnv,
        NEXT_PUBLIC_AGGKIT_BRIDGE_APIS: bogusAggkitBridgeApis,
        // Next 16 refuses a second `next dev` sharing a distDir with a running
        // one (per-distDir flock; see next.config.ts). Give this server its own
        // distDir so it can run alongside the :3000 chromium-project server.
        NEXT_DIST_DIR: '.next-partial-failure'
      },
      url: `http://localhost:${PARTIAL_FAILURE_PORT}`,
      reuseExistingServer: !process.env.CI
    }
  ]
});

import { loadEnvConfig } from '@next/env';
import { defineConfig, devices } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';

import { isHexPrivateKey, normalizeEnvValue } from './app/utils/e2eEnv';

loadEnvConfig(process.cwd(), true);

const e2ePrivateKey = normalizeEnvValue(process.env.E2E_PRIVATE_KEY);
const projectId = normalizeEnvValue(process.env.NEXT_PUBLIC_PROJECT_ID);
const aggkitProxy = normalizeEnvValue(process.env.NEXT_PUBLIC_AGGKIT_PROXY);

if (!isHexPrivateKey(e2ePrivateKey)) {
  throw new Error('Playwright E2E env invalid: set E2E_PRIVATE_KEY to a valid private key.');
}

if (!projectId) {
  throw new Error('Playwright E2E env invalid: set NEXT_PUBLIC_PROJECT_ID.');
}

if (!aggkitProxy) {
  throw new Error(
    'Playwright E2E env invalid: set NEXT_PUBLIC_AGGKIT_PROXY ' +
      '(scripts/kurtosisDevnetEnv.mjs writes this for devnet mode; see README.md#testing).'
  );
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
      use: { ...devices['Desktop Chrome'] }
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
    }
  ]
});

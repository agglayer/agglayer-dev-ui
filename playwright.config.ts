import { loadEnvConfig } from '@next/env';
import { defineConfig, devices } from '@playwright/test';
import { isHexAddress, isHexPrivateKey, normalizeEnvValue } from './app/utils/e2eEnv';

loadEnvConfig(process.cwd(), true);

const e2ePrivateKey = normalizeEnvValue(process.env.E2E_PRIVATE_KEY);
const e2eWalletAddress = normalizeEnvValue(process.env.NEXT_PUBLIC_E2E_WALLET_ADDRESS);
const projectId = normalizeEnvValue(process.env.NEXT_PUBLIC_PROJECT_ID);

if (!isHexPrivateKey(e2ePrivateKey)) {
  throw new Error('Playwright E2E env invalid: set E2E_PRIVATE_KEY to a 32-byte hex key (0x + 64 hex chars).');
}

if (!isHexAddress(e2eWalletAddress)) {
  throw new Error('Playwright E2E env invalid: set NEXT_PUBLIC_E2E_WALLET_ADDRESS to a 20-byte hex address.');
}

if (!projectId) {
  throw new Error('Playwright E2E env invalid: set NEXT_PUBLIC_PROJECT_ID.');
}

process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY = e2ePrivateKey;
process.env.NEXT_PUBLIC_E2E_WALLET_ADDRESS = e2eWalletAddress;
process.env.NEXT_PUBLIC_PROJECT_ID = projectId;

process.env.NEXT_PUBLIC_E2E_ENABLED = 'true';

export default defineConfig({
  // Look for test files in the "tests" directory, relative to this configuration file.
  testDir: 'tests',

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
    trace: 'on-first-retry',
  },
  // Configure projects for major browsers.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Run your local dev server before starting the tests.
  webServer: [
    {
      command: 'npm run dev',
      env: {
        NEXT_PUBLIC_E2E_ENABLED: 'true',
        NEXT_PUBLIC_E2E_WALLET_ADDRESS: e2eWalletAddress,
        NEXT_PUBLIC_E2E_PRIVATE_KEY: e2ePrivateKey,
        NEXT_PUBLIC_PROJECT_ID: projectId,
      },
      url: 'http://localhost:3000',
      // Always restart so the dev server picks up E2E-specific public env values.
      reuseExistingServer: false,
    },
  ],
});

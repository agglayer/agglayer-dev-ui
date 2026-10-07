// Shared test-only fixtures for loadtest/wallets/*.test.ts. Not itself a
// `*.test.ts`/`*.spec.ts` file, so vitest's `loadtest/**/*.{test,spec}.ts`
// include pattern (S04) never picks it up as a suite.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LoadtestConfig } from '../config/schema';

import { deriveDevnetConfig } from '../config/deriveDevnet';
import { parseLoadtestConfig } from '../config/schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../config/__fixtures__');

// The well-known Anvil/Hardhat default test mnemonic — public, funds no
// real value, used throughout the ecosystem's own fixtures. Index 0/1/2
// resolve to the equally well-known 0xf39Fd6.../0x709979.../0x3C44Cd...
// addresses.
export const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

// A fixed, arbitrary private key (viem `generatePrivateKey()` output, not
// derived from TEST_MNEMONIC) used only as the "funder" signer in
// mocked-client tests — kept distinct from any address TEST_MNEMONIC
// derives so a test can assert "the funder never sends to itself" without
// an accidental collision. Not a real/funded key anywhere.
export const TEST_FUNDER_PRIVATE_KEY =
  '0x41fbeb3e3808f03ed148d20f704b052825bd109cca3ddce06eef061041ea076c';

export interface TestConfigOverrides {
  usersTotal?: number;
}

/**
 * Builds a fully-parsed, schema-valid devnet `LoadtestConfig` for wallet
 * tests, wired to `LOADTEST_TEST_MNEMONIC`/`LOADTEST_TEST_FUNDER_KEY` env
 * vars (a test sets these to TEST_MNEMONIC/TEST_FUNDER_PRIVATE_KEY before
 * calling any function that resolves them) rather than the real devnet's
 * env var names, so a test can never accidentally resolve a real secret.
 */
export const buildTestDevnetConfig = (overrides: TestConfigOverrides = {}): LoadtestConfig => {
  const { config } = deriveDevnetConfig({
    repoRoot: '/unused-repo-root-for-tests',
    summaryPath: path.join(FIXTURES_DIR, 'summary.json'),
    ciConfigPath: path.join(FIXTURES_DIR, 'config.ci.devnet.json'),
    env: {}
  });
  const base = config as Record<string, unknown>;
  const baseUsers = base.users as Record<string, unknown>;
  const baseFunder = baseUsers.funder as Record<string, unknown>;

  const merged = {
    ...base,
    users: {
      ...baseUsers,
      total: overrides.usersTotal ?? 3,
      browser: 0,
      wallets: { mnemonicRef: { env: 'LOADTEST_TEST_MNEMONIC' }, startIndex: 0 },
      funder: {
        ...baseFunder,
        privateKeyRef: { env: 'LOADTEST_TEST_FUNDER_KEY' }
      }
    }
  };

  return parseLoadtestConfig(merged);
};

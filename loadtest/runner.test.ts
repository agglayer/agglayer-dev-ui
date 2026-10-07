// R0 (loadtest/REVIEW.md, CRITICAL): the mainnet confirmation gate used to
// live ONLY inside `wallets/fund.ts`'s `fundViaTransfer`, reached only
// `if (options.fund)` — so `run` against an already-funded `env: "mainnet"`
// config broadcast a full load test with NO confirmation and NO --fund
// flag needed at all. This suite proves `runLoadTest` itself now refuses,
// unconditionally, before touching wallets/network/filesystem — the
// regression this finding is about is specifically the `fund: false` case,
// since the `fund: true` case was already covered (indirectly) by
// `wallets/fund.test.ts`'s existing `MAINNET_CONFIRMATION_REQUIRED` tests.
import { describe, expect, it } from 'vitest';

import { MainnetConfirmationRequiredError, runLoadTest } from './runner';
import {
  buildTestDevnetConfig,
  TEST_FUNDER_PRIVATE_KEY,
  TEST_MNEMONIC
} from './wallets/testHelpers';

const setTestSecretEnv = (): void => {
  process.env.LOADTEST_TEST_MNEMONIC = TEST_MNEMONIC;
  process.env.LOADTEST_TEST_FUNDER_KEY = TEST_FUNDER_PRIVATE_KEY;
};

describe('runLoadTest — R0 mainnet confirmation gate', () => {
  it('refuses env "mainnet" with no --fund and no --i-know-this-is-mainnet (the exact R0 repro)', async () => {
    setTestSecretEnv();
    // A devnet-shaped config is enough here: the point under test is
    // runner.ts's OWN gate, checked before any wallet derivation, funding,
    // preflight, or driver work — nothing below the gate should ever run.
    const config = { ...buildTestDevnetConfig(), env: 'mainnet' as const };

    await expect(
      runLoadTest({
        config,
        activeAssetIndices: [0],
        configPath: '/nonexistent/loadtest.config.json',
        repoRoot: '/nonexistent-repo-root',
        fund: false,
        mainnetConfirmed: false,
        outDir: '/nonexistent/out'
      })
    ).rejects.toThrow(MainnetConfirmationRequiredError);
  });

  it('the thrown error names the flag and cites R0, not a generic message', async () => {
    setTestSecretEnv();
    const config = { ...buildTestDevnetConfig(), env: 'mainnet' as const };

    await expect(
      runLoadTest({
        config,
        activeAssetIndices: [0],
        configPath: '/nonexistent/loadtest.config.json',
        repoRoot: '/nonexistent-repo-root',
        fund: false,
        mainnetConfirmed: false,
        outDir: '/nonexistent/out'
      })
    ).rejects.toThrow(/MAINNET_CONFIRMATION_REQUIRED[\s\S]*--i-know-this-is-mainnet/);
  });
});

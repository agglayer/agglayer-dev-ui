import {
  E2E_BACKEND_MODE,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_NATIVE_BRIDGE_AMOUNT,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// L1->L2 manual claim: this devnet's aggkit (v0.11.0-rc17+) has no
// autoclaim component, so an L1->L2 deposit sits READY_TO_CLAIM until a user
// clicks "Claim tokens". This spec asserts that it stays Ready to claim for a
// guard window (so a snapshot that silently reintroduces an autoclaimer is
// noticed), then claims it by hand and reaches CLAIMED ("Completed").
//
// Devnet-only: real Sepolia/Bokuto testnet mode is covered by the other
// specs, so this is skipped rather than asserting devnet-specific behavior.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'The no-autoclaimer manual-claim assertion is devnet-specific (aggkit v0.11.0-rc17+ image); see the comment above.'
);

// Must outlast the old rc8 autoclaim tail (~90s), else a slow autoclaimer slips past the guard.
const NO_AUTOCLAIM_GUARD_WINDOW_MS = 90_000;
const NO_AUTOCLAIM_GUARD_STEP_MS = 10_000;

test('L1→L2 deposit requires a manual claim click to reach Completed', async ({ page }) => {
  // Worst case: ready wait + guard window + waitForReadyAndClaim (ready budget
  // + claim modal budget + Completed budget = 2x claim), +60s margin for the
  // rest of the journey.
  test.setTimeout(
    E2E_CLAIM_TIMEOUT_MS +
      NO_AUTOCLAIM_GUARD_WINDOW_MS +
      (E2E_CLAIM_TIMEOUT_MS + 2 * E2E_CLAIM_TIMEOUT_MS) +
      60_000
  );

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  // Explicit chain-pair selection rather than relying on config.json's
  // defaultFromChainKey/defaultToChainKey (E2E_* env vars are Node-only and
  // never change the app's own default pair).
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await bridgePage.waitForBridgeSuccess();

  const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  const transactionHash = explorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0];
  if (!transactionHash) {
    throw new Error('E2E: could not read the bridge transaction hash from the success view');
  }

  await bridgePage.bridgeSuccessCta.click();

  const row = bridgePage.getTransactionRow(transactionHash);
  await expect(row).toBeVisible();

  const status = bridgePage.getTransactionStatus(transactionHash);

  // useTransactions' own aggressive-refetch burst (app/hooks/useTransactions.ts,
  // TOTAL_REFETCH_TIME) only lasts ~6.5s after submission, so poll-and-refresh
  // until the deposit is Ready to claim.
  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return status.textContent().catch(() => null);
      },
      {
        message: 'Waiting for the deposit to reach Ready to claim',
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toContain('Ready to claim');

  // Guard: with no autoclaimer the deposit must stay Ready to claim.
  for (
    let elapsedMs = 0;
    elapsedMs < NO_AUTOCLAIM_GUARD_WINDOW_MS;
    elapsedMs += NO_AUTOCLAIM_GUARD_STEP_MS
  ) {
    await page.waitForTimeout(NO_AUTOCLAIM_GUARD_STEP_MS);
    await bridgePage.refreshActivity();
    await expect(status).toContainText('Ready to claim');
  }

  await bridgePage.waitForReadyAndClaim(transactionHash, {
    readyTimeoutMs: E2E_CLAIM_TIMEOUT_MS,
    claimTimeoutMs: E2E_CLAIM_TIMEOUT_MS
  });
});

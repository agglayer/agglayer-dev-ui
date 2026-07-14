import { E2E_BACKEND_MODE, E2E_CLAIM_TIMEOUT_MS, E2E_NATIVE_BRIDGE_AMOUNT } from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// BUILT-IN AUTOCLAIM (manual-validation.md §3 / §S12-RV.3): this devnet's
// aggkit image (the `feat-autoclaim-l2-lx` tag) auto-claims L1->L2 deposits
// externally -- independent of the dev-ui and independent of
// bridge-spammer-001 -- typically within ~10-90s of the deposit reaching
// READY_TO_CLAIM. No deposit stays READY_TO_CLAIM long enough to reliably
// drive a "click Claim tokens" UI test: S12 measured a browser-driven click
// still losing the race by as little as 0.36s after readiness, across
// several timed attempts. A manual-claim UI test therefore cannot be written
// against this environment without waiting forever for a state
// (READY_TO_CLAIM that survives a click) that this enclave will not produce.
//
// Instead, this spec asserts the one reachable, deterministic outcome: the
// deposit progresses BRIDGED -> ... -> CLAIMED ("Completed") entirely on its
// own, without this test ever clicking a claim button. `useClaimExecution`'s
// manual-claim code path itself is exercised and asserted correct in the
// (uninstrumented, since it needs live timing races) S12 manual validation,
// not by an automated spec -- see manual-validation.md §3 for that evidence.
//
// Devnet-only: real Sepolia/Bokuto testnet infrastructure has no such
// autoclaimer, so this is skipped rather than asserting a behavior testnet
// mode doesn't have.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'Built-in autoclaim is a devnet-only (aggkit feat-autoclaim-l2-lx image) behavior; see the comment above.'
);

test('L1→L2 deposit reaches Completed via built-in aggkit autoclaim (no manual claim click)', async ({
  page
}) => {
  test.setTimeout(E2E_CLAIM_TIMEOUT_MS + 60_000);

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
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

  // useTransactions' own aggressive-refetch burst (app/hooks/useTransactions.ts,
  // TOTAL_REFETCH_TIME) only lasts ~6.5s after submission -- far shorter than
  // the observed ready-to-claimed window, so this test drives its own
  // poll-and-refresh loop rather than relying on that burst or a fixed sleep.
  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return row.getByText('Completed').isVisible().catch(() => false);
      },
      {
        message: 'Waiting for the built-in aggkit autoclaim to reach Completed (CLAIMED)',
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);
});

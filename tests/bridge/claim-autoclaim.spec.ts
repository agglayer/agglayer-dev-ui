import {
  E2E_BACKEND_MODE,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_NATIVE_BRIDGE_AMOUNT,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// BUILT-IN AUTOCLAIM: this devnet's
// aggkit image (the `feat-autoclaim-l2-lx` tag) auto-claims L1->L2 deposits
// externally -- independent of the dev-ui and independent of
// bridge-spammer-001 -- typically within ~10-90s of the deposit reaching
// READY_TO_CLAIM.
//
// L1->L2 autoclaim regression only; the manual claim path is asserted in
// manual-claim.spec.ts on the L2->L1 route, which is non-autoclaiming by
// configuration (config.json autoclaim.l2_to_l1.expectedAutoclaim: false --
// no [[AutoClaim.Claimers]] targets NetworkID=0 on either aggkit instance)
// rather than by race. This spec asserts the one reachable,
// deterministic outcome on the L1->L2 route: the deposit progresses
// BRIDGED -> ... -> CLAIMED ("Completed") entirely on its own, without this
// test ever clicking a claim button.
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

  // useTransactions' own aggressive-refetch burst (app/hooks/useTransactions.ts,
  // TOTAL_REFETCH_TIME) only lasts ~6.5s after submission -- far shorter than
  // the observed ready-to-claimed window, so this test drives its own
  // poll-and-refresh loop rather than relying on that burst or a fixed sleep.
  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return row
          .getByText('Completed')
          .isVisible()
          .catch(() => false);
      },
      {
        message: 'Waiting for the built-in aggkit autoclaim to reach Completed (CLAIMED)',
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);
});

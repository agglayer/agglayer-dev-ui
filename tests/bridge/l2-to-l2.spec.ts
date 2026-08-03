import {
  E2E_BACKEND_MODE,
  E2E_L2_CHAIN_IDS,
  E2E_L2_TO_L2_CLAIM_TIMEOUT_MS,
  E2E_NATIVE_BRIDGE_AMOUNT
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// L2->L2 (design.md §3/§6.3): devnet-only, needs a second L2 (L2-2, network
// id 2) that testnet mode doesn't have -- E2E_L2_CHAIN_IDS falls back to a
// single-entry array in testnet mode (app/constants/e2e.ts), so this guard
// also protects against that array being too short.
test.skip(
  E2E_BACKEND_MODE !== 'devnet' || E2E_L2_CHAIN_IDS.length < 2,
  'L2->L2 requires a second devnet L2 (E2E_L2_CHAIN_IDS); not available in testnet mode.'
);

const [fromChainId, toChainId] = E2E_L2_CHAIN_IDS;

test('L2-1→L2-2 native bridge reaches Completed via built-in aggkit autoclaim (no manual claim click)', async ({
  page
}) => {
  // 300s budget (E2E_L2_TO_L2_CLAIM_TIMEOUT_MS, design.md §6.1/§6.4): cites
  // the conservative idle-enclave send->claimed figure of ~2m11s (S3c latency
  // table) with a 2.3x margin; S6's busier-enclave sample was ~87s. +60s for
  // everything else in the journey (connect, fill, submit, navigate).
  test.setTimeout(E2E_L2_TO_L2_CLAIM_TIMEOUT_MS + 60_000);

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  // Non-`NEXT_PUBLIC_` env vars aren't inlined into the app bundle, so the
  // app's own default chain pair (config.json's defaultFromChainKey/
  // defaultToChainKey) never reflects E2E_L2_CHAIN_IDS -- every route not
  // matching that default must click both selectors explicitly (design.md
  // §6.1).
  await bridgePage.selectChainPair(fromChainId, toChainId);
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

  // config.json's l2_to_l2 autoclaim grace is 5 minutes measured from first
  // READY_TO_CLAIM (design.md §5.5), but the §3 destination-gate fix means
  // READY_TO_CLAIM now fires only after GER injection, so the real
  // READY->CLAIMED distance is seconds -- the "waiting for auto claim" note
  // (autoclaim-waiting-note) may only be visible for one or two poll cycles
  // before autoclaim wins the race, or not at all if it's caught between
  // refreshes. That sighting is therefore recorded as a best-effort
  // annotation, not a hard assertion -- the one deterministic, non-flaky
  // outcome this spec asserts is the final Completed state, reached without
  // this test ever clicking a claim button.
  let observedWaitingNote = false;

  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        if (!observedWaitingNote) {
          observedWaitingNote = await row
            .getByTestId('autoclaim-waiting-note')
            .isVisible()
            .catch(() => false);
        }
        return row
          .getByText('Completed')
          .isVisible()
          .catch(() => false);
      },
      {
        message: 'Waiting for the built-in aggkit autoclaim to reach Completed (CLAIMED)',
        timeout: E2E_L2_TO_L2_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  test.info().annotations.push({
    type: 'autoclaim-waiting-note-observed',
    description: String(observedWaitingNote)
  });

  // No manual claim click anywhere above -- the L2-1->L2-2 deposit reached
  // Completed entirely via built-in autoclaim.
});

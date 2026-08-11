import {
  E2E_BACKEND_MODE,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_L2_CHAIN_IDS,
  E2E_L2_TO_L2_CLAIM_TIMEOUT_MS,
  E2E_NATIVE_BRIDGE_AMOUNT
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// L2->L2: devnet-only, needs a second L2 (L2-2, network
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
  // L2->L2 leg: E2E_L2_TO_L2_CLAIM_TIMEOUT_MS -- see
  // app/constants/e2e.ts for the measured range this is sized against; the
  // dominant term is L2-1's source-side certificate settlement, not autoclaim.
  // +60s for everything else in the journey (connect, fill, submit, navigate).
  // Plus one E2E_CLAIM_TIMEOUT_MS + 60s for the L1->L2-1 top-up below (the same
  // budget claim-autoclaim.spec.ts and manual-claim.spec.ts use for that same
  // round trip).
  test.setTimeout(E2E_L2_TO_L2_CLAIM_TIMEOUT_MS + 60_000 + E2E_CLAIM_TIMEOUT_MS + 60_000);

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // Top-up (S14 review finding): the L2-1->L2-2 native bridge below spends
  // L2-1's LocalBalanceTree credit for origin-network-0 native ETH, exactly as
  // manual-claim.spec.ts's L2-1->L1 withdrawal does. manual-claim was given its
  // own top-up in S12 after it failed deterministically when it ran right after
  // this spec; this spec was left depending on claim-autoclaim.spec.ts having
  // credited the tree first, which holds only because "claim-autoclaim" sorts
  // before "l2-to-l2". Running this spec alone on a fresh enclave, under a -g
  // filter, under --shard, or after any rename that reorders the suite would
  // revert with LocalBalanceTreeUnderflow -- surfacing as an opaque
  // waitForBridgeSuccess timeout. Fund the credit here instead.
  await bridgePage.fundLocalBalanceTree({
    fromChainId: E2E_FROM_CHAIN_ID,
    toChainId: fromChainId,
    amount: E2E_NATIVE_BRIDGE_AMOUNT,
    claimTimeoutMs: E2E_CLAIM_TIMEOUT_MS
  });

  // fundLocalBalanceTree leaves the browser on the transactions route, so the
  // bridge form's chain selectors aren't on the page -- navigate back before
  // driving the L2->L2 leg's own chain-pair selection.
  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // Non-`NEXT_PUBLIC_` env vars aren't inlined into the app bundle, so the
  // app's own default chain pair (config.json's defaultFromChainKey/
  // defaultToChainKey) never reflects E2E_L2_CHAIN_IDS -- every route not
  // matching that default must click both selectors explicitly.
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
  // READY_TO_CLAIM, but the SDK's destination GER-injection gate means
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

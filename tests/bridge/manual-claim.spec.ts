import {
  E2E_BACKEND_MODE,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_NATIVE_BRIDGE_AMOUNT,
  E2E_PROOF_READY_TIMEOUT_MS,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// L2->L1 manual claim (design.md §3.6/§6.3): config.json's
// autoclaim.l2_to_l1.expectedAutoclaim is false -- no
// `[[AutoClaim.Claimers]]` targets NetworkID=0 on either aggkit instance
// (design.md §3.7/§5.5), so a deposit on this route sits READY_TO_CLAIM
// indefinitely until claimed by hand. That non-autoclaiming-by-configuration
// property (rather than a race that a browser-driven click could lose, as
// on the L1->L2 route -- see claim-autoclaim.spec.ts) is exactly what makes
// this route the one place a real "click Claim tokens" UI test can be
// written deterministically.
//
// Devnet-only: the L1<->L2 pair in claim-autoclaim.spec.ts / native-bridge
// etc. covers testnet mode; this route depends on the devnet-specific
// autoclaim config above.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'L2->L1 non-autoclaiming behavior is devnet-specific config (config.json autoclaim.l2_to_l1); see the comment above.'
);

test('L2-1→L1 native withdrawal requires a manual claim click to reach Completed', async ({
  page
}) => {
  // Ready budget: E2E_PROOF_READY_TIMEOUT_MS (600s ← conservative ~8m34s,
  // design.md §3c criterion 3 / §6.1/§6.4; S6's busier-enclave sample was
  // <=4m21s). Claim-confirm budget: E2E_CLAIM_TIMEOUT_MS (150s, existing
  // devnet claim-confirmation budget, design.md §6.3). +60s the rest of the
  // journey (60s "stays ready" observation window included in that slack).
  // Plus one extra E2E_CLAIM_TIMEOUT_MS + 60s budget for the L1->L2 top-up
  // deposit below (same budget claim-autoclaim.spec.ts uses for that same
  // round trip).
  test.setTimeout(
    E2E_PROOF_READY_TIMEOUT_MS + E2E_CLAIM_TIMEOUT_MS + 60_000 + E2E_CLAIM_TIMEOUT_MS + 60_000
  );

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // Top-up (S12 red-run finding): the L2-1->L1 native withdrawal below calls
  // the bridge contract's bridgeAsset, which -- for any token whose origin
  // network isn't the local one, e.g. native ETH's origin is L1 (network 0)
  // -- decrements AgglayerBridgeL2's per-origin LocalBalanceTree before
  // releasing funds (contracts/sovereignChains/AgglayerBridgeL2.sol
  // _decreaseLocalBalanceTree). That tree is only credited by a *claimed*
  // L1->L2-1 deposit (_increaseLocalBalanceTree), never by L2-1's genesis
  // native allocation, which bypasses the bridge entirely. So unless
  // something else already claimed an L1->L2-1 deposit of at least
  // E2E_NATIVE_BRIDGE_AMOUNT onto L2-1 first, this withdrawal reverts with
  // LocalBalanceTreeUnderflow(originNetwork=0, originToken=0x0, amount,
  // available=0) -- confirmed live via `cast 4byte-decode` against the
  // eth_estimateGas revert data during S12 triage. Depending on
  // claim-autoclaim.spec.ts (which credits exactly one
  // E2E_NATIVE_BRIDGE_AMOUNT, and l2-to-l2.spec.ts which spends exactly one
  // back out) running first and leaving a surplus made this spec order- and
  // enclave-state-dependent -- it deterministically failed whenever it ran
  // right after l2-to-l2.spec.ts in the same enclave (their credit/debit net
  // to exactly zero). Funding its own top-up here makes the assertion this
  // spec exists for -- the manual-claim UI flow -- independent of what else
  // has run against this enclave.
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await bridgePage.waitForBridgeSuccess();

  const topUpExplorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  const topUpTransactionHash = topUpExplorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0];
  if (!topUpTransactionHash) {
    throw new Error(
      'E2E: could not read the top-up deposit transaction hash from the success view'
    );
  }
  await bridgePage.bridgeSuccessCta.click();

  const topUpRow = bridgePage.getTransactionRow(topUpTransactionHash);
  await expect(topUpRow).toBeVisible();

  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return topUpRow
          .getByText('Completed')
          .isVisible()
          .catch(() => false);
      },
      {
        message: 'Waiting for the L1->L2-1 top-up deposit to reach Completed (CLAIMED)',
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  // bridgeSuccessCta (BridgeSuccessView.handleGoToTransactions) does
  // router.push(ROUTES.TRANSACTIONS) -- a real route change, so
  // from-chain-selector (the bridge form, on '/') isn't on the page here.
  // Navigate back before driving the withdrawal leg's own chain-pair
  // selection.
  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // L2-1 -> L1: the reverse of the L1->L2 default pair, so both selectors
  // must be clicked explicitly (design.md §6.1).
  await bridgePage.selectChainPair(E2E_TO_CHAIN_ID, E2E_FROM_CHAIN_ID);
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

  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return status.textContent().catch(() => null);
      },
      {
        message: 'Waiting for the deposit to reach Ready to claim',
        timeout: E2E_PROOF_READY_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toContain('Ready to claim');

  // The core assertion this route exists to make: unlike L1->L2 (which a
  // built-in autoclaimer usually beats a UI click to), this deposit must NOT
  // auto-claim -- it should still read Ready to claim after a full minute.
  for (let elapsedMs = 0; elapsedMs < 60_000; elapsedMs += 10_000) {
    await page.waitForTimeout(10_000);
    await bridgePage.refreshActivity();
    await expect(status).toContainText('Ready to claim');
  }

  await bridgePage.clickClaim(transactionHash);

  await expect(page.getByRole('heading', { name: 'Claim successful' })).toBeVisible({
    timeout: E2E_CLAIM_TIMEOUT_MS
  });
  // Proof the claim transaction hash is present (ClaimResultModal only
  // renders this link when `claimTxHash` is set -- claimResultModal.tsx).
  await expect(page.getByRole('link', { name: /view on explorer/i })).toBeVisible();

  // exact: true -- otherwise this substring-matches both the Modal's own
  // "Close modal" icon button and this CTA's "Close" text (strict-mode
  // violation: two elements resolve).
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await bridgePage.refreshActivity();
  await expect(status).toContainText('Completed');
});

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

// L2->L1 manual claim: the devnet's aggkit (v0.11.0-rc17+) has no autoclaim
// component and config.ci.devnet.json sets expectedAutoclaim: false on every
// route, so a deposit sits READY_TO_CLAIM indefinitely until claimed by hand.
// This route is where the 60s "stays ready" window is asserted alongside the
// real "click Claim tokens" UI flow; claim-l1-to-l2.spec.ts covers L1->L2.
//
// Devnet-only: the L1<->L2 pair in claim-l1-to-l2.spec.ts / native-bridge
// etc. covers testnet mode; this route depends on the devnet having no
// autoclaimer.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'L2->L1 manual-claim behavior assumes the devnet has no autoclaimer; see the comment above.'
);

test('L2-1→L1 native withdrawal requires a manual claim click to reach Completed', async ({
  page
}) => {
  // Ready budget: E2E_PROOF_READY_TIMEOUT_MS (600s ← conservative idle-enclave
  // measurement ~8m34s; a busier enclave sampled <=4m21s). Claim-confirm
  // budget: E2E_CLAIM_TIMEOUT_MS (150s, existing devnet claim-confirmation
  // budget). +60s the rest of the
  // journey (60s "stays ready" observation window included in that slack).
  // Plus two extra E2E_CLAIM_TIMEOUT_MS (ready + claim) + 60s budget for the
  // L1->L2 top-up deposit below (same budget claim-l1-to-l2.spec.ts uses for
  // that same round trip).
  test.setTimeout(
    E2E_PROOF_READY_TIMEOUT_MS +
      E2E_CLAIM_TIMEOUT_MS +
      60_000 +
      E2E_CLAIM_TIMEOUT_MS +
      E2E_CLAIM_TIMEOUT_MS +
      60_000
  );

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // Top-up (S12 red-run finding): the L2-1->L1 native withdrawal below spends
  // L2-1's LocalBalanceTree credit for origin-network-0 native ETH -- see
  // BridgePage.fundLocalBalanceTree for why that credit must be funded here and
  // not inherited from whichever spec ran earlier. This spec deterministically
  // failed whenever it ran right after l2-to-l2.spec.ts in the same enclave
  // (their credit/debit netted to exactly zero); confirmed live via
  // `cast 4byte-decode` against the eth_estimateGas revert data during S12
  // triage. l2-to-l2.spec.ts funds its own credit the same way as of S14.
  await bridgePage.fundLocalBalanceTree({
    fromChainId: E2E_FROM_CHAIN_ID,
    toChainId: E2E_TO_CHAIN_ID,
    amount: E2E_NATIVE_BRIDGE_AMOUNT,
    claimTimeoutMs: E2E_CLAIM_TIMEOUT_MS
  });

  // fundLocalBalanceTree ends on the transactions route (bridgeSuccessCta ->
  // router.push(ROUTES.TRANSACTIONS)), so from-chain-selector (the bridge form,
  // on '/') isn't on the page here. Navigate back before driving the withdrawal
  // leg's own chain-pair selection.
  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // L2-1 -> L1: the reverse of the L1->L2 default pair, so both selectors
  // must be clicked explicitly.
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

  // The core assertion this route exists to make: with no autoclaimer, this
  // deposit must NOT auto-claim -- it should still read Ready to claim after a
  // full minute.
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

  // The row flips to Completed only after the activity refetch picks up the
  // confirmed claim (~20s on aggkit rc17), so give it the claim budget rather
  // than expect's default 5s window (same as BridgePage.waitForReadyAndClaim).
  await bridgePage.refreshActivity();
  await expect(status).toContainText('Completed', { timeout: E2E_CLAIM_TIMEOUT_MS });
});

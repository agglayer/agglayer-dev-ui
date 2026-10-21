import {
  E2E_BRIDGE_SUCCESS_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_NATIVE_BRIDGE_AMOUNT,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

test('bridges native token', async ({ page }) => {
  test.setTimeout(E2E_BRIDGE_SUCCESS_TIMEOUT_MS + 60_000);
  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  // Explicit chain-pair selection rather than relying on config.json's
  // defaultFromChainKey/defaultToChainKey -- keeps this spec
  // independent of whatever the devnet bring-up script wrote as the default.
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await bridgePage.waitForBridgeSuccess();

  await expect(bridgePage.bridgeSuccessCta).toBeVisible();
  await expect(bridgePage.bridgeSuccessExplorerLink).toBeVisible();
  const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  expect(explorerHref).toMatch(/\/tx\/0x[a-fA-F0-9]{64}$/);
});

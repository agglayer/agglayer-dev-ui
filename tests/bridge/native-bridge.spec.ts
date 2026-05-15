import { expect, test } from '@playwright/test';
import { BridgePage } from './models/bridge-page';
import { E2E_NATIVE_BRIDGE_AMOUNT } from '@/app/constants/e2e';

test('bridges native token', async ({ page }) => {
  test.setTimeout(180_000);
  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await bridgePage.waitForBridgeSuccess();

  await expect(bridgePage.bridgeSuccessCta).toBeVisible();
  await expect(bridgePage.bridgeSuccessExplorerLink).toBeVisible();
  const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  expect(explorerHref).toMatch(/\/tx\/0x[a-fA-F0-9]{64}$/);
});

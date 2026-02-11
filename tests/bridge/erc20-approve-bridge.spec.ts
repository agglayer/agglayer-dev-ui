import { expect, test } from '@playwright/test';
import { BridgePage } from './models/bridge-page';
import {
  E2E_ERC20_ADDRESS,
  E2E_ERC20_BRIDGE_AMOUNT,
  E2E_ERC20_DECIMALS,
  E2E_ERC20_NAME,
  E2E_ERC20_SYMBOL,
  E2E_FROM_CHAIN_ID,
} from '@/app/constants/e2e';

test('bridges ERC20 with approval step', async ({ page }) => {
  test.setTimeout(180_000);

  const bridgePage = new BridgePage({ page });
  await bridgePage.seedCustomToken({
    chainId: E2E_FROM_CHAIN_ID,
    address: E2E_ERC20_ADDRESS,
    symbol: E2E_ERC20_SYMBOL,
    name: E2E_ERC20_NAME,
    decimals: E2E_ERC20_DECIMALS,
  });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.openTokenSelector();
  await bridgePage.selectToken(E2E_ERC20_SYMBOL);
  await bridgePage.fillAmount(E2E_ERC20_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await expect(bridgePage.getBridgeStep('approve')).toBeVisible();
  await bridgePage.waitForBridgeSuccess();
  await expect(bridgePage.bridgeSuccessCta).toBeVisible();
  await expect(bridgePage.bridgeSuccessExplorerLink).toBeVisible();
  const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  expect(explorerHref).toMatch(/\/tx\/0x[a-fA-F0-9]{64}$/);
});

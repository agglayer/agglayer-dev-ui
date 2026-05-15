import { expect, test } from '@playwright/test';
import { BridgePage } from './models/bridge-page';
import { E2E_ERC20_ADDRESS, E2E_ERC20_BRIDGE_AMOUNT, E2E_FROM_CHAIN_ID } from '@/app/constants/e2e';
import { type Erc20Metadata, fetchErc20Metadata } from '@/tests/e2e/erc20Metadata';

let erc20: Erc20Metadata;

test.beforeAll(async () => {
  erc20 = await fetchErc20Metadata(E2E_ERC20_ADDRESS);
});

test('bridges ERC20 with approval step', async ({ page }) => {
  test.setTimeout(180_000);

  const bridgePage = new BridgePage({ page });
  await bridgePage.seedCustomToken({
    chainId: E2E_FROM_CHAIN_ID,
    address: E2E_ERC20_ADDRESS,
    symbol: erc20.symbol,
    name: erc20.name,
    decimals: erc20.decimals,
  });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.openTokenSelector();
  await bridgePage.selectToken(erc20.symbol);
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

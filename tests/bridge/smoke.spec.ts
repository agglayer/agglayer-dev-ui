import { expect, test } from '@playwright/test';
import { BridgePage } from './models/bridge-page';
import { shortenAddress } from '@/app/utils/address';
import { E2E_WALLET_ADDRESS } from '@/app/constants/e2e';

test('load the homepage', async ({ page }) => {
  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();

  await expect(bridgePage.bridgeCard).toBeVisible();
});

test('connects wallet and displays the correct address', async ({ page }) => {
  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();

  await expect(bridgePage.walletConnectedBadge).toContainText(shortenAddress(E2E_WALLET_ADDRESS!));
});

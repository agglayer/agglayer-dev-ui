import { expect, test } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import { BridgePage } from './models/bridge-page';
import { shortenAddress } from '@/app/utils/address';
import { ANVIL_DEFAULT_PRIVATE_KEY } from '@/app/constants/e2e';

test('load the homepage', async ({ page }) => {
  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();

  await expect(page.getByTestId('bridge-card')).toBeVisible();
});

test('connects wallet and displays the correct address', async ({ page }) => {
  const bridgePage = new BridgePage({ page });
  const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);

  await bridgePage.navigate();

  await page.getByTestId('connect-wallet').click();
  await expect(page.getByTestId('wallet-connected')).toContainText(shortenAddress(account.address));
});

import { E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID, E2E_WALLET_ADDRESS } from '@/app/constants/e2e';
import { shortenAddress } from '@/app/utils/address';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

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

  // Explicit chain-pair selection rather than relying on config.json's
  // defaultFromChainKey/defaultToChainKey (design.md §6.1) -- also smoke-tests
  // the chain selectors themselves.
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
});

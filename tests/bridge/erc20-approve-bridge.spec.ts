import type { Erc20Metadata } from '@/tests/e2e/erc20Metadata';

import {
  E2E_BRIDGE_SUCCESS_TIMEOUT_MS,
  E2E_ERC20_ADDRESS,
  E2E_ERC20_BRIDGE_AMOUNT,
  E2E_FROM_CHAIN_ID,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { fetchErc20Metadata } from '@/tests/e2e/erc20Metadata';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

let erc20: Erc20Metadata;

test.beforeAll(async () => {
  // In devnet mode this address is resolved/deployed by Playwright's
  // globalSetup (tests/e2e/globalSetup.ts) before any spec file loads; in
  // testnet mode it's the fixed Sepolia USDC address. Either way it must be
  // set by the time this spec runs.
  if (!E2E_ERC20_ADDRESS) {
    throw new Error(
      'E2E_ERC20_ADDRESS is not set. Check tests/e2e/globalSetup.ts logs (devnet mode) or ' +
        'set E2E_ERC20_ADDRESS explicitly.'
    );
  }
  erc20 = await fetchErc20Metadata(E2E_ERC20_ADDRESS);
});

test('bridges ERC20 with approval step', async ({ page }) => {
  test.setTimeout(E2E_BRIDGE_SUCCESS_TIMEOUT_MS + 60_000);
  if (!E2E_ERC20_ADDRESS) {
    throw new Error('E2E_ERC20_ADDRESS is not set (see beforeAll above for how it should be set).');
  }

  const bridgePage = new BridgePage({ page });
  await bridgePage.seedCustomToken({
    chainId: E2E_FROM_CHAIN_ID,
    address: E2E_ERC20_ADDRESS,
    symbol: erc20.symbol,
    name: erc20.name,
    decimals: erc20.decimals
  });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  // Explicit chain-pair selection rather than relying on config.json's
  // defaultFromChainKey/defaultToChainKey.
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
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

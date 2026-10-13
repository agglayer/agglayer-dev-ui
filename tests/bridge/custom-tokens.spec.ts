import type { Erc20Metadata } from '@/tests/e2e/erc20Metadata';

import {
  E2E_BACKEND_MODE,
  E2E_BRIDGE_SUCCESS_TIMEOUT_MS,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_ERC20_ADDRESS,
  E2E_ERC20_BRIDGE_AMOUNT,
  E2E_FROM_CHAIN_ID,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { STORAGE_KEYS } from '@/app/utils/storage';
import { fetchErc20Metadata } from '@/tests/e2e/erc20Metadata';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// Custom tokens + wrapped-token resolution (feat(tokens): resolve wrapped
// versions of custom tokens per network). A custom token is stored under its
// ORIGIN network/address; when "Bridge from" changes, its wrapped version on
// that network is resolved on-chain and cached in a separate localStorage key
// (STORAGE_KEYS.TOKEN_MAPPINGS_CACHE), so it shows up in the selector without
// the user re-adding it.
//
// Devnet-only: a wrapped token only exists on the L2 once an L1->L2 deposit of
// it was claimed there, and this spec relies on the devnet's built-in aggkit
// autoclaim (see claim-autoclaim.spec.ts) to get that without a claim click.
// Each Playwright test gets a fresh browser context, so localStorage starts
// empty and nothing here depends on other specs having run first.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'Wrapped-token resolution depends on the devnet built-in autoclaim; see the comment above.'
);

let erc20: Erc20Metadata;

test.beforeAll(async () => {
  if (!E2E_ERC20_ADDRESS) {
    throw new Error(
      'E2E_ERC20_ADDRESS is not set. Check tests/e2e/globalSetup.ts logs (devnet mode) or ' +
        'set E2E_ERC20_ADDRESS explicitly.'
    );
  }
  erc20 = await fetchErc20Metadata(E2E_ERC20_ADDRESS);
});

test('adds a custom token, then its wrapped version appears on the destination L2 after bridging', async ({
  page
}) => {
  test.setTimeout(E2E_BRIDGE_SUCCESS_TIMEOUT_MS + E2E_CLAIM_TIMEOUT_MS + 120_000);
  if (!E2E_ERC20_ADDRESS) {
    throw new Error('E2E_ERC20_ADDRESS is not set (see beforeAll above for how it should be set).');
  }

  const bridgePage = new BridgePage({ page });
  const originAddress = E2E_ERC20_ADDRESS;

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);

  // 1. Add the ERC20 through the real "Manage tokens" UI (no localStorage seeding).
  await bridgePage.openTokenSelector();
  await page.getByRole('button', { name: 'Manage tokens' }).click();
  await page.getByPlaceholder('0x...').fill(originAddress);
  await page.getByRole('button', { name: `Add ${erc20.symbol} token` }).click();
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(bridgePage.getTokenRow(erc20.symbol)).toBeVisible();

  // Stored as a custom token under its origin network + address.
  const storedCustomTokens = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? '[]') as Array<Record<string, unknown>>,
    STORAGE_KEYS.CUSTOM_TOKENS
  );
  expect(storedCustomTokens).toHaveLength(1);
  expect(storedCustomTokens[0]).toMatchObject({
    chainId: E2E_FROM_CHAIN_ID,
    symbol: erc20.symbol,
    isCustom: true
  });
  expect((storedCustomTokens[0].address as string).toLowerCase()).toBe(originAddress.toLowerCase());

  // 2. Bridge it L1 -> L2 so the L2 bridge deploys its wrapped version, and
  //    wait for the built-in autoclaim to credit it.
  await bridgePage.selectToken(erc20.symbol);
  await bridgePage.fillAmount(E2E_ERC20_BRIDGE_AMOUNT);
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
  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return row
          .getByText('Completed')
          .isVisible()
          .catch(() => false);
      },
      {
        message: 'Waiting for the ERC20 deposit to reach Completed (CLAIMED) via autoclaim',
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  // 3. Switch "Bridge from" to the L2 (full navigation: the transactions route
  //    needs a fresh connect) and open the selector: the wrapped version of the
  //    custom token must be listed without having been added on this network.
  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.selectChainPair(E2E_TO_CHAIN_ID, E2E_FROM_CHAIN_ID);
  await bridgePage.openTokenSelector();
  await expect(bridgePage.getTokenRow(erc20.symbol)).toBeVisible();

  // The resolved mapping lives in its own cache key, separate from the custom
  // tokens, and points at a different address than the origin token.
  const wrappedAddresses = await page.evaluate((key) => {
    const cache = JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<
      string,
      { status: string; wrappedAddress?: string }
    >;
    return Object.values(cache)
      .filter((entry) => entry.status === 'found')
      .map((entry) => entry.wrappedAddress as string);
  }, STORAGE_KEYS.TOKEN_MAPPINGS_CACHE('devnet'));
  expect(wrappedAddresses).toHaveLength(1);
  expect(wrappedAddresses[0].toLowerCase()).not.toBe(originAddress.toLowerCase());

  // 4. The wrapped token is derived, not user-added: the manage view labels it
  //    and typing its address reports it as already present.
  await page.getByRole('button', { name: 'Manage tokens' }).click();
  await expect(page.getByText('Wrapped token', { exact: false })).toBeVisible();
  await page.getByPlaceholder('0x...').fill(wrappedAddresses[0]);
  await expect(page.getByRole('button', { name: 'Already added' })).toBeVisible();

  // Still only the single origin custom token in storage.
  const customTokensAfter = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown[],
    STORAGE_KEYS.CUSTOM_TOKENS
  );
  expect(customTokensAfter).toHaveLength(1);
});

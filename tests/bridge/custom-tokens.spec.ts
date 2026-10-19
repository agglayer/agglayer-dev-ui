import type { Erc20Metadata } from '@/tests/e2e/erc20Metadata';
import type { Page } from '@playwright/test';

import {
  E2E_BACKEND_MODE,
  E2E_BRIDGE_SUCCESS_TIMEOUT_MS,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_ERC20_ADDRESS,
  E2E_ERC20_BRIDGE_AMOUNT,
  E2E_FROM_CHAIN_ID,
  E2E_PRIVATE_KEY,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { STORAGE_KEYS } from '@/app/utils/storage';
import { formatTokenBalance } from '@/app/utils/tokens';
import { getE2EFromChain, getE2EFromChainRpcUrl } from '@/tests/e2e/chainRpc';
import { fetchErc20Metadata } from '@/tests/e2e/erc20Metadata';
import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { BridgePage } from './models/bridge-page';

// Custom tokens + wrapped-token resolution (feat(tokens): resolve wrapped
// versions of custom tokens per network), covering the cases of issue #48:
//   1. add an ERC20 that has a wrapped version on another network -> the
//      wrapped version shows up in that network's token list;
//   2. add the WRAPPED token -> the ORIGINAL token is stored instead;
//   3. add an ERC20 that does not exist -> error, nothing can be added;
//   4. add the native gas token -> no duplicate, still usable.
// A custom token is stored under its ORIGIN network/address; when "Bridge from"
// changes, its wrapped version on that network is resolved on-chain and cached
// in a separate localStorage key (STORAGE_KEYS.TOKEN_MAPPINGS_CACHE).
//
// Cases 1 and 2 need a wrapped token to exist on the L2, which only happens
// once an L1->L2 deposit of it was claimed there, so they share one bridge in
// a single devnet-only test (the deposit is claimed by hand, as the devnet's
// aggkit has no autoclaimer, see claim-l1-to-l2.spec.ts). Cases 3 and 4 are
// fast and mode-agnostic. Each Playwright test gets a fresh browser context,
// so localStorage starts empty and nothing here depends on other specs having
// run first.

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const readCustomTokens = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? '[]') as Array<Record<string, unknown>>,
    STORAGE_KEYS.CUSTOM_TOKENS
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

test('custom token with a wrapped version: it appears on the L2, and adding the wrapped token stores the origin', async ({
  page
}) => {
  test.skip(
    E2E_BACKEND_MODE !== 'devnet',
    'Wrapped-token resolution depends on a devnet L1->L2 claim; see the comment above.'
  );
  // Bridge success + ready wait + claim modal + Completed (2x claim for the
  // claim step, as in waitForReadyAndClaim) + margin for the rest of the journey.
  test.setTimeout(E2E_BRIDGE_SUCCESS_TIMEOUT_MS + 3 * E2E_CLAIM_TIMEOUT_MS + 120_000);
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
  //    claim it by hand (the devnet has no autoclaimer).
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
  await bridgePage.waitForReadyAndClaim(transactionHash, {
    readyTimeoutMs: E2E_CLAIM_TIMEOUT_MS,
    claimTimeoutMs: E2E_CLAIM_TIMEOUT_MS
  });

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
  expect(await readCustomTokens(page)).toHaveLength(1);

  // 5. Case 2: start from a clean slate (the origin token forgotten) and add
  //    the WRAPPED token on the L2 by its address. It must be stored as the
  //    ORIGIN token (L1 chain + origin address), not as a token on the L2.
  await page.evaluate(
    ({ customKey, cacheKey }) => {
      window.localStorage.removeItem(customKey);
      window.localStorage.removeItem(cacheKey);
    },
    {
      customKey: STORAGE_KEYS.CUSTOM_TOKENS,
      cacheKey: STORAGE_KEYS.TOKEN_MAPPINGS_CACHE('devnet')
    }
  );
  await page.reload();
  await bridgePage.connectWallet();
  await bridgePage.selectChainPair(E2E_TO_CHAIN_ID, E2E_FROM_CHAIN_ID);
  await bridgePage.openTokenSelector();
  await expect(bridgePage.getTokenRow(erc20.symbol)).toHaveCount(0);

  await page.getByRole('button', { name: 'Manage tokens' }).click();
  await page.getByPlaceholder('0x...').fill(wrappedAddresses[0]);
  await page.getByRole('button', { name: `Add ${erc20.symbol} token` }).click();
  await page.getByRole('button', { name: 'Back to list' }).click();

  const storedAfterWrappedAdd = await readCustomTokens(page);
  expect(storedAfterWrappedAdd).toHaveLength(1);
  expect(storedAfterWrappedAdd[0]).toMatchObject({ chainId: E2E_FROM_CHAIN_ID, isCustom: true });
  expect((storedAfterWrappedAdd[0].address as string).toLowerCase()).toBe(
    originAddress.toLowerCase()
  );
  // ...and the L2 list still shows it, now as the resolved wrapped version.
  await expect(bridgePage.getTokenRow(erc20.symbol)).toBeVisible();
});

test('custom token that does not exist: shows an error and cannot be added', async ({ page }) => {
  test.setTimeout(90_000);
  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.openTokenSelector();
  await page.getByRole('button', { name: 'Manage tokens' }).click();

  // A well-formed address with no contract behind it: the on-chain ERC20 reads fail.
  await page.getByPlaceholder('0x...').fill(DEAD_ADDRESS);
  await expect(page.getByText('Something went wrong')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /^Add .+ token$/ })).toHaveCount(0);
  expect(await readCustomTokens(page)).toHaveLength(0);
});

test('custom token: adding the native gas token does not duplicate it nor break its balance', async ({
  page
}) => {
  const bridgePage = new BridgePage({ page });
  const chain = getE2EFromChain();
  const account = privateKeyToAccount(E2E_PRIVATE_KEY!);
  const client = createPublicClient({ chain, transport: http(getE2EFromChainRpcUrl()) });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.openTokenSelector();

  // The native token is always listed, without adding anything.
  const symbol = chain.nativeCurrency.symbol;
  await expect(bridgePage.getTokenRow(symbol)).toHaveCount(1);

  // Adding it by its (zero) address: the metadata resolves to the native
  // currency; if the UI offers to add it, doing so must not create a second row.
  await page.getByRole('button', { name: 'Manage tokens' }).click();
  await page.getByPlaceholder('0x...').fill(ZERO_ADDRESS);
  const action = page.getByRole('button', { name: /^(Add .+ token|Already added)$/ });
  await expect(action).toBeVisible({ timeout: 60_000 });
  if (/^Add /.test((await action.textContent()) ?? '')) {
    await action.click();
  }
  await page.getByRole('button', { name: 'Back to list' }).click();

  await expect(bridgePage.getTokenRow(symbol)).toHaveCount(1);
  const rawBalance = await client.getBalance({ address: account.address });
  await expect(bridgePage.getTokenBalance(symbol)).toHaveText(
    formatTokenBalance(
      {
        chainId: chain.id,
        address: ZERO_ADDRESS,
        decimals: chain.nativeCurrency.decimals,
        symbol,
        name: chain.nativeCurrency.name,
        logoURI: '',
        isNative: true
      },
      rawBalance
    )
  );
});

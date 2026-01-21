import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { ANVIL_DEFAULT_PRIVATE_KEY, ANVIL_DEFAULT_RPC_URL } from '@/app/constants/e2e';
import { privateKeyToAccount } from 'viem/accounts';
import { formatTokenBalance } from '@/app/utils/tokens';
import type { Token } from '@/app/types/token';
import { BridgePage } from './models/bridge-page';

const createClient = () =>
  createPublicClient({
    chain: foundry,
    transport: http(ANVIL_DEFAULT_RPC_URL),
  });

const buildNativeToken = (): Token => ({
  chainId: foundry.id,
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  symbol: foundry.nativeCurrency.symbol,
  name: foundry.nativeCurrency.name,
  logoURI: '',
  isNative: true,
});

test('token selector shows token symbol and native balance when wallet is connected', async ({ page }) => {
  const bridgePage = new BridgePage({ page });
  const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
  const client = createClient();

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.openTokenSelector();

  const rawBalance = await client.getBalance({ address: account.address });
  const expectedBalance = formatTokenBalance(buildNativeToken(), rawBalance);

  const tokenRow = bridgePage.getTokenRow(foundry.nativeCurrency.symbol);
  await expect(tokenRow).toBeVisible();
  await expect(tokenRow).toContainText(foundry.nativeCurrency.symbol);

  const balance = bridgePage.getTokenBalance(foundry.nativeCurrency.symbol);
  await expect(balance).toBeVisible();
  await expect(balance).toHaveText(expectedBalance);
});

import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { formatTokenBalance } from '@/app/utils/tokens';
import type { Token } from '@/app/types/token';
import { BridgePage } from './models/bridge-page';
import { E2E_PRIVATE_KEY } from '@/app/constants/e2e';
import { getE2EFromChainRpcUrl } from '@/tests/e2e/testnetRpc';

const createClient = () =>
  createPublicClient({
    chain: sepolia,
    transport: http(getE2EFromChainRpcUrl()),
  });

const buildNativeToken = (): Token => ({
  chainId: sepolia.id,
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  symbol: sepolia.nativeCurrency.symbol,
  name: sepolia.nativeCurrency.name,
  logoURI: '',
  isNative: true,
});

test('token selector shows token symbol and native balance when wallet is connected', async ({ page }) => {
  const bridgePage = new BridgePage({ page });
  const account = privateKeyToAccount(E2E_PRIVATE_KEY);
  const client = createClient();

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.openTokenSelector();

  const rawBalance = await client.getBalance({ address: account.address });
  const expectedBalance = formatTokenBalance(buildNativeToken(), rawBalance);

  const tokenRow = bridgePage.getTokenRow(sepolia.nativeCurrency.symbol);
  await expect(tokenRow).toBeVisible();
  await expect(tokenRow).toContainText(sepolia.nativeCurrency.symbol);

  const balance = bridgePage.getTokenBalance(sepolia.nativeCurrency.symbol);
  await expect(balance).toBeVisible();
  await expect(balance).toHaveText(expectedBalance);
});

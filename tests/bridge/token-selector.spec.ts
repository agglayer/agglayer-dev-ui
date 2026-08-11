import type { Token } from '@/app/types/token';

import { E2E_FROM_CHAIN_ID, E2E_PRIVATE_KEY, E2E_TO_CHAIN_ID } from '@/app/constants/e2e';
import { formatTokenBalance } from '@/app/utils/tokens';
import { getE2EFromChain, getE2EFromChainRpcUrl } from '@/tests/e2e/chainRpc';
import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { BridgePage } from './models/bridge-page';

const createClient = () =>
  createPublicClient({
    chain: getE2EFromChain(),
    transport: http(getE2EFromChainRpcUrl())
  });

const buildNativeToken = (): Token => {
  const chain = getE2EFromChain();
  return {
    chainId: chain.id,
    address: '0x0000000000000000000000000000000000000000',
    decimals: chain.nativeCurrency.decimals,
    symbol: chain.nativeCurrency.symbol,
    name: chain.nativeCurrency.name,
    logoURI: '',
    isNative: true
  };
};

test('token selector shows token symbol and native balance when wallet is connected', async ({
  page
}) => {
  const bridgePage = new BridgePage({ page });
  const account = privateKeyToAccount(E2E_PRIVATE_KEY!);
  const client = createClient();
  const chain = getE2EFromChain();

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  // Explicit chain-pair selection rather than relying on config.json's
  // defaultFromChainKey/defaultToChainKey.
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.openTokenSelector();

  const rawBalance = await client.getBalance({ address: account.address });
  const expectedBalance = formatTokenBalance(buildNativeToken(), rawBalance);

  const tokenRow = bridgePage.getTokenRow(chain.nativeCurrency.symbol);
  await expect(tokenRow).toBeVisible();
  await expect(tokenRow).toContainText(chain.nativeCurrency.symbol);

  const balance = bridgePage.getTokenBalance(chain.nativeCurrency.symbol);
  await expect(balance).toBeVisible();
  await expect(balance).toHaveText(expectedBalance);
});

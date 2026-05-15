import {
  E2E_ERC20_ADDRESS,
  E2E_FROM_CHAIN_ID,
  E2E_PRIVATE_KEY,
  E2E_WALLET_ADDRESS
} from '@/app/constants/e2e';
import { getE2EFromChainRpcUrl } from '@/tests/e2e/testnetRpc';
import { expect, test } from '@playwright/test';
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const createClient = () =>
  createPublicClient({
    chain: sepolia,
    transport: http(getE2EFromChainRpcUrl())
  });

test('testnet preflight: funded wallet and rpc are available', async () => {
  expect(E2E_PRIVATE_KEY).toMatch(/^0x[0-9a-fA-F]{64}$/);

  const client = createClient();
  const chainId = await client.getChainId();
  const account = privateKeyToAccount(E2E_PRIVATE_KEY!);
  const expectedAddress = E2E_WALLET_ADDRESS!;

  expect(chainId).toBe(E2E_FROM_CHAIN_ID);
  expect(account.address.toLowerCase()).toBe(expectedAddress.toLowerCase());

  const nativeBalance = await client.getBalance({ address: account.address });
  expect(nativeBalance).toBeGreaterThan(BigInt(0));

  const tokenBalance = await client.readContract({
    address: E2E_ERC20_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address]
  });

  expect(tokenBalance).toBeGreaterThan(BigInt(0));
});

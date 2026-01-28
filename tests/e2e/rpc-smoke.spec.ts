import { ANVIL_DEFAULT_RPC_URL } from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';

const createClient = () =>
  createPublicClient({
    chain: foundry,
    transport: http(ANVIL_DEFAULT_RPC_URL),
  });

test('anvil rpc is available', async () => {
  const client = createClient();
  const chainId = await client.getChainId();
  const blockNumber = await client.getBlockNumber();

  expect(chainId).toBe(foundry.id);
  expect(blockNumber).toBeGreaterThanOrEqual(BigInt(0));
});

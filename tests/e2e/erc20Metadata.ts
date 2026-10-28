import type { Address } from 'viem';

import { getE2EFromChain, getE2EFromChainRpcUrl } from '@/tests/e2e/chainRpc';
import { createPublicClient, erc20Abi, http } from 'viem';

export interface Erc20Metadata {
  symbol: string;
  name: string;
  decimals: number;
}

export const fetchErc20Metadata = async (address: Address): Promise<Erc20Metadata> => {
  const client = createPublicClient({
    chain: getE2EFromChain(),
    transport: http(getE2EFromChainRpcUrl())
  });

  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })
  ]);

  return { symbol, name, decimals };
};

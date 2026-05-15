import { type Address, createPublicClient, erc20Abi, http } from 'viem';
import { sepolia } from 'viem/chains';
import { getE2EFromChainRpcUrl } from '@/tests/e2e/testnetRpc';

export interface Erc20Metadata {
  symbol: string;
  name: string;
  decimals: number;
}

export const fetchErc20Metadata = async (address: Address): Promise<Erc20Metadata> => {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(getE2EFromChainRpcUrl()),
  });

  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
  ]);

  return { symbol, name, decimals };
};

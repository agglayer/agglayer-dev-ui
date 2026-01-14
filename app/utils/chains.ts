import { AppChain } from '@/app/types/app-mode';

export const getChainById = (chains: AppChain[], chainId: number): AppChain | undefined =>
  chains.find((chain) => chain.id === chainId);

export const getChainByNetworkId = (chains: AppChain[], networkId: number): AppChain | undefined =>
  chains.find((chain) => chain.networkId === networkId);

export const getNetworkId = (chains: AppChain[], chainId: number): number => {
  const chain = getChainById(chains, chainId);
  if (!chain) throw new Error(`Unknown chainId: ${chainId}`);
  return chain.networkId;
};

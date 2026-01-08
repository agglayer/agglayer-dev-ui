import { SUPPORTED_CHAINS } from '@/app/constants/chains';

export const isTestnetChain = (chainId: number): boolean => {
  return SUPPORTED_CHAINS.some((chain) => chain.id === chainId && chain.isTestnet);
};

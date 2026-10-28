import type { AppChain } from '@/app/types/appMode';

export const getChainById = (chains: AppChain[], chainId: number): AppChain | undefined =>
  chains.find((chain) => chain.id === chainId);

export const getChainByNetworkId = (chains: AppChain[], networkId: number): AppChain | undefined =>
  chains.find((chain) => chain.networkId === networkId);

export const getNetworkId = (chains: AppChain[], chainId: number): number => {
  const chain = getChainById(chains, chainId);
  if (!chain) throw new Error(`Unknown chainId: ${chainId}`);
  return chain.networkId;
};

// Picks the right ETA (minutes) for a bridge FROM `chain` given the
// destination's networkId: etaL1Minutes when the destination is L1 (networkId
// 0, a withdrawal), etaL2Minutes for any L2 destination (a deposit, or an
// L2-to-L2 transfer). Same L1-is-networkId-0 convention as
// app/utils/autoclaim.ts's getRouteType.
export const getEtaMinutes = (
  chain: Pick<AppChain, 'etaL1Minutes' | 'etaL2Minutes'>,
  destinationNetworkId: number
): number => (destinationNetworkId === 0 ? chain.etaL1Minutes : chain.etaL2Minutes);

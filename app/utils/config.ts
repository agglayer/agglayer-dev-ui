import type { Chain } from 'wagmi/chains';
import { BRIDGE_HUB_API_BASE_URL } from '@/app/constants/bridge';
import { ICONS } from '@/app/constants/icons';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { AppMode } from '@/app/types/appMode';
import type { ChainEntry, ChainEntryParams } from '@/app/types/config';

export const createChainEntry = (params: ChainEntryParams): ChainEntry => ({
  wagmi: params.wagmi,
  app: {
    id: params.wagmi.id,
    name: params.wagmi.name,
    icon: params.icon,
    explorer: params.explorer ?? params.wagmi.blockExplorers?.default?.url ?? '',
    networkId: params.networkId,
    isTestnet: params.isTestnet,
    rpcUrl: params.rpcUrl ?? params.wagmi.rpcUrls.default.http[0] ?? '',
    eta: params.eta,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: params.wagmi.nativeCurrency.decimals,
      name: params.wagmi.nativeCurrency.name,
      symbol: params.wagmi.nativeCurrency.symbol,
      logoURI: params.nativeLogoURI ?? ICONS.ethereum,
    },
  },
});

export const toNonEmptyChainArray = (chains: Chain[]): readonly [Chain, ...Chain[]] => {
  const [first, ...rest] = chains;
  if (!first) throw new Error('APP_CONFIG_INVALID: no wagmi chains configured');
  return [first, ...rest];
};

export const toProofApiUrl = (mode: AppMode): string => `${BRIDGE_HUB_API_BASE_URL}/${mode}/`;

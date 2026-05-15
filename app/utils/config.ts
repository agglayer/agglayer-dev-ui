import type { ChainEntry, ChainEntryParams, JsonChainConfig } from '@/app/types/config';
import type { Chain } from 'wagmi/chains';

import { ZERO_ADDRESS } from '@/app/types/bridge';

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
      logoURI: params.icon
    }
  }
});

export const toNonEmptyChainArray = (chains: Chain[]): readonly [Chain, ...Chain[]] => {
  const [first, ...rest] = chains;
  if (!first) throw new Error('APP_CONFIG_INVALID: no wagmi chains configured');
  return [first, ...rest];
};

export const toProofApiUrl = (baseUrl: string, suffix: string): string => `${baseUrl}/${suffix}/`;

export const buildWagmiChain = (config: JsonChainConfig): Chain => ({
  id: config.id,
  name: config.name,
  nativeCurrency: config.currency,
  rpcUrls: {
    default: { http: [config.rpcUrl] }
  },
  blockExplorers: {
    default: { name: 'Explorer', url: config.explorerUrl }
  }
});

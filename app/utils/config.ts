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
    // -1 is the "no per-chain override configured" sentinel -- never a valid
    // eta (config/configSchema.mjs's schema enforces min(0)) -- so
    // app/config.ts's buildModeConfig can safely treat it as "fall back to
    // this mode's etaL1Minutes/etaL2Minutes default".
    etaL1Minutes: params.etaL1Minutes ?? -1,
    etaL2Minutes: params.etaL2Minutes ?? -1,
    // '' is the "no per-chain override configured" sentinel -- never a valid
    // address (config/configSchema.mjs's addressString rejects ''), so
    // app/config.ts's buildModeConfig can safely treat it as "fall back to
    // this mode's bridgeAddress".
    bridgeAddress: params.bridgeAddress ?? '',
    nativeBridgeURL: params.nativeBridgeURL,
    nativeCurrency: {
      address: params.nativeCurrencyAddress ?? ZERO_ADDRESS,
      decimals: params.wagmi.nativeCurrency.decimals,
      name: params.wagmi.nativeCurrency.name,
      symbol: params.wagmi.nativeCurrency.symbol,
      logoURI: params.icon,
      wethToken: params.nativeCurrencyWethToken ?? ZERO_ADDRESS
    }
  }
});

export const toNonEmptyChainArray = (chains: Chain[]): readonly [Chain, ...Chain[]] => {
  const [first, ...rest] = chains;
  if (!first) throw new Error('APP_CONFIG_INVALID: no wagmi chains configured');
  return [first, ...rest];
};

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

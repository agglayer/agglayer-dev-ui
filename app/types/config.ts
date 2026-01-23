import type { Chain } from 'wagmi/chains';
import type { AppChain } from '@/app/types/appMode';

export type ChainEntry = {
  wagmi: Chain;
  app: AppChain;
};

export type ChainEntryParams = {
  wagmi: Chain;
  icon: string;
  networkId: number;
  isTestnet: boolean;
  eta: number;
  rpcUrl?: string;
  explorer?: string;
  nativeLogoURI?: string;
};

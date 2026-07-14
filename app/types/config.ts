import type { AppChain } from '@/app/types/appMode';
import type {
  aggkitBridgeApisSchema,
  jsonAppModeConfigSchema,
  jsonChainConfigSchema,
  jsonConfigSchema,
  JsonNativeCurrencyConfigSchema
} from '@/config/configSchema.mjs';
import type { Chain } from 'wagmi/chains';
import type { z } from 'zod';

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
};

export type JsonNativeCurrencyConfig = z.infer<typeof JsonNativeCurrencyConfigSchema>;
export type JsonChainConfig = z.infer<typeof jsonChainConfigSchema>;
export type JsonAppModeConfig = z.infer<typeof jsonAppModeConfigSchema>;
export type JsonConfig = z.infer<typeof jsonConfigSchema>;
export type JsonAggkitBridgeApis = z.infer<typeof aggkitBridgeApisSchema>;

import type { AppChain } from '@/app/types/appMode';
import type {
  aggkitBridgeApisSchema,
  autoclaimConfigSchema,
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

// The three bridge route types, keyed by whether each side is L1 (networkId 0)
// or an L2 (any other networkId). Drives per-route autoclaim UX.
export type RouteType = 'l1_to_l2' | 'l2_to_l1' | 'l2_to_l2';

// Resolved (defaults applied) per-route autoclaim config; `waitForAutoclaimMs`
// is always present after resolution in app/config.ts.
export type AutoclaimRouteConfig = {
  expectedAutoclaim: boolean;
  waitForAutoclaimMs: number;
};

export type AutoclaimConfig = Record<RouteType, AutoclaimRouteConfig>;
export type JsonAutoclaimConfig = z.infer<typeof autoclaimConfigSchema>;

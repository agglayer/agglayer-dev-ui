import type { AppChain } from '@/app/types/appMode';
import type {
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
  // Both optional: config.json's chains.<key>.etaL1Minutes/etaL2Minutes, possibly
  // unset -- app/config.ts's buildModeConfig resolves the enclosing mode's
  // etaL1Minutes/etaL2Minutes fallback, this is not the final value AppChain
  // consumers should read.
  etaL1Minutes?: number;
  etaL2Minutes?: number;
  rpcUrl?: string;
  explorer?: string;
  // Raw per-chain bridgeAddress override from config.json (chains.<key>.bridgeAddress),
  // possibly unset -- app/config.ts's buildModeConfig resolves the mode-level
  // fallback, this is not the final value AppChain consumers should read.
  bridgeAddress?: string;
  // config.json's chains.<key>.currency.address override, possibly unset --
  // app/utils/config.ts's createChainEntry falls back to ZERO_ADDRESS.
  nativeCurrencyAddress?: string;
  // config.json's chains.<key>.currency.wethToken override, possibly unset --
  // app/utils/config.ts's createChainEntry falls back to ZERO_ADDRESS.
  nativeCurrencyWethToken?: string;
  // config.json's chains.<key>.nativeBridgeURL, verbatim, possibly unset.
  nativeBridgeURL?: string;
};

export type JsonNativeCurrencyConfig = z.infer<typeof JsonNativeCurrencyConfigSchema>;
export type JsonChainConfig = z.infer<typeof jsonChainConfigSchema>;
export type JsonAppModeConfig = z.infer<typeof jsonAppModeConfigSchema>;
export type JsonConfig = z.infer<typeof jsonConfigSchema>;

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

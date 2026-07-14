import type { APP_MODES } from '@/config/appModes.mjs';

export type AppMode = (typeof APP_MODES)[number];

export type AppChain = {
  id: number;
  name: string;
  icon: string;
  explorer: string;
  networkId: number;
  isTestnet: boolean;
  rpcUrl: string;
  eta: number;
  nativeCurrency: {
    address: string;
    decimals: number;
    name: string;
    symbol: string;
    logoURI: string;
  };
};

type BaseModeConfig = {
  label: string;
  bridgeAddress: string;
  // Map of L2 networkId -> aggkit REST base URL (no `/bridge/v1` suffix).
  // May be empty for a mode with no aggkit backend configured yet.
  aggkitBridgeApis: Record<number, string>;
};

export type DisabledAppModeConfig = BaseModeConfig & {
  chains: [];
};

export type EnabledAppModeConfig = BaseModeConfig & {
  chains: [AppChain, AppChain, ...AppChain[]];
  defaultFromChainId?: number;
  defaultToChainId?: number;
};

export type AppModeConfig = DisabledAppModeConfig | EnabledAppModeConfig;

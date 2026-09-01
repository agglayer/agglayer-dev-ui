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
  // Estimated minutes for a bridge FROM this chain to become claimable, split
  // by the destination's layer: etaL1Minutes when bridging to L1 (withdrawal),
  // etaL2Minutes when bridging to any L2 (deposit or L2-to-L2 transfer). Use
  // app/utils/chains.ts's getEtaMinutes to pick the right one for a given
  // route -- never read either field directly. Always resolved by
  // app/config.ts's buildModeConfig (chain-level override, else the enclosing
  // mode's default) before an AppChain reaches this array -- -1 here (see
  // app/utils/config.ts's createChainEntry) means "no chain-level override,
  // use the mode's etaL1Minutes/etaL2Minutes" and should never surface past
  // buildModeConfig.
  etaL1Minutes: number;
  etaL2Minutes: number;
  nativeCurrency: {
    address: string;
    decimals: number;
    name: string;
    symbol: string;
    logoURI: string;
    // Resolved config.json chains.<key>.currency.wethToken, or ZERO_ADDRESS
    // when unset. Read by app/hooks/useTokenBalance.ts to source the
    // displayed balance from this ERC-20 instead of the native balance --
    // see that hook and config/configSchema.mjs's wethToken comment. Never
    // affects the bridge deposit itself.
    wethToken: string;
  };
  // Resolved bridge contract address for this chain: config.json's
  // chains.<key>.bridgeAddress override when set, otherwise the enclosing
  // mode's bridgeAddress default. Always resolved by app/config.ts's
  // buildModeConfig before an AppChain reaches this array -- never read the
  // raw, possibly-unset per-chain value directly.
  bridgeAddress: string;
  // config.json's chains.<key>.nativeBridgeURL, verbatim, possibly unset --
  // this chain's own native bridge, needed because the AggLayer bridge can
  // only mint wrapped ETH (wethToken above) here, never native currency. See
  // app/hooks/useBridge.ts's nativeBridgeUrl derivation.
  nativeBridgeURL?: string;
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

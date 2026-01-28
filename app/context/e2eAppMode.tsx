'use client';

import type { ReactNode } from 'react';
import { foundry } from 'viem/chains';
import { ICONS } from '@/app/constants/icons';
import { ANVIL_DEFAULT_RPC_URL } from '@/app/constants/e2e';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { AppChain, AppMode, AppModeConfig } from '@/app/types/appMode';
import { AppModeContext, type AppModeContextValue } from '@/app/context/appMode';

const mode: AppMode = 'devnet';

const E2E_PRIMARY_CHAIN_ID = foundry.id;
const E2E_SECONDARY_CHAIN_ID = foundry.id + 1;
const E2E_CHAIN_ETA_MINUTES = 1;

const e2eChain: AppChain = {
  id: E2E_PRIMARY_CHAIN_ID,
  name: foundry.name,
  icon: ICONS.ethereum,
  explorer: '',
  networkId: E2E_PRIMARY_CHAIN_ID,
  isTestnet: true,
  rpcUrl: ANVIL_DEFAULT_RPC_URL,
  eta: E2E_CHAIN_ETA_MINUTES,
  nativeCurrency: {
    address: ZERO_ADDRESS,
    decimals: foundry.nativeCurrency.decimals,
    name: foundry.nativeCurrency.name,
    symbol: foundry.nativeCurrency.symbol,
    logoURI: ICONS.ethereum,
  },
};

const e2eSecondaryChain: AppChain = {
  ...e2eChain,
  id: E2E_SECONDARY_CHAIN_ID,
  name: `${foundry.name} B`,
  networkId: E2E_SECONDARY_CHAIN_ID,
};

const e2eConfig: AppModeConfig = {
  label: 'E2E',
  bridgeAddress: ZERO_ADDRESS,
  proofApiUrl: ANVIL_DEFAULT_RPC_URL,
  defaultFromChainId: E2E_PRIMARY_CHAIN_ID,
  defaultToChainId: E2E_SECONDARY_CHAIN_ID,
  chains: [e2eChain, e2eSecondaryChain],
};

const e2eValue: AppModeContextValue = {
  mode,
  setMode: () => {},
  enabledModes: [mode],
  config: e2eConfig,
  chains: e2eConfig.chains,
  bridgeAddress: e2eConfig.bridgeAddress,
  defaultFromChainId: E2E_PRIMARY_CHAIN_ID,
  defaultToChainId: E2E_SECONDARY_CHAIN_ID,
};

export const E2EAppModeProvider = ({ children }: { children: ReactNode }) => {
  return <AppModeContext.Provider value={e2eValue}>{children}</AppModeContext.Provider>;
};

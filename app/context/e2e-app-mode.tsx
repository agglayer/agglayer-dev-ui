'use client';

import type { ReactNode } from 'react';
import { foundry } from 'viem/chains';
import { ICONS } from '@/app/constants/icons';
import { ANVIL_DEFAULT_RPC_URL } from '@/app/constants/e2e';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { AppChain, AppMode, AppModeConfig } from '@/app/types/app-mode';
import { AppModeContext, type AppModeContextValue } from '@/app/context/app-mode';

const mode: AppMode = 'devnet';

const e2eChain: AppChain = {
  id: foundry.id,
  name: foundry.name,
  icon: ICONS.ethereum,
  explorer: '',
  networkId: foundry.id,
  isTestnet: true,
  rpcUrl: ANVIL_DEFAULT_RPC_URL,
  nativeCurrency: {
    address: ZERO_ADDRESS,
    decimals: foundry.nativeCurrency.decimals,
    name: foundry.nativeCurrency.name,
    symbol: foundry.nativeCurrency.symbol,
    logoURI: ICONS.ethereum,
  },
};

const e2eConfig: AppModeConfig = {
  label: 'E2E',
  bridgeAddress: ZERO_ADDRESS,
  proofApiUrl: ANVIL_DEFAULT_RPC_URL,
  defaultFromChainId: foundry.id,
  defaultToChainId: foundry.id,
  chains: [e2eChain],
};

const e2eValue: AppModeContextValue = {
  mode,
  setMode: () => {},
  enabledModes: [mode],
  config: e2eConfig,
  chains: e2eConfig.chains,
  bridgeAddress: e2eConfig.bridgeAddress,
  defaultFromChainId: e2eConfig.defaultFromChainId,
  defaultToChainId: e2eConfig.defaultToChainId,
};

export const E2EAppModeProvider = ({ children }: { children: ReactNode }) => {
  return <AppModeContext.Provider value={e2eValue}>{children}</AppModeContext.Provider>;
};

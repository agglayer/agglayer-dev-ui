'use client';

import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';
import { AppChain, AppMode, AppModeConfig } from '@/app/types/app-mode';
import { getEnabledModes } from '@/app/utils/app-mode';
import { APP_MODE_CONFIG, DEFAULT_APP_MODE } from '@/app/config';

type AppModeContextValue = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  enabledModes: AppMode[];
  config: AppModeConfig;
  chains: AppChain[];
  bridgeAddress: string;
  defaultFromChainId: number;
  defaultToChainId: number;
};

const AppModeContext = createContext<AppModeContextValue | null>(null);

const enabledModes = getEnabledModes();
const defaultMode = enabledModes.includes(DEFAULT_APP_MODE) ? DEFAULT_APP_MODE : enabledModes[0] ?? DEFAULT_APP_MODE;

export const AppModeProvider = ({ children }: { children: ReactNode }) => {
  const [mode, setMode] = useState<AppMode>(defaultMode);

  const config = APP_MODE_CONFIG[mode];

  const value = useMemo<AppModeContextValue>(
    () => ({
      mode,
      setMode,
      enabledModes,
      config,
      chains: config.chains,
      bridgeAddress: config.bridgeAddress,
      defaultFromChainId: config.defaultFromChainId,
      defaultToChainId: config.defaultToChainId,
    }),
    [mode, config],
  );

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
};

export const useAppMode = () => {
  const context = useContext(AppModeContext);
  if (!context) throw new Error('useAppMode must be used within AppModeProvider');
  return context;
};

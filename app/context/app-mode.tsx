'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AppChain, AppMode, AppModeConfig } from '@/app/types/app-mode';
import { getEnabledModes, isValidAppMode } from '@/app/utils/app-mode';
import { APP_MODE_CONFIG, DEFAULT_APP_MODE } from '@/app/config';
import { StorageUtils, STORAGE_KEYS } from '@/app/utils/storage';

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

const MODE_EVENT = 'app-mode-change' as const;

const enabledModes = getEnabledModes();
const defaultMode = enabledModes.includes(DEFAULT_APP_MODE) ? DEFAULT_APP_MODE : (enabledModes[0] ?? DEFAULT_APP_MODE);

const resolveStoredMode = (value: unknown): AppMode | null => {
  if (!isValidAppMode(value)) return null;
  if (!enabledModes.includes(value)) return null;
  return value;
};

const getStoredMode = (): AppMode => {
  if (typeof window === 'undefined') return defaultMode;
  const storedMode = StorageUtils.getItem<AppMode>(STORAGE_KEYS.APP_MODE);
  return resolveStoredMode(storedMode) ?? defaultMode;
};

const subscribeToMode = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEYS.APP_MODE) return;
    callback();
  };
  const handleModeChange = () => callback();
  window.addEventListener('storage', handleStorage);
  window.addEventListener(MODE_EVENT, handleModeChange);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(MODE_EVENT, handleModeChange);
  };
};

export const AppModeProvider = ({ children }: { children: ReactNode }) => {
  const mode = useSyncExternalStore(subscribeToMode, getStoredMode, () => defaultMode);

  const setMode = useCallback((nextMode: AppMode) => {
    if (!enabledModes.includes(nextMode)) return;
    if (typeof window === 'undefined') return;

    const current = getStoredMode();
    if (current === nextMode) return;

    const stored = StorageUtils.setItem(STORAGE_KEYS.APP_MODE, nextMode);
    if (!stored) return;

    window.dispatchEvent(new Event(MODE_EVENT));
  }, []);

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
    [mode, setMode, config],
  );

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
};

export const useAppMode = () => {
  const context = useContext(AppModeContext);
  if (!context) throw new Error('useAppMode must be used within AppModeProvider');
  return context;
};

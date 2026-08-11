'use client';

import type { AppChain, AppMode, EnabledAppModeConfig } from '@/app/types/appMode';
import type { ReactNode } from 'react';

import { ConfigErrorScreen } from '@/app/components/appConfigGate';
import { getAppModeConfig, getDefaultAppMode } from '@/app/config';
import { getEnabledModes, isEnabledModeConfig, isValidAppMode } from '@/app/utils/appMode';
import { StorageUtils, STORAGE_KEYS } from '@/app/utils/storage';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

export type AppModeContextValue = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  enabledModes: AppMode[];
  config: EnabledAppModeConfig;
  chains: AppChain[];
  bridgeAddress: string;
  defaultFromChainId: number;
  defaultToChainId: number;
};

export const AppModeContext = createContext<AppModeContextValue | null>(null);

const MODE_EVENT = 'app-mode-change' as const;

// enabledModes/defaultMode used to be module-scope constants computed from
// the eager APP_MODE_CONFIG/DEFAULT_APP_MODE exports. Config is now read
// through accessors that require AppConfigGate to have resolved first, so
// these move into AppModeProvider's render (memoized -- config is immutable
// for the lifetime of the page, design.md §8, so this only ever computes
// once per mount).
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

const createAppModeContextValue = ({
  mode,
  setMode,
  enabledModes,
  config
}: {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  enabledModes: AppMode[];
  config: EnabledAppModeConfig;
}): AppModeContextValue => {
  const [primaryChain, secondaryChain] = config.chains;

  return {
    mode,
    setMode,
    enabledModes,
    config,
    chains: config.chains,
    bridgeAddress: config.bridgeAddress,
    defaultFromChainId: config.defaultFromChainId ?? primaryChain.id,
    defaultToChainId: config.defaultToChainId ?? secondaryChain.id
  };
};

export const AppModeProvider = ({ children }: { children: ReactNode }) => {
  // Config is guaranteed loaded here: AppModeProvider only ever mounts inside
  // AppConfigGate's 'ready' branch (app/providers.tsx). Memoized because
  // config never changes for the lifetime of the page (design.md §8).
  const enabledModes = useMemo(() => getEnabledModes(), []);
  const defaultMode = useMemo(() => {
    const configDefaultMode = getDefaultAppMode();
    return enabledModes.includes(configDefaultMode)
      ? configDefaultMode
      : (enabledModes[0] ?? configDefaultMode);
  }, [enabledModes]);

  const resolveStoredMode = useCallback(
    (value: unknown): AppMode | null => {
      if (!isValidAppMode(value)) return null;
      if (!enabledModes.includes(value)) return null;
      return value;
    },
    [enabledModes]
  );

  const getStoredMode = useCallback((): AppMode => {
    if (typeof window === 'undefined') return defaultMode;
    const storedMode = StorageUtils.getItem<AppMode>(STORAGE_KEYS.APP_MODE);
    return resolveStoredMode(storedMode) ?? defaultMode;
  }, [defaultMode, resolveStoredMode]);

  const getServerMode = useCallback((): AppMode => defaultMode, [defaultMode]);

  const mode = useSyncExternalStore(subscribeToMode, getStoredMode, getServerMode);

  const setMode = useCallback(
    (nextMode: AppMode) => {
      if (!enabledModes.includes(nextMode)) return;
      if (typeof window === 'undefined') return;

      const current = getStoredMode();
      if (current === nextMode) return;

      const stored = StorageUtils.setItem(STORAGE_KEYS.APP_MODE, nextMode);
      if (!stored) return;

      window.dispatchEvent(new Event(MODE_EVENT));
    },
    [enabledModes, getStoredMode]
  );

  const config = getAppModeConfig()[mode];

  const value = useMemo<AppModeContextValue | null>(() => {
    if (!isEnabledModeConfig(config)) return null;
    return createAppModeContextValue({
      mode,
      setMode,
      enabledModes,
      config
    });
  }, [mode, setMode, enabledModes, config]);

  // Unreachable with a validated config (configValidator.mjs rejects any
  // config where every mode has fewer than 2 chainKeys, and defaultMode above
  // always resolves to an enabled mode when at least one exists) -- but
  // rendered as a legible error screen rather than a white page or a thrown
  // exception (design.md §10.1). Loading and outright config-fetch failure
  // are both handled upstream by AppConfigGate; this is the third, residual
  // "disabled" state.
  if (!value) {
    return (
      <ConfigErrorScreen
        message={`APP_MODE_DISABLED: no enabled chains configured for mode "${mode}"`}
        onRetry={() => window.location.reload()}
      />
    );
  }

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
};

export const useAppMode = () => {
  const context = useContext(AppModeContext);
  if (!context) throw new Error('useAppMode must be used within AppModeProvider');
  return context;
};

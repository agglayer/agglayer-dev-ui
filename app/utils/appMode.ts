import { APP_MODE_CONFIG } from '@/app/config';
import { BRIDGE_HUB_API_BASE_URL } from '@/app/constants/api';
import { APP_MODES, AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/appMode';

export const isValidAppMode = (value: unknown): value is AppMode => APP_MODES.some((mode) => mode === value);

export const isEnabledModeConfig = (config: AppModeConfig): config is EnabledAppModeConfig => config?.chains?.length >= 2;

export const getEnabledModes = (): AppMode[] => {
  try {
    return APP_MODES.filter((mode) => {
      const config = APP_MODE_CONFIG[mode];
      return isEnabledModeConfig(config);
    });
  } catch {
    return [];
  }
};

export const getBridgeHubApiBaseUrl = (mode: AppMode): string => {
  return `${BRIDGE_HUB_API_BASE_URL}/${mode}`;
};

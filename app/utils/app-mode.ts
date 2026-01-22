import { APP_MODE_CONFIG, BRIDGE_HUB_API_BASE_URL } from '@/app/config';
import { APP_MODES, AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/app-mode';

export const isValidAppMode = (value: unknown): value is AppMode => APP_MODES.some((mode) => mode === value);

export const isEnabledModeConfig = (config: AppModeConfig): config is EnabledAppModeConfig => config.chains.length >= 2;

export const getEnabledModes = (): AppMode[] => APP_MODES.filter((mode) => isEnabledModeConfig(APP_MODE_CONFIG[mode]));

export const getBridgeHubApiBaseUrl = (mode: AppMode): string => {
  return `${BRIDGE_HUB_API_BASE_URL}/${mode}`;
};

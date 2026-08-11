import type { AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/appMode';

import { getAppModeConfig } from '@/app/config';
import { APP_MODES } from '@/config/appModes.mjs';

export const isValidAppMode = (value: unknown): value is AppMode =>
  APP_MODES.some((mode) => mode === value);

export const isEnabledModeConfig = (config: AppModeConfig): config is EnabledAppModeConfig =>
  config.chains.length >= 2;

export const getEnabledModes = (): AppMode[] =>
  APP_MODES.filter((mode) => isEnabledModeConfig(getAppModeConfig()[mode]));

export const getAggkitBridgeApis = (mode: AppMode): Record<number, string> =>
  getAppModeConfig()[mode].aggkitBridgeApis;

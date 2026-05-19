import type { AppMode, AppModeConfig, EnabledAppModeConfig } from '@/app/types/appMode';

import { APP_MODE_CONFIG } from '@/app/config';
import { APP_MODES } from '@/config/appModes.mjs';

export const isValidAppMode = (value: unknown): value is AppMode =>
  APP_MODES.some((mode) => mode === value);

export const isEnabledModeConfig = (config: AppModeConfig): config is EnabledAppModeConfig =>
  config.chains.length >= 2;

export const getEnabledModes = (): AppMode[] =>
  APP_MODES.filter((mode) => isEnabledModeConfig(APP_MODE_CONFIG[mode]));

export const getProofApiBaseUrl = (mode: AppMode): string => APP_MODE_CONFIG[mode].proofApiUrl;

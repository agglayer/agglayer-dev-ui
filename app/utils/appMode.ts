import { APP_MODE_CONFIG } from '@/app/config';
import { AppMode } from '@/app/types/appMode';

export const getEnabledModes = (): AppMode[] =>
  (Object.keys(APP_MODE_CONFIG) as AppMode[]).filter((mode) => APP_MODE_CONFIG[mode].chains.length > 0);

export const isValidAppMode = (value: unknown): value is AppMode =>
  typeof value === 'string' && value in APP_MODE_CONFIG;

export const getBridgeHubApiBaseUrl = (mode: AppMode): string => {
  const origin = process.env.NEXT_PUBLIC_BRIDGE_HUB_API;
  if (!origin) throw new Error('NEXT_PUBLIC_BRIDGE_HUB_API missing');
  const trimmed = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${trimmed}/${mode}`;
};

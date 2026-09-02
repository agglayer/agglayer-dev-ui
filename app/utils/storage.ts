import type { AppMode } from '@/app/types/appMode';

// Intentionally retained across the aggkit rebrand for localStorage
// backward-compatibility: this prefixes users' saved appMode/customTokens keys.
// Renaming it would orphan existing users' stored data, so a rename requires a
// one-time migration.
const APP_PREFIX = 'bridge-hub-ui';

const getBrowserStorage = (): Storage | null => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }
  return window.localStorage;
};

const createStorageKey = (key: string): string => `${APP_PREFIX}:${key}`;

export const STORAGE_KEYS = {
  APP_MODE: createStorageKey('appMode'),
  CUSTOM_TOKENS: createStorageKey('customTokens'),
  // Map of bridgeHash -> epoch ms when the deposit was first observed
  // READY_TO_CLAIM, so the autoclaim grace period survives refreshes. Scoped
  // per app mode: mainnet/testnet/devnet each have their own networkIds, so
  // the same bridgeHash can otherwise collide across modes (the devnet
  // stale-hash bug).
  AUTOCLAIM_READY_AT: (mode: AppMode): string => createStorageKey(`autoclaimReadyAt:${mode}`)
} as const;

export const StorageUtils = {
  getItem: <T = unknown>(key: string, defaultValue: T | null = null): T | null => {
    const storage = getBrowserStorage();
    if (!storage) return defaultValue;
    try {
      const item = storage.getItem(key);
      return item ? (JSON.parse(item) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  setItem: (key: string, value: unknown): boolean => {
    const storage = getBrowserStorage();
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  removeItem: (key: string): boolean => {
    const storage = getBrowserStorage();
    if (!storage) return false;
    try {
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
};

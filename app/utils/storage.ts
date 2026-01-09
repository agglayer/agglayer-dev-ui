const APP_PREFIX = 'bridge-hub-ui';

const getBrowserStorage = (): Storage | null => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }
  return window.localStorage;
};

const createStorageKey = (key: string): string => `${APP_PREFIX}:${key}`;

export const STORAGE_KEYS = {
  CUSTOM_TOKENS: createStorageKey('customTokens'),
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
  },
};

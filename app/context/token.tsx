'use client';

import type { Token } from '@/app/types/token';
import type { TokenMappingsCache } from '@/app/utils/tokenMappingsCache';
import type { ReactNode } from 'react';

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { getChainById } from '@/app/utils/chains';
import { normalize } from '@/app/utils/format';
import { StorageUtils, STORAGE_KEYS } from '@/app/utils/storage';
import {
  getMappingKey,
  isMappingEntryFresh,
  parseTokenMappingsCache
} from '@/app/utils/tokenMappingsCache';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';

interface TokenContextValue {
  tokens: Token[];
  listTokens: (chainId?: number) => Token[];
  getToken: (chainId: number, address: string) => Token | undefined;
  // Tokens the user added. Each is stored under its origin network + address,
  // never as a wrapped token.
  customTokens: Token[];
  // The wrapped version of each custom token on the other networks, as far as
  // it has been resolved. Derived from customTokens + the mappings cache.
  computedTokens: Token[];
  addCustomToken: (token: Token) => void;
  removeCustomToken: (chainId: number, address: string) => void;
  clearCustomTokens: () => void;
  // Looks up (on-chain, one batched call) which custom tokens have a wrapped
  // version on `chainId` and caches the answer. Skips what is already cached.
  resolveWrappedTokens: (params: { chainId: number }) => Promise<void>;
}

const TokenContext = createContext<TokenContextValue | null>(null);

const generateTokenKey = (chainId: number, address: string) => `${chainId}:${normalize(address)}`;

const TokenProviderInner = ({ children }: { children: ReactNode }) => {
  const { mode, chains } = useAppMode();
  const aggregator = useAggkitAggregator();
  const [customTokens, setCustomTokens] = useState<Token[]>(() => {
    const stored = StorageUtils.getItem<Token[]>(STORAGE_KEYS.CUSTOM_TOKENS, []);
    if (stored && Array.isArray(stored)) {
      return stored.map((token) => ({ ...token, isCustom: true }));
    }
    return [];
  });
  const [mappingsCache, setMappingsCache] = useState<TokenMappingsCache>(() =>
    parseTokenMappingsCache(
      StorageUtils.getItem<unknown>(STORAGE_KEYS.TOKEN_MAPPINGS_CACHE(mode), {})
    )
  );

  // resolveWrappedTokens reads these without depending on them: a dependency
  // on the cache would re-create it after every write and re-trigger callers.
  const mappingsCacheRef = useRef(mappingsCache);
  const inFlightKeysRef = useRef(new Set<string>());

  useEffect(() => {
    StorageUtils.setItem(STORAGE_KEYS.CUSTOM_TOKENS, customTokens);
  }, [customTokens]);

  useEffect(() => {
    mappingsCacheRef.current = mappingsCache;
    StorageUtils.setItem(STORAGE_KEYS.TOKEN_MAPPINGS_CACHE(mode), mappingsCache);
  }, [mappingsCache, mode]);

  // A cache entry only makes sense while the custom token it was resolved from
  // exists: drop the ones whose source was removed.
  useEffect(() => {
    const sources = new Set(
      customTokens.map((token) => generateTokenKey(token.chainId, token.address))
    );
    setMappingsCache((prev) => {
      const kept = Object.entries(prev).filter(([key]) => {
        const [sourceChainId = '', sourceAddress = ''] = key.split(':');
        return sources.has(`${sourceChainId}:${sourceAddress}`);
      });
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [customTokens]);

  const addCustomToken = useCallback((token: Token) => {
    setCustomTokens((prev) => {
      const key = generateTokenKey(token.chainId, token.address);
      const alreadyExists = prev.some((t) => generateTokenKey(t.chainId, t.address) === key);
      if (alreadyExists) return prev;
      return [...prev, { ...token, isCustom: true }];
    });
  }, []);

  const removeCustomToken = useCallback((chainId: number, address: string) => {
    const keyToRemove = generateTokenKey(chainId, address);
    setCustomTokens((prev) =>
      prev.filter((token) => generateTokenKey(token.chainId, token.address) !== keyToRemove)
    );
  }, []);

  const clearCustomTokens = useCallback(() => {
    setCustomTokens([]);
  }, []);

  const computedTokens = useMemo(() => {
    const derived: Token[] = [];
    for (const source of customTokens) {
      for (const chain of chains) {
        if (chain.id === source.chainId) continue;
        const entry =
          mappingsCache[
            getMappingKey({
              sourceChainId: source.chainId,
              sourceAddress: source.address,
              targetChainId: chain.id
            })
          ];
        if (entry?.status !== 'found') continue;
        derived.push({
          ...source,
          chainId: chain.id,
          address: entry.wrappedAddress,
          isCustom: false,
          isComputed: true,
          sourceToken: { chainId: source.chainId, address: source.address }
        });
      }
    }
    return derived;
  }, [customTokens, chains, mappingsCache]);

  const resolveWrappedTokens = useCallback(
    async ({ chainId }: { chainId: number }) => {
      const target = getChainById(chains, chainId);
      if (!target) return;

      const now = Date.now();
      const pending = customTokens.flatMap((token) => {
        const sourceChain = getChainById(chains, token.chainId);
        if (!sourceChain || token.isNative || token.chainId === chainId) return [];
        const key = getMappingKey({
          sourceChainId: token.chainId,
          sourceAddress: token.address,
          targetChainId: chainId
        });
        if (
          isMappingEntryFresh({ entry: mappingsCacheRef.current[key], now }) ||
          inFlightKeysRef.current.has(key)
        ) {
          return [];
        }
        return [
          {
            key,
            origin: { originNetwork: sourceChain.networkId, originTokenAddress: token.address }
          }
        ];
      });
      if (pending.length === 0) return;

      for (const { key } of pending) inFlightKeysRef.current.add(key);
      try {
        const results = await aggregator.getWrappedTokens({
          networkId: target.networkId,
          origins: pending.map(({ origin }) => origin)
        });
        setMappingsCache((prev) => {
          const next = { ...prev };
          pending.forEach(({ key }, index) => {
            const result = results.at(index);
            if (result?.status === 'found') {
              next[key] = {
                status: 'found',
                wrappedAddress: result.wrappedTokenAddress,
                checkedAt: now
              };
            } else if (result?.status === 'absent') {
              next[key] = { status: 'absent', checkedAt: now };
            }
            // An 'error' result is deliberately not cached: it says nothing about
            // whether the wrapped token exists, and the next call retries it.
          });
          return next;
        });
      } catch {
        // The whole lookup failed (RPC down): nothing is cached, the next call retries.
      } finally {
        for (const { key } of pending) inFlightKeysRef.current.delete(key);
      }
    },
    [aggregator, chains, customTokens]
  );

  const { tokens, tokenMap } = useMemo(() => {
    const map = new Map<string, Token>();

    for (const chain of chains) {
      const token: Token = {
        chainId: chain.id,
        address: chain.nativeCurrency.address,
        decimals: chain.nativeCurrency.decimals,
        symbol: chain.nativeCurrency.symbol,
        name: chain.nativeCurrency.name,
        logoURI: chain.nativeCurrency.logoURI || chain.icon,
        isNative: true,
        wethToken: chain.nativeCurrency.wethToken
      };
      map.set(generateTokenKey(token.chainId, token.address), token);
    }

    // Computed first so a token the user added explicitly on that same
    // network (and address) wins over its derived entry.
    for (const token of computedTokens) {
      map.set(generateTokenKey(token.chainId, token.address), token);
    }

    for (const token of customTokens) {
      map.set(generateTokenKey(token.chainId, token.address), token);
    }

    return { tokens: Array.from(map.values()), tokenMap: map };
  }, [chains, customTokens, computedTokens]);

  const listTokens = useCallback(
    (chainId?: number) => {
      if (!chainId) return tokens;
      return tokens.filter((token) => token.chainId === chainId);
    },
    [tokens]
  );

  const getToken = useCallback(
    (chainId: number, address: string) => tokenMap.get(generateTokenKey(chainId, address)),
    [tokenMap]
  );

  const value = useMemo(
    () => ({
      tokens,
      listTokens,
      getToken,
      customTokens,
      computedTokens,
      addCustomToken,
      removeCustomToken,
      clearCustomTokens,
      resolveWrappedTokens
    }),
    [
      tokens,
      listTokens,
      getToken,
      customTokens,
      computedTokens,
      addCustomToken,
      removeCustomToken,
      clearCustomTokens,
      resolveWrappedTokens
    ]
  );

  return <TokenContext.Provider value={value}>{children}</TokenContext.Provider>;
};

// The mappings cache is scoped per app mode (see STORAGE_KEYS), so a mode
// switch remounts the provider to reload it from the new mode's key.
export const TokenProvider = ({ children }: { children: ReactNode }) => {
  const { mode } = useAppMode();
  return <TokenProviderInner key={mode}>{children}</TokenProviderInner>;
};

export const useTokens = () => {
  const context = useContext(TokenContext);
  if (!context) {
    throw new Error('useTokens must be used within TokenProvider');
  }
  return context;
};

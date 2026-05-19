'use client';

import type { Token } from '@/app/types/token';
import type { ReactNode } from 'react';

import { useAppMode } from '@/app/context/appMode';
import { normalize } from '@/app/utils/format';
import { StorageUtils, STORAGE_KEYS } from '@/app/utils/storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface TokenContextValue {
  tokens: Token[];
  listTokens: (chainId?: number) => Token[];
  getToken: (chainId: number, address: string) => Token | undefined;
  customTokens: Token[];
  addCustomToken: (token: Token) => void;
  removeCustomToken: (chainId: number, address: string) => void;
  clearCustomTokens: () => void;
}

const TokenContext = createContext<TokenContextValue | null>(null);

const generateTokenKey = (chainId: number, address: string) => `${chainId}:${normalize(address)}`;

export const TokenProvider = ({ children }: { children: ReactNode }) => {
  const { chains } = useAppMode();
  const [customTokens, setCustomTokens] = useState<Token[]>(() => {
    const stored = StorageUtils.getItem<Token[]>(STORAGE_KEYS.CUSTOM_TOKENS, []);
    if (stored && Array.isArray(stored)) {
      return stored.map((token) => ({ ...token, isCustom: true }));
    }
    return [];
  });

  useEffect(() => {
    StorageUtils.setItem(STORAGE_KEYS.CUSTOM_TOKENS, customTokens);
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
        isNative: true
      };
      map.set(generateTokenKey(token.chainId, token.address), token);
    }

    for (const token of customTokens) {
      map.set(generateTokenKey(token.chainId, token.address), token);
    }

    return { tokens: Array.from(map.values()), tokenMap: map };
  }, [chains, customTokens]);

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
      addCustomToken,
      removeCustomToken,
      clearCustomTokens
    }),
    [
      tokens,
      listTokens,
      getToken,
      customTokens,
      addCustomToken,
      removeCustomToken,
      clearCustomTokens
    ]
  );

  return <TokenContext.Provider value={value}>{children}</TokenContext.Provider>;
};

export const useTokens = () => {
  const context = useContext(TokenContext);
  if (!context) {
    throw new Error('useTokens must be used within TokenProvider');
  }
  return context;
};

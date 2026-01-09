'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { normalize } from '@/app/utils/format';
import { TOKEN_LIST } from '@/app/constants/tokens';
import type { Token } from '@/app/types/token';
import { StorageUtils, STORAGE_KEYS } from '@/app/utils/storage';

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
    setCustomTokens((prev) => prev.filter((token) => generateTokenKey(token.chainId, token.address) !== keyToRemove));
  }, []);

  const clearCustomTokens = useCallback(() => {
    setCustomTokens([]);
  }, []);

  const tokens = useMemo(() => {
    const map = new Map<string, Token>();
    TOKEN_LIST.forEach((token) => {
      map.set(generateTokenKey(token.chainId, token.address), token);
    });
    customTokens.forEach((token) => {
      map.set(generateTokenKey(token.chainId, token.address), { ...token, isCustom: true });
    });
    return Array.from(map.values());
  }, [customTokens]);

  const tokenMap = useMemo(() => {
    const map = new Map<string, Token>();
    for (const token of tokens) {
      map.set(generateTokenKey(token.chainId, token.address), token);
    }
    return map;
  }, [tokens]);

  const listTokens = useCallback(
    (chainId?: number) => {
      if (!chainId) return tokens;
      return tokens.filter((token) => token.chainId === chainId);
    },
    [tokens],
  );

  const getToken = useCallback(
    (chainId: number, address: string) => tokenMap.get(generateTokenKey(chainId, address)),
    [tokenMap],
  );

  const value = useMemo(
    () => ({
      tokens,
      listTokens,
      getToken,
      customTokens,
      addCustomToken,
      removeCustomToken,
      clearCustomTokens,
    }),
    [tokens, listTokens, getToken, customTokens, addCustomToken, removeCustomToken, clearCustomTokens],
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

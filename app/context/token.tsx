'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { normalize } from '@/app/utils/format';
import { TOKEN_LIST } from '@/app/constants/tokens';
import type { Token } from '@/app/types/token';

interface TokenContextValue {
  tokens: Token[];
  listTokens: (chainId?: number) => Token[];
  getToken: (chainId: number, address: string) => Token | undefined;
}

const TokenContext = createContext<TokenContextValue | null>(null);

const generateTokenKey = (chainId: number, address: string) => `${chainId}:${normalize(address)}`;

export const TokenProvider = ({ children }: { children: ReactNode }) => {
  const tokens = TOKEN_LIST;

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
    }),
    [tokens, listTokens, getToken],
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

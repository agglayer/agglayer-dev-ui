'use client';

import type { ReactNode } from 'react';

import { createContext, useCallback, useContext, useState } from 'react';

type RefetchContextValue = {
  aggressiveRefetch: boolean;
  triggerAggressiveRefetch: () => void;
  clearAggressiveRefetch: () => void;
};

const RefetchContext = createContext<RefetchContextValue | null>(null);

export const RefetchProvider = ({ children }: { children: ReactNode }) => {
  const [aggressiveRefetch, setAggressiveRefetch] = useState(false);

  const triggerAggressiveRefetch = useCallback(() => {
    setAggressiveRefetch(true);
  }, []);

  const clearAggressiveRefetch = useCallback(() => {
    setAggressiveRefetch(false);
  }, []);

  return (
    <RefetchContext.Provider
      value={{ aggressiveRefetch, triggerAggressiveRefetch, clearAggressiveRefetch }}
    >
      {children}
    </RefetchContext.Provider>
  );
};

export const useRefetch = () => {
  const context = useContext(RefetchContext);
  if (!context) throw new Error('useRefetch must be used within RefetchProvider');
  return context;
};

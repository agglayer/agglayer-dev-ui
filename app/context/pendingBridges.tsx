'use client';

import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

// Pure safety net: a placeholder is normally dropped by useTransactions the
// moment fetchActivity's response includes a matching transactionHash (see
// that hook's merge). This bound only matters if the tracker/activity
// endpoint never picks the bridge up at all (e.g. an upstream indexing
// failure) -- without it a bad placeholder would otherwise linger in the
// list forever.
const PENDING_BRIDGE_TIMEOUT = 5 * 60 * 1000;

type PendingBridgesContextValue = {
  // Locally-synthesized rows for bridges the user just submitted, kept only
  // until the real activity feed reports the same transactionHash -- see
  // useTransactions.ts's merge. Ordered most-recent-first.
  pendingBridges: Transaction[];
  addPendingBridge: (transaction: Transaction) => void;
  removePendingBridge: (transactionHash: string) => void;
};

const PendingBridgesContext = createContext<PendingBridgesContextValue | null>(null);

// Mounted once at the provider root (see app/providers.tsx) so a placeholder
// added from the bridge form survives navigating to /transactions -- the two
// live in different route trees and don't otherwise share state.
export const PendingBridgesProvider = ({ children }: { children: ReactNode }) => {
  const [pendingBridges, setPendingBridges] = useState<Transaction[]>([]);
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removePendingBridge = useCallback((transactionHash: string) => {
    const key = transactionHash.toLowerCase();
    const timeout = timeoutsRef.current.get(key);
    if (timeout) {
      clearTimeout(timeout);
      timeoutsRef.current.delete(key);
    }
    setPendingBridges((prev) => prev.filter((tx) => tx.transactionHash.toLowerCase() !== key));
  }, []);

  const addPendingBridge = useCallback(
    (transaction: Transaction) => {
      const key = transaction.transactionHash.toLowerCase();
      setPendingBridges((prev) => [
        transaction,
        ...prev.filter((tx) => tx.transactionHash.toLowerCase() !== key)
      ]);

      const existingTimeout = timeoutsRef.current.get(key);
      if (existingTimeout) clearTimeout(existingTimeout);
      timeoutsRef.current.set(
        key,
        setTimeout(() => removePendingBridge(transaction.transactionHash), PENDING_BRIDGE_TIMEOUT)
      );
    },
    [removePendingBridge]
  );

  return (
    <PendingBridgesContext.Provider
      value={{ pendingBridges, addPendingBridge, removePendingBridge }}
    >
      {children}
    </PendingBridgesContext.Provider>
  );
};

export const usePendingBridges = (): PendingBridgesContextValue => {
  const context = useContext(PendingBridgesContext);
  if (!context) throw new Error('usePendingBridges must be used within PendingBridgesProvider');
  return context;
};

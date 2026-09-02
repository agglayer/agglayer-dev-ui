'use client';

import type { Transaction } from '@/app/types/transaction';
import type { AutoclaimGate } from '@/app/utils/autoclaim';

import { getAutoclaimConfig } from '@/app/config';
import { useAppMode } from '@/app/context/appMode';
import {
  computeAutoclaimGate,
  evictReadyAt,
  getRouteType,
  recordReadyAt
} from '@/app/utils/autoclaim';
import { useEffect, useState } from 'react';

// Decides how the claim affordance should render for a READY_TO_CLAIM deposit,
// applying the per-route autoclaim grace period (config.json `autoclaim` ->
// getAutoclaimConfig()). The grace window is measured from when the deposit
// was first observed READY_TO_CLAIM (persisted in localStorage, keyed per app
// mode, so it survives refreshes) and flips 'waiting' -> 'overdue' via a
// one-shot timer.
export const useAutoclaimGate = (transaction: Transaction): AutoclaimGate => {
  const { mode } = useAppMode();
  const routeType = getRouteType(transaction.sourceNetwork, transaction.destinationNetwork);
  const config = getAutoclaimConfig()[routeType];
  const isReadyToClaim = transaction.status === 'READY_TO_CLAIM';
  const active = isReadyToClaim && config.expectedAutoclaim;

  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // The grace period no longer applies once the bridge is claimed --
    // whether it was auto-claimed or claimed manually, its readyAt entry is
    // done and can be evicted rather than lingering until it ages out.
    if (transaction.status === 'CLAIMED') {
      evictReadyAt(mode, transaction.bridgeHash);
    }
    if (!active) {
      setReadyAt(null);
      return;
    }
    setReadyAt(recordReadyAt(mode, transaction.bridgeHash, Date.now()));
    setNow(Date.now());
  }, [active, mode, transaction.bridgeHash, transaction.status]);

  useEffect(() => {
    if (!active || readyAt === null) return;
    const remaining = readyAt + config.waitForAutoclaimMs - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const timeoutId = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timeoutId);
  }, [active, readyAt, config.waitForAutoclaimMs]);

  return computeAutoclaimGate({ config, isReadyToClaim, readyAt, now });
};

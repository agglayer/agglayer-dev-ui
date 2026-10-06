'use client';

import { useTokens } from '@/app/context/token';
import { useEffect } from 'react';

// Resolves, for the network picked in "Bridge from", which of the user's custom
// tokens already have a wrapped version there. `refreshKey` re-runs the lookup
// when it changes (e.g. each time the token selector opens): cached answers
// are skipped by resolveWrappedTokens, so only stale "not deployed yet" ones
// hit the network.
export const useWrappedTokenResolution = (params: { chainId: number; refreshKey?: boolean }) => {
  const { chainId, refreshKey } = params;
  const { resolveWrappedTokens } = useTokens();

  useEffect(() => {
    void resolveWrappedTokens({ chainId });
  }, [resolveWrappedTokens, chainId, refreshKey]);
};

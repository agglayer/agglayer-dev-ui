'use client';

import { useCallback } from 'react';
import { useChainId, useSwitchChain } from 'wagmi';

export const useEnforceCorrectChain = () => {
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(
    async (targetId: number): Promise<void> => {
      if (walletChainId === targetId) return;
      await switchChainAsync({ chainId: targetId });
    },
    [walletChainId, switchChainAsync],
  );
};

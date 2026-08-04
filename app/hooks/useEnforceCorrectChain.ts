'use client';

import { useCallback } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';

export const useEnforceCorrectChain = () => {
  // The connected wallet's actual chain (follows the connector's chainChanged
  // events), NOT useChainId(): wagmi's store chain can diverge from a real
  // extension wallet's per-dapp chain, which makes this guard skip a needed
  // switch and the subsequent send throw ChainMismatch before the wallet is
  // ever asked to sign.
  const { chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(
    async (targetId: number): Promise<void> => {
      if (walletChainId === targetId) return;
      await switchChainAsync({ chainId: targetId });
    },
    [walletChainId, switchChainAsync]
  );
};

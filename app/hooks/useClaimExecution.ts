'use client';

import type { AppChain } from '@/app/types/appMode';
import type {
  ClaimExecutionResult,
  ClaimExecutionState,
  Transaction
} from '@/app/types/transaction';
import type { Hex } from 'viem';

import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useWallet } from '@/app/context/walletContext';
import { useSenderAccount } from '@/app/hooks/useSenderAccount';
import { fetchClaimProof } from '@/app/services/claimProof';
import { isValidEthereumAddress } from '@/app/utils/address';
import {
  buildClaimAssetParams,
  mapTransactionRequest,
  resolveLeafIndex
} from '@/app/utils/transaction';
import { getPublicClient } from '@wagmi/core';
import { useCallback, useState } from 'react';
import { useConfig, useSendTransaction } from 'wagmi';

interface UseClaimExecutionParams {
  bridgeAddress?: string;
  chains: AppChain[];
  onComplete?: (result: ClaimExecutionResult) => void;
}

export const useClaimExecution = (params: UseClaimExecutionParams) => {
  const { bridgeAddress, onComplete } = params;
  const native = useAggNative();
  const config = useConfig();
  const { mode } = useAppMode();
  const { address } = useWallet();
  const senderAccount = useSenderAccount();
  const { sendTransactionAsync } = useSendTransaction();

  const [state, setState] = useState<ClaimExecutionState>({
    isExecuting: false,
    currentStep: 'idle'
  });

  const execute = useCallback(
    async (args: { transaction: Transaction; destinationChainId: number }) => {
      const { transaction, destinationChainId } = args;
      const walletAddress = isValidEthereumAddress(address) ? address : undefined;

      if (!walletAddress || !senderAccount) {
        setState({
          isExecuting: false,
          currentStep: 'error',
          error: { message: 'Wallet not connected' }
        });
        return;
      }

      if (!bridgeAddress) {
        setState({
          isExecuting: false,
          currentStep: 'error',
          error: { message: 'Bridge address not configured' }
        });
        return;
      }

      setState({
        isExecuting: true,
        currentStep: 'claiming',
        transactionId: transaction.hubUID,
        destinationChainId
      });

      let localClaimHash: Hex | undefined;

      try {
        const leafIndex = resolveLeafIndex(transaction);
        const bridge = native.bridge(bridgeAddress, destinationChainId);

        const alreadyClaimed = await bridge.isClaimed({
          leafIndex,
          sourceBridgeNetwork: transaction.sourceNetwork
        });

        if (alreadyClaimed) {
          const error = { message: 'This deposit has already been claimed' };
          setState({
            isExecuting: false,
            currentStep: 'error',
            transactionId: transaction.hubUID,
            destinationChainId,
            error
          });
          onComplete?.({
            status: 'error',
            transactionId: transaction.hubUID,
            destinationChainId,
            error
          });
          return;
        }

        const proof = await fetchClaimProof({
          mode,
          sourceNetworkId: transaction.sourceNetwork,
          leafIndex,
          depositCount: transaction.depositCount
        });

        const claimParams = buildClaimAssetParams({ transaction, proof });
        const claimTx = await bridge.buildClaimAsset(claimParams, walletAddress);

        localClaimHash = await sendTransactionAsync({
          ...mapTransactionRequest(claimTx),
          account: senderAccount,
          chainId: destinationChainId
        });

        setState((prev) => ({ ...prev, claimTxHash: localClaimHash }));

        const publicClient = getPublicClient(config, { chainId: destinationChainId });
        if (!publicClient) {
          throw new Error('Failed to get public client for destination chain');
        }

        const receipt = await publicClient.waitForTransactionReceipt({ hash: localClaimHash });

        if (receipt.status === 'reverted') {
          const error = { message: 'Claim transaction reverted', txHash: localClaimHash };
          setState({
            isExecuting: false,
            currentStep: 'error',
            transactionId: transaction.hubUID,
            destinationChainId,
            claimTxHash: localClaimHash,
            error
          });
          onComplete?.({
            status: 'error',
            transactionId: transaction.hubUID,
            destinationChainId,
            claimTxHash: localClaimHash,
            error
          });
          return;
        }

        setState({
          isExecuting: false,
          currentStep: 'success',
          transactionId: transaction.hubUID,
          destinationChainId,
          claimTxHash: localClaimHash
        });
        onComplete?.({
          status: 'success',
          transactionId: transaction.hubUID,
          destinationChainId,
          claimTxHash: localClaimHash
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Claim failed';
        const errorState = { message, txHash: localClaimHash };
        setState({
          isExecuting: false,
          currentStep: 'error',
          transactionId: transaction.hubUID,
          destinationChainId,
          claimTxHash: localClaimHash,
          error: errorState
        });
        onComplete?.({
          status: 'error',
          transactionId: transaction.hubUID,
          destinationChainId,
          claimTxHash: localClaimHash,
          error: errorState
        });
      }
    },
    [address, bridgeAddress, config, mode, native, onComplete, sendTransactionAsync, senderAccount]
  );

  const reset = useCallback(() => {
    setState({ isExecuting: false, currentStep: 'idle' });
  }, []);

  return { state, execute, reset };
};

'use client';

import type { AppChain } from '@/app/types/appMode';
import type {
  ClaimExecutionResult,
  ClaimExecutionState,
  Transaction
} from '@/app/types/transaction';
import type { Hex } from 'viem';

import { useAggkitAggregator, useAggNative } from '@/app/context/aggLayerSdk';
import { useWallet } from '@/app/context/walletContext';
import { useSenderAccount } from '@/app/hooks/useSenderAccount';
import { toClaimProof } from '@/app/services/claimProof';
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
  chains: AppChain[];
  onComplete?: (result: ClaimExecutionResult) => void;
}

export const useClaimExecution = (params: UseClaimExecutionParams) => {
  const { chains, onComplete } = params;
  const native = useAggNative();
  const aggregator = useAggkitAggregator();
  const config = useConfig();
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

      // The claim always lands on destinationChainId's own (possibly
      // overridden) bridge contract, not the mode-level default -- see
      // app/config.ts's buildModeConfig for how each chain's bridgeAddress is
      // resolved.
      const bridgeAddress = chains.find((chain) => chain.id === destinationChainId)?.bridgeAddress;

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
        // isClaimed's leafIndex is the local deposit index (deposit_count),
        // NOT the L1-info-tree index used for the claim proof below — these
        // are different quantities that only coincide by chance in a
        // single-L2 devnet. resolveLeafIndex now always
        // returns deposit_count; the proof's leaf index comes fresh from
        // getClaimInputs, never from this row.
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

        const { proof: rawProof } = await aggregator.getClaimInputs({
          originNetworkId: transaction.sourceNetwork,
          destinationNetworkId: transaction.destinationNetwork,
          depositCount: transaction.depositCount
        });
        const proof = toClaimProof(rawProof);

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
        // The pre-flight `isClaimed()` check above only rules out the deposit
        // being claimed at the START of this call -- an external claimer
        // (e.g. an autoclaimer racing the same READY_TO_CLAIM deposit) can
        // still land its claim in the few hundred ms it takes us to fetch
        // the proof and estimate gas, so our own claimAsset call reverts
        // on-chain with the bridge's `AlreadyClaimed()` custom error (which
        // viem's default estimateGas error decoding reports as a generic
        // "Execution reverted for an unknown reason" -- confirmed live in S12
        // manual validation by replaying the exact revert selector,
        // `0x646cf558`, against `AlreadyClaimed()`'s signature hash).
        //
        // A single immediate re-check of `isClaimed()` was NOT reliable in
        // that same S12 session: it read back `false` immediately after the
        // revert, while an independent `cast call isClaimed(...)` moments
        // later against the same leafIndex/network read back `true`. Retrying
        // with a short backoff gives the read a chance to catch up with the
        // state the failed estimateGas call already observed, without
        // pretending a single fast re-check is authoritative.
        const bridgeClient = native.bridge(bridgeAddress, destinationChainId);
        const isClaimedParams = {
          leafIndex: resolveLeafIndex(transaction),
          sourceBridgeNetwork: transaction.sourceNetwork
        };
        let raceLostToAnotherClaimer = false;
        for (const delayMs of [0, 400, 1000]) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          raceLostToAnotherClaimer = await bridgeClient
            .isClaimed(isClaimedParams)
            .catch(() => false);
          if (raceLostToAnotherClaimer) break;
        }

        const message = raceLostToAnotherClaimer
          ? 'This deposit has already been claimed'
          : error instanceof Error
            ? error.message
            : 'Claim failed';
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
    [address, aggregator, chains, config, native, onComplete, sendTransactionAsync, senderAccount]
  );

  const reset = useCallback(() => {
    setState({ isExecuting: false, currentStep: 'idle' });
  }, []);

  return { state, execute, reset };
};

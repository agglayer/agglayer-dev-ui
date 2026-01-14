'use client';

import { useCallback, useState } from 'react';
import { type Hex, isHex } from 'viem';
import { usePublicClient, useSendTransaction } from 'wagmi';
import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/app-mode';
import type { BridgeExecutionState } from '@/app/types/bridge';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { Token } from '@/app/types/token';
import { isValidEthereumAddress } from '@/app/utils/address';
import { getNetworkId } from '@/app/utils/chains';
import type { TransactionParams } from '@agglayer/sdk';

export const useBridgeExecution = (params: { fromChainId: number }) => {
  const { fromChainId } = params;
  const native = useAggNative();
  const { chains, bridgeAddress } = useAppMode();
  const publicClient = usePublicClient({ chainId: fromChainId });
  const { sendTransactionAsync } = useSendTransaction();

  const [state, setState] = useState<BridgeExecutionState>({
    isExecuting: false,
    currentStep: 'idle',
  });

  const execute = useCallback(
    async (args: {
      toChainId: number;
      token: Token;
      amountWei: bigint;
      userAddress: Hex;
      destinationAddress?: string;
      needsApproval: boolean;
      isNative: boolean;
    }) => {
      if (!publicClient) {
        setState({
          isExecuting: false,
          currentStep: 'error',
          error: { message: 'Wallet not ready' },
        });
        return;
      }

      setState({ isExecuting: true, currentStep: args.needsApproval ? 'approving' : 'bridging' });

      let localApprovalHash: Hex | undefined;
      let localBridgeHash: Hex | undefined;

      try {
        if (!bridgeAddress || !isValidEthereumAddress(bridgeAddress)) {
          throw new Error('Missing bridge address');
        }

        const recipient =
          args.destinationAddress && isValidEthereumAddress(args.destinationAddress)
            ? args.destinationAddress
            : args.userAddress;

        const destNetworkId = getNetworkId(chains, args.toChainId);

        const tokenAddress = isValidEthereumAddress(args.token.address) ? args.token.address : undefined;
        if (!args.isNative && !tokenAddress) {
          throw new Error('Invalid token address');
        }
        const tokenAddressValue = tokenAddress ?? ZERO_ADDRESS;

        // Approval step (ERC20 only)
        if (args.needsApproval && !args.isNative) {
          const erc20 = native.erc20(tokenAddressValue, fromChainId);
          const approveTx = await erc20.buildApprove(bridgeAddress, args.amountWei.toString(), args.userAddress);

          localApprovalHash = await sendTransactionAsync({
            ...mapTransactionRequest(approveTx, args.userAddress),
            chainId: fromChainId,
          });
          setState((prev) => ({ ...prev, approvalTxHash: localApprovalHash }));

          const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: localApprovalHash });

          if (approvalReceipt.status === 'reverted') {
            setState({
              isExecuting: false,
              currentStep: 'error',
              approvalTxHash: localApprovalHash,
              error: { message: 'Approval transaction reverted', txHash: localApprovalHash },
            });
            return;
          }

          setState((prev) => ({ ...prev, currentStep: 'bridging' }));
        }
        console.log('Bridge', fromChainId, destNetworkId)
        // Bridge step
        const bridgeTx = args.isNative
          ? await native.bridge(bridgeAddress, fromChainId).buildBridgeAsset(
              {
                destinationNetwork: destNetworkId,
                destinationAddress: recipient,
                amount: args.amountWei.toString(),
                token: ZERO_ADDRESS,
                forceUpdateGlobalExitRoot: true,
              },
              args.userAddress,
            )
          : await native.erc20(tokenAddressValue, fromChainId).bridgeTo(
              destNetworkId,
              recipient,
              args.amountWei.toString(),
              args.userAddress,
              { forceUpdateGlobalExitRoot: true },
            );

        localBridgeHash = await sendTransactionAsync({
          ...mapTransactionRequest(bridgeTx, args.userAddress),
          chainId: fromChainId,
        });
        setState((prev) => ({ ...prev, bridgeTxHash: localBridgeHash }));

        const receipt = await publicClient.waitForTransactionReceipt({ hash: localBridgeHash });

        if (receipt.status === 'reverted') {
          setState({
            isExecuting: false,
            currentStep: 'error',
            approvalTxHash: localApprovalHash,
            bridgeTxHash: localBridgeHash,
            error: { message: 'Bridge transaction reverted', txHash: localBridgeHash },
          });
          return;
        }

        setState({
          isExecuting: false,
          currentStep: 'success',
          approvalTxHash: localApprovalHash,
          bridgeTxHash: localBridgeHash,
        });
      } catch (error) {
        console.log('Bridge execution error', error);
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setState({
          isExecuting: false,
          currentStep: 'error',
          approvalTxHash: localApprovalHash,
          bridgeTxHash: localBridgeHash,
          error: { message, txHash: localBridgeHash ?? localApprovalHash },
        });
      }
    },
    [fromChainId, native, publicClient, sendTransactionAsync, chains, bridgeAddress],
  );

  const reset = useCallback(() => {
    setState({ isExecuting: false, currentStep: 'idle' });
  }, []);

  return { state, execute, reset };
};

const mapTransactionRequest = (params: TransactionParams, account: Hex) => {
  const to = isValidEthereumAddress(params.to) ? params.to : undefined;
  if (!to) {
    throw new Error('Invalid transaction recipient');
  }

  const data = isHex(params.data) ? params.data : undefined;
  if (!data) {
    throw new Error('Invalid transaction data');
  }

  return {
    account,
    to,
    data,
    value: toBigInt(params.value),
  };
};

const toBigInt = (value?: string) => {
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

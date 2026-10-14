'use client';

import type { BridgeExecutionState } from '@/app/types/bridge';
import type { Token } from '@/app/types/token';
import type { Hex } from 'viem';

import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useWallet } from '@/app/context/walletContext';
import { useSenderAccount } from '@/app/hooks/useSenderAccount';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import { isValidEthereumAddress } from '@/app/utils/address';
import { getNetworkId } from '@/app/utils/chains';
import { normalize } from '@/app/utils/format';
import { mapTransactionRequest } from '@/app/utils/transaction';
import { useCallback, useState } from 'react';
import { usePublicClient, useSendTransaction } from 'wagmi';

export const useBridgeExecution = (params: { fromChainId: number }) => {
  const { fromChainId } = params;
  const native = useAggNative();
  const { chains } = useAppMode();
  const fromChain = chains.find((chain) => chain.id === fromChainId);
  // The bridge send always targets fromChainId's own (possibly overridden)
  // bridge contract, not the mode-level default -- see app/config.ts's
  // buildModeConfig for how each chain's bridgeAddress is resolved.
  const bridgeAddress = fromChain?.bridgeAddress;
  // config.json's chains.<key>.currency.wethToken, resolved. On a network
  // whose native/gas token isn't ether but a custom gasToken, the AggLayer
  // bridge contract deploys a wrapped-ETH contract at this address (its own
  // `WETHToken` state variable) to represent mainnet ETH bridged in — see
  // AgglayerBridge.sol (agglayer/agglayer-contracts v12.2.3): "WETH address
  // will only be present when the native token is not ether, but another
  // gasToken." Bridging that OUT is `bridgeAsset(token: WETHToken, ...)`,
  // which the contract special-cases into a privileged burn
  // (`_bridgeWrappedAsset` -> `tokenWrapped.burn(msg.sender, amount)`, no
  // ERC20 allowance needed) and REQUIRES msg.value to be 0 (reverts with
  // MsgValueNotZero() otherwise) -- unlike the token === address(0) branch,
  // which requires msg.value to equal amount. Passing this as `token` below
  // is enough: native.bridge(...).buildBridgeAsset derives whether to attach
  // value purely from `token === ZERO_ADDRESS`, so a non-zero token here
  // already omits value on its own, matching the contract's requirement.
  const wethToken =
    fromChain?.nativeCurrency.wethToken &&
    normalize(fromChain.nativeCurrency.wethToken) !== normalize(ZERO_ADDRESS)
      ? fromChain.nativeCurrency.wethToken
      : undefined;
  const { address } = useWallet();
  const senderAccount = useSenderAccount();
  const publicClient = usePublicClient({ chainId: fromChainId });
  const { sendTransactionAsync } = useSendTransaction();

  const [state, setState] = useState<BridgeExecutionState>({
    isExecuting: false,
    currentStep: 'idle'
  });

  const execute = useCallback(
    async (args: {
      toChainId: number;
      token: Token;
      amountWei: bigint;
      destinationAddress?: string;
      needsApproval: boolean;
      isNative: boolean;
    }) => {
      const walletAddress = isValidEthereumAddress(address) ? address : undefined;

      if (!publicClient || !walletAddress || !senderAccount) {
        setState({
          isExecuting: false,
          currentStep: 'error',
          error: { message: 'Wallet not ready' }
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
            : walletAddress;

        const destNetworkId = getNetworkId(chains, args.toChainId);

        const tokenAddress = isValidEthereumAddress(args.token.address)
          ? args.token.address
          : undefined;
        if (!args.isNative && !tokenAddress) {
          throw new Error('Invalid token address');
        }
        const tokenAddressValue = tokenAddress ?? ZERO_ADDRESS;

        // Approval step (ERC20 only)
        if (args.needsApproval && !args.isNative) {
          const erc20 = native.erc20(tokenAddressValue, fromChainId);
          const approveTx = await erc20.buildApprove(
            bridgeAddress,
            args.amountWei.toString(),
            walletAddress
          );

          localApprovalHash = await sendTransactionAsync({
            ...mapTransactionRequest(approveTx),
            account: senderAccount,
            chainId: fromChainId
          });
          setState((prev) => ({ ...prev, approvalTxHash: localApprovalHash }));

          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: localApprovalHash
          });

          if (approvalReceipt.status === 'reverted') {
            setState({
              isExecuting: false,
              currentStep: 'error',
              approvalTxHash: localApprovalHash,
              error: { message: 'Approval transaction reverted', txHash: localApprovalHash }
            });
            return;
          }

          setState((prev) => ({ ...prev, currentStep: 'bridging' }));
        }

        // Bridge step
        const bridgeTx = args.isNative
          ? await native.bridge(bridgeAddress, fromChainId).buildBridgeAsset(
              {
                destinationNetwork: destNetworkId,
                destinationAddress: recipient,
                amount: args.amountWei.toString(),
                token: wethToken ?? ZERO_ADDRESS,
                forceUpdateGlobalExitRoot: true
              },
              walletAddress
            )
          : await native
              .erc20(tokenAddressValue, fromChainId)
              .bridgeTo(destNetworkId, recipient, args.amountWei.toString(), walletAddress, {
                forceUpdateGlobalExitRoot: true
              });

        localBridgeHash = await sendTransactionAsync({
          ...mapTransactionRequest(bridgeTx),
          account: senderAccount,
          chainId: fromChainId
        });
        setState((prev) => ({ ...prev, bridgeTxHash: localBridgeHash }));

        const receipt = await publicClient.waitForTransactionReceipt({ hash: localBridgeHash });

        if (receipt.status === 'reverted') {
          setState({
            isExecuting: false,
            currentStep: 'error',
            approvalTxHash: localApprovalHash,
            bridgeTxHash: localBridgeHash,
            error: { message: 'Bridge transaction reverted', txHash: localBridgeHash }
          });
          return;
        }

        setState({
          isExecuting: false,
          currentStep: 'success',
          approvalTxHash: localApprovalHash,
          bridgeTxHash: localBridgeHash
        });
      } catch (error) {
        // The modal deliberately shows a generic message (see
        // formatErrorMessage) — log the real error so failures are diagnosable.
        console.error('[bridge-execution]', error);
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setState({
          isExecuting: false,
          currentStep: 'error',
          approvalTxHash: localApprovalHash,
          bridgeTxHash: localBridgeHash,
          error: { message, txHash: localBridgeHash ?? localApprovalHash }
        });
      }
    },
    [
      address,
      bridgeAddress,
      chains,
      fromChainId,
      native,
      publicClient,
      sendTransactionAsync,
      senderAccount,
      wethToken
    ]
  );

  const reset = useCallback(() => {
    setState({ isExecuting: false, currentStep: 'idle' });
  }, []);

  return { state, execute, reset };
};

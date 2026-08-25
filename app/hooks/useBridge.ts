'use client';

import type { BridgeValidationError } from '@/app/types/bridge';
import type { Token } from '@/app/types/token';

import { useAppMode } from '@/app/context/appMode';
import { useTokens } from '@/app/context/token';
import { useWallet } from '@/app/context/walletContext';
import { useCheckAllowance } from '@/app/hooks/useCheckAllowance';
import { useGasEstimate } from '@/app/hooks/useGasEstimate';
import { useTokenBalance } from '@/app/hooks/useTokenBalance';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import { isValidEthereumAddress } from '@/app/utils/address';
import { isPositive, toWei } from '@/app/utils/bigNumber';
import { getChainById } from '@/app/utils/chains';
import { normalize } from '@/app/utils/format';
import { useCallback, useMemo, useState } from 'react';
import { formatUnits } from 'viem';

const resolveInitialToChainId = (
  chains: { id: number }[],
  fromChainId: number,
  defaultToChainId: number
): number => {
  if (defaultToChainId !== fromChainId) return defaultToChainId;
  const alternative = chains.find((chain) => chain.id !== fromChainId);
  return alternative?.id ?? fromChainId;
};

export const useBridge = () => {
  const { chains, defaultFromChainId, defaultToChainId } = useAppMode();
  const { listTokens } = useTokens();
  const { address, status } = useWallet();

  const [fromChainId, setFromChainId] = useState<number>(defaultFromChainId);
  const [toChainId, setToChainId] = useState<number>(() =>
    resolveInitialToChainId(chains, defaultFromChainId, defaultToChainId)
  );
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | undefined>();
  const [amount, setAmount] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');

  const fromChain = useMemo(() => getChainById(chains, fromChainId), [chains, fromChainId]);
  const toChain = useMemo(() => getChainById(chains, toChainId), [chains, toChainId]);

  const fromTokens = useMemo(() => listTokens(fromChainId), [fromChainId, listTokens]);

  const selectedToken: Token | undefined = useMemo(() => {
    if (!selectedTokenAddress) return fromTokens[0];
    return (
      fromTokens.find((token) => normalize(token.address) === normalize(selectedTokenAddress)) ??
      fromTokens[0]
    );
  }, [fromTokens, selectedTokenAddress]);

  const selectFromChain = useCallback(
    (chainId: number) => {
      if (chainId === toChainId) {
        setToChainId(fromChainId);
      }
      setFromChainId(chainId);
    },
    [fromChainId, toChainId]
  );

  const selectToChain = useCallback(
    (chainId: number) => {
      if (chainId === fromChainId) {
        setFromChainId(toChainId);
      }
      setToChainId(chainId);
    },
    [fromChainId, toChainId]
  );

  const swapChains = useCallback(() => {
    setFromChainId(toChainId);
    setToChainId(fromChainId);
    setSelectedTokenAddress(undefined);
    setAmount('');
  }, [fromChainId, toChainId]);

  const selectToken = useCallback((token: Token) => {
    setSelectedTokenAddress(token.address);
  }, []);

  const setDestination = useCallback((addr: string) => {
    setDestinationAddress(addr);
  }, []);

  const clearDestination = useCallback(() => {
    setDestinationAddress('');
  }, []);

  const isConnected = status === 'connected';
  const walletAddress = useMemo(
    () => (isValidEthereumAddress(address) ? address : undefined),
    [address]
  );

  const { rawBalance, isLoading: isLoadingBalance } = useTokenBalance({
    token: selectedToken,
    userAddress: walletAddress,
    enabled: Boolean(selectedToken && walletAddress)
  });

  const isNative = Boolean(
    selectedToken &&
    (selectedToken.isNative || normalize(selectedToken.address) === normalize(ZERO_ADDRESS))
  );

  // Advisory-only: when bridging native ETH FROM mainnet (networkId 0) TO a
  // chain that declares its own native/canonical bridge (config.json's
  // chains.<key>.nativeBridgeURL), the AggLayer bridge would only mint
  // wrapped ETH there (never that chain's native currency) -- point the user
  // at their native bridge instead if that's what they actually want. Never
  // blocks or otherwise changes the AggLayer bridge flow -- see
  // config/configSchema.mjs's nativeBridgeURL comment.
  const nativeBridgeUrl = useMemo(() => {
    if (!isNative || fromChain?.networkId !== 0) return undefined;
    return toChain?.nativeBridgeURL;
  }, [isNative, fromChain, toChain]);

  const amountWei = useMemo(() => {
    if (!selectedToken || !amount) return BigInt(0);
    return toWei(amount, selectedToken.decimals);
  }, [amount, selectedToken]);

  const tokenAddress = useMemo(() => {
    if (!selectedToken) return ZERO_ADDRESS;
    if (isValidEthereumAddress(selectedToken.address)) return selectedToken.address;
    return ZERO_ADDRESS;
  }, [selectedToken]);

  // ERC20 allowance approval always targets the source chain's bridge
  // contract -- useCheckAllowance below is scoped to fromChainId, so the
  // spender must be that specific chain's (possibly overridden) bridgeAddress,
  // not the mode-level default.
  const spenderAddress = useMemo(() => {
    const address = fromChain?.bridgeAddress;
    if (!address || !isValidEthereumAddress(address)) return undefined;
    return address;
  }, [fromChain]);

  const canCheckAllowance = Boolean(
    !isNative && selectedToken && spenderAddress && walletAddress && amountWei > BigInt(0)
  );

  const {
    needsApproval,
    loading: isLoadingAllowance,
    refetchAllowance
  } = useCheckAllowance({
    token: tokenAddress,
    owner: walletAddress ?? ZERO_ADDRESS,
    spender: spenderAddress ?? ZERO_ADDRESS,
    amount: amountWei,
    enabled: canCheckAllowance,
    chainId: fromChainId
  });

  const feeNeedsApproval = isNative ? false : (needsApproval ?? true);

  const {
    maxAmount,
    feeFormatted,
    isLoading: isGasLoading
  } = useGasEstimate({
    chainId: fromChainId,
    networkId: fromChain?.networkId ?? 0,
    decimals: fromChain?.nativeCurrency.decimals ?? 18,
    needsApproval: feeNeedsApproval,
    enabled: true
  });

  const maxNativeAmount = useMemo(() => {
    if (!isNative || !rawBalance) return '';
    const balance = BigInt(rawBalance);
    const max = balance > maxAmount ? balance - maxAmount : BigInt(0);
    return formatUnits(max, selectedToken?.decimals ?? 18);
  }, [isNative, rawBalance, maxAmount, selectedToken]);

  const validationError = useMemo((): BridgeValidationError | null => {
    if (!walletAddress) return 'NOT_CONNECTED';
    if (!selectedToken) return 'NO_TOKEN_SELECTED';
    if (!amount || !isPositive(amount)) return 'INVALID_AMOUNT';
    if (fromChainId === toChainId) return 'SAME_CHAIN';
    if (destinationAddress && !isValidEthereumAddress(destinationAddress))
      return 'INVALID_DESTINATION';
    if (rawBalance && amountWei > BigInt(rawBalance)) return 'INSUFFICIENT_BALANCE';
    return null;
  }, [
    walletAddress,
    selectedToken,
    amount,
    fromChainId,
    toChainId,
    destinationAddress,
    rawBalance,
    amountWei
  ]);

  return {
    form: {
      fromChainId,
      toChainId,
      amount,
      destinationAddress,
      selectedToken
    },
    derived: {
      chains,
      fromChain,
      toChain,
      fromTokens,
      isConnected,
      walletAddress,
      isNative,
      nativeBridgeUrl
    },
    actions: {
      selectFromChain,
      selectToChain,
      swapChains,
      selectToken,
      setAmount,
      setDestination,
      clearDestination
    },
    status: {
      validationError,
      isValid: validationError === null,
      isLoadingBalance,
      isLoadingAllowance: isNative ? false : isLoadingAllowance,
      needsApproval: isNative ? false : needsApproval
    },
    balance: {
      raw: rawBalance,
      amountWei,
      maxNativeAmount,
      refetchAllowance
    },
    gasEstimate: {
      feeFormatted,
      isLoading: isGasLoading
    }
  };
};

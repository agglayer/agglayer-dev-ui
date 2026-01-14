'use client';

import { useCallback, useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import { useAppMode } from '@/app/context/app-mode';
import { useTokens } from '@/app/context/token';
import { useWallet } from '@/app/context/wallet';
import { useCheckAllowance } from '@/app/hooks/useCheckAllowance';
import { useGasEstimate } from '@/app/hooks/useGasEstimate';
import { useTokenBalance } from '@/app/hooks/useTokenBalance';
import type { BridgeValidationError } from '@/app/types/bridge';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { Token } from '@/app/types/token';
import { isValidEthereumAddress } from '@/app/utils/address';
import { isPositive, toWei } from '@/app/utils/big-number';
import { getChainById } from '@/app/utils/chains';
import { normalize } from '@/app/utils/format';

const resolveInitialToChainId = (
  chains: { id: number }[],
  fromChainId: number,
  defaultToChainId: number,
): number => {
  if (defaultToChainId !== fromChainId) return defaultToChainId;
  const alternative = chains.find((chain) => chain.id !== fromChainId);
  return alternative?.id ?? fromChainId;
};

export const useBridge = () => {
  const { chains, bridgeAddress, defaultFromChainId, defaultToChainId } = useAppMode();
  const { listTokens } = useTokens();
  const { address, status } = useWallet();

  const [fromChainId, setFromChainId] = useState<number>(defaultFromChainId);
  const [toChainId, setToChainId] = useState<number>(() =>
    resolveInitialToChainId(chains, defaultFromChainId, defaultToChainId),
  );
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | undefined>();
  const [amount, setAmount] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');

  const fromChain = useMemo(() => getChainById(chains, fromChainId), [chains, fromChainId]);
  const toChain = useMemo(() => getChainById(chains, toChainId), [chains, toChainId]);

  const fromTokens = useMemo(() => listTokens(fromChainId), [fromChainId, listTokens]);

  const selectedToken: Token | undefined = useMemo(() => {
    if (!selectedTokenAddress) return fromTokens[0];
    return fromTokens.find((token) => normalize(token.address) === normalize(selectedTokenAddress)) ?? fromTokens[0];
  }, [fromTokens, selectedTokenAddress]);

  const selectFromChain = useCallback(
    (chainId: number) => {
      if (chainId === toChainId) {
        setToChainId(fromChainId);
      }
      setFromChainId(chainId);
    },
    [fromChainId, toChainId],
  );

  const selectToChain = useCallback(
    (chainId: number) => {
      if (chainId === fromChainId) {
        setFromChainId(toChainId);
      }
      setToChainId(chainId);
    },
    [fromChainId, toChainId],
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
  const walletAddress = useMemo(() => (isValidEthereumAddress(address) ? address : undefined), [address]);

  const { rawBalance, isLoading: isLoadingBalance } = useTokenBalance({
    token: selectedToken,
    userAddress: walletAddress,
    enabled: Boolean(selectedToken && walletAddress),
  });

  const isNative = Boolean(
    selectedToken && (selectedToken.isNative || normalize(selectedToken.address) === normalize(ZERO_ADDRESS)),
  );

  const amountWei = useMemo(() => {
    if (!selectedToken || !amount) return BigInt(0);
    return toWei(amount, selectedToken.decimals);
  }, [amount, selectedToken]);

  const tokenAddress = useMemo(() => {
    if (!selectedToken) return ZERO_ADDRESS;
    if (isValidEthereumAddress(selectedToken.address)) return selectedToken.address;
    return ZERO_ADDRESS;
  }, [selectedToken]);

  const spenderAddress = useMemo(() => {
    if (!bridgeAddress || !isValidEthereumAddress(bridgeAddress)) return undefined;
    return bridgeAddress;
  }, [bridgeAddress]);

  const canCheckAllowance = Boolean(
    !isNative && selectedToken && spenderAddress && walletAddress && amountWei > BigInt(0),
  );

  const {
    needsApproval,
    loading: isLoadingAllowance,
    refetchAllowance,
  } = useCheckAllowance({
    token: tokenAddress,
    owner: walletAddress ?? ZERO_ADDRESS,
    spender: spenderAddress ?? ZERO_ADDRESS,
    amount: amountWei,
    enabled: canCheckAllowance,
    chainId: fromChainId,
  });

  const { reserveWithBuffer } = useGasEstimate({ chainId: fromChainId, enabled: isNative });

  const maxNativeAmount = useMemo(() => {
    if (!isNative || !rawBalance) return '';
    const balance = BigInt(rawBalance);
    const max = balance > reserveWithBuffer ? balance - reserveWithBuffer : BigInt(0);
    return formatUnits(max, selectedToken?.decimals ?? 18);
  }, [isNative, rawBalance, reserveWithBuffer, selectedToken]);

  const validationError = useMemo((): BridgeValidationError | null => {
    if (!walletAddress) return 'NOT_CONNECTED';
    if (!selectedToken) return 'NO_TOKEN_SELECTED';
    if (!amount || !isPositive(amount)) return 'INVALID_AMOUNT';
    if (fromChainId === toChainId) return 'SAME_CHAIN';
    if (destinationAddress && !isValidEthereumAddress(destinationAddress)) return 'INVALID_DESTINATION';
    if (rawBalance && amountWei > BigInt(rawBalance)) return 'INSUFFICIENT_BALANCE';
    return null;
  }, [walletAddress, selectedToken, amount, fromChainId, toChainId, destinationAddress, rawBalance, amountWei]);

  return {
    form: {
      fromChainId,
      toChainId,
      amount,
      destinationAddress,
      selectedToken,
    },
    derived: {
      chains,
      fromChain,
      toChain,
      fromTokens,
      isConnected,
      walletAddress,
      isNative,
    },
    actions: {
      selectFromChain,
      selectToChain,
      swapChains,
      selectToken,
      setAmount,
      setDestination,
      clearDestination,
    },
    status: {
      validationError,
      isValid: validationError === null,
      isLoadingBalance,
      isLoadingAllowance: isNative ? false : isLoadingAllowance,
      needsApproval: isNative ? false : needsApproval,
    },
    balance: {
      raw: rawBalance,
      amountWei,
      maxNativeAmount,
      refetchAllowance,
    },
  };
};

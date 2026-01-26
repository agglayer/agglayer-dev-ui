'use client';

import { useMemo } from 'react';
import { formatUnits } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { GAS_VALUES } from '@/app/constants/gasValues';
import { formatTokenAmount } from '@/app/utils/format';

interface UseGasEstimateParams {
  chainId: number;
  networkId: number;
  decimals: number;
  needsApproval?: boolean;
  enabled?: boolean;
}

export const useGasEstimate = (params: UseGasEstimateParams) => {
  const { chainId, networkId, decimals, needsApproval = false, enabled = true } = params;
  const publicClient = usePublicClient({ chainId });

  const canFetch = Boolean(enabled && publicClient);

  const { data: gasPrice, isLoading } = useQuery<bigint>({
    queryKey: ['gas-price', chainId],
    enabled: canFetch,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retryOnMount: false,
    retry: 0,
    queryFn: async () => {
      if (!publicClient) throw new Error('MISSING_CLIENT');
      return publicClient.getGasPrice();
    },
  });

  const isL1 = networkId === 0;
  const baseGas = BigInt(isL1 ? GAS_VALUES.deposit : GAS_VALUES.withdraw);

  const maxAmount = useMemo(() => {
    if (!gasPrice) return BigInt(0);
    const gasCost = baseGas * gasPrice;

    return (gasCost * BigInt(12)) / BigInt(10);
  }, [gasPrice, baseGas]);

  const feeEstimate = useMemo(() => {
    if (!gasPrice) return { feeWei: BigInt(0), feeFormatted: '' };

    const approvalGas = needsApproval ? BigInt(GAS_VALUES.approve) : BigInt(0);
    const totalGas = baseGas + approvalGas;
    const feeWei = totalGas * gasPrice;

    const feeWithBuffer = (feeWei * BigInt(12)) / BigInt(10);

    const feeUnits = formatUnits(feeWithBuffer, decimals);
    const feeFormatted = formatTokenAmount(feeUnits);

    return { feeWei: feeWithBuffer, feeFormatted };
  }, [gasPrice, needsApproval, baseGas, decimals]);

  return {
    maxAmount,
    feeWei: feeEstimate.feeWei,
    feeFormatted: feeEstimate.feeFormatted,
    isLoading,
    gasPrice,
  };
};

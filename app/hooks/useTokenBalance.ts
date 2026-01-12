import { useBalance, useReadContract } from 'wagmi';
import type { Hex } from 'viem';
import { normalize } from '@/app/utils/format';
import type { Token } from '@/app/types/token';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const erc20BalanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

type UseTokenBalanceParams = {
  token?: Token;
  userAddress?: Hex;
  enabled?: boolean;
};

export const useTokenBalance = ({ token, userAddress, enabled = true }: UseTokenBalanceParams) => {
  const isNative = Boolean(token && (token.isNative || normalize(token.address) === ZERO_ADDRESS));
  const canFetch = Boolean(enabled && token && userAddress);
  const contractAddress = (token?.address ?? ZERO_ADDRESS) as Hex;

  const nativeBalance = useBalance({
    address: userAddress,
    chainId: token?.chainId,
    query: { enabled: canFetch && isNative },
  });

  const erc20Balance = useReadContract({
    abi: erc20BalanceOfAbi,
    address: contractAddress,
    functionName: 'balanceOf',
    args: userAddress ? [userAddress] : undefined,
    chainId: token?.chainId,
    query: { enabled: canFetch && !isNative },
  });

  const rawBalance = isNative ? nativeBalance.data?.value?.toString() : erc20Balance.data?.toString();
  const isLoading = isNative ? nativeBalance.isLoading : erc20Balance.isLoading;

  return {
    rawBalance,
    isLoading,
    isError: isNative ? nativeBalance.isError : erc20Balance.isError,
  };
};

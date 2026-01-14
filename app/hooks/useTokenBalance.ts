import { ZERO_ADDRESS } from './../types/bridge';
import { useQuery } from '@tanstack/react-query';
import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/app-mode';
import { normalize } from '@/app/utils/format';
import { isValidEthereumAddress } from '@/app/utils/address';
import type { Token } from '@/app/types/token';

type UseTokenBalanceParams = {
  token?: Token;
  userAddress?: string;
  enabled?: boolean;
};

export const useTokenBalance = ({ token, userAddress, enabled = true }: UseTokenBalanceParams) => {
  const native = useAggNative();
  const { mode } = useAppMode();
  const chainId = token?.chainId;
  const tokenAddress = token?.address ?? ZERO_ADDRESS;
  const isNative = Boolean(token && (token.isNative || normalize(tokenAddress) === normalize(ZERO_ADDRESS)));
  const canFetch = Boolean(enabled && token && userAddress && chainId);

  const {
    data: rawBalance,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['token-balance', mode, chainId, tokenAddress, userAddress],
    enabled: canFetch,
    queryFn: async () => {
      if (!token || !userAddress || !chainId) {
        throw new Error('MISSING_PARAMS');
      }
      if (isNative) {
        return native.getNativeBalance(userAddress, chainId);
      }
      if (!isValidEthereumAddress(tokenAddress)) {
        throw new Error('INVALID_TOKEN_ADDRESS');
      }
      return native.erc20(tokenAddress, chainId).getBalance(userAddress);
    },
  });

  return { rawBalance, isLoading, isError };
};

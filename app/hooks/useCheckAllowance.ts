import { useQuery } from '@tanstack/react-query';
import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { isValidEthereumAddress } from '@/app/utils/address';
import { toBigInt } from '@/app/utils/format';

interface UseCheckAllowanceParams {
  token: string;
  owner: string;
  spender: string;
  amount: bigint;
  enabled?: boolean;
  chainId: number;
}

export const useCheckAllowance = ({
  token,
  owner,
  spender,
  amount,
  enabled = true,
  chainId,
}: UseCheckAllowanceParams) => {
  const native = useAggNative();
  const { mode } = useAppMode();
  const canQuery = Boolean(token && owner && spender && amount > BigInt(0) && enabled);

  const { data, isFetching, isLoading, error, refetch } = useQuery({
    queryKey: ['allowance', mode, chainId, token, owner, spender, amount.toString()],
    enabled: canQuery,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retryOnMount: false,
    queryFn: async () => {
      if (!isValidEthereumAddress(token) || !isValidEthereumAddress(owner) || !isValidEthereumAddress(spender)) {
        throw new Error('INVALID_ADDRESS');
      }
      return native.erc20(token, chainId).getAllowance(owner, spender);
    },
  });

  const allowanceValue = toBigInt(data);
  const allowance = allowanceValue ?? BigInt(0);
  const needsApproval = allowanceValue !== undefined ? allowanceValue < amount : undefined;

  return {
    allowance,
    needsApproval,
    loading: isLoading || isFetching,
    error,
    refetchAllowance: refetch,
  };
};

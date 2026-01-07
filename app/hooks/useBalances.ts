'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { useTokens } from '@/app/context/token';
import { appConfig } from '@/app/config';
import { isTestnetChain } from '@/app/utils/network';
import { normalize } from '@/app/utils/format';
import { toBalanceQueryTokens, toBalanceIndex } from '@/app/utils/balance';
import type { BalanceTokenItem, BalanceEntry, BalanceIndex } from '@/app/types/token';

const getBalanceApiUrl = (chainId: number): string => {
  if (!chainId) return appConfig.BALANCE_API_MAINNET_URL;
  return isTestnetChain(chainId) ? appConfig.BALANCE_API_TESTNET_URL : appConfig.BALANCE_API_MAINNET_URL;
};

const fetchBalances = async (tokens: BalanceTokenItem[], userAddress: string, apiUrl: string) => {
  const payload = {
    userAddress: normalize(userAddress),
    tokens: tokens.map((t) => ({
      chainId: t.chainId,
      originChainId: t.originChainId,
      address: normalize(t.address),
      originChainAddress: t.originChainAddress ? normalize(t.originChainAddress) : undefined,
    })),
  };

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`BALANCE_${res.status}: ${msg}`);
  }

  const json: BalanceEntry[] = await res.json();
  return json.map((entry) => ({
    ...entry,
    balance: entry.balance ?? '0',
  }));
};

export function useBalances(params: {
  userAddress?: Hex;
  tokens: BalanceTokenItem[];
  referenceChainId?: number;
  enabled?: boolean;
}) {
  const { userAddress, tokens, referenceChainId, enabled } = params;
  const effectiveChainId = referenceChainId ?? tokens[0]?.chainId ?? 1;
  const apiUrl = getBalanceApiUrl(effectiveChainId);

  const queryKey = useMemo(
    () => [
      'balances',
      userAddress ?? null,
      effectiveChainId,
      tokens.map(({ chainId, address, originChainId, originChainAddress }) => ({
        chainId,
        address: normalize(address),
        originChainId: originChainId ?? String(chainId),
        originChainAddress: normalize(originChainAddress ?? address),
      })),
    ],
    [userAddress, effectiveChainId, tokens],
  );

  return useQuery<BalanceEntry[]>({
    queryKey,
    enabled: enabled && Boolean(userAddress) && tokens.length > 0 && Boolean(apiUrl),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      if (!userAddress) throw new Error('USER_ADDRESS_MISSING');
      return fetchBalances(tokens, userAddress, apiUrl);
    },
  });
}

export function useTokenBalances(params: { userAddress?: Hex; chainId: number; enabled?: boolean }) {
  const { userAddress, chainId, enabled } = params;
  const { listTokens } = useTokens();

  const tokens = useMemo(() => {
    const chainTokens = listTokens(chainId);
    return toBalanceQueryTokens(chainTokens);
  }, [chainId, listTokens]);

  const query = useBalances({
    userAddress,
    tokens,
    referenceChainId: chainId,
    enabled,
  });

  const balanceIndex = useMemo<BalanceIndex>(() => {
    if (!query.data) return {};
    return toBalanceIndex(query.data);
  }, [query.data]);

  return {
    data: query.data ?? [],
    balanceIndex,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

export function useAllTokenBalances(params: { userAddress?: Hex; enabled?: boolean }) {
  const { userAddress, enabled } = params;
  const { tokens } = useTokens();

  const mainnetTokens = useMemo(() => tokens.filter((token) => !isTestnetChain(token.chainId)), [tokens]);
  const testnetTokens = useMemo(() => tokens.filter((token) => isTestnetChain(token.chainId)), [tokens]);

  const mainnetBalanceTokens = useMemo(() => toBalanceQueryTokens(mainnetTokens), [mainnetTokens]);
  const testnetBalanceTokens = useMemo(() => toBalanceQueryTokens(testnetTokens), [testnetTokens]);

  const mainnetQuery = useBalances({
    userAddress,
    tokens: mainnetBalanceTokens,
    referenceChainId: mainnetTokens[0]?.chainId,
    enabled,
  });

  const testnetQuery = useBalances({
    userAddress,
    tokens: testnetBalanceTokens,
    referenceChainId: testnetTokens[0]?.chainId,
    enabled,
  });

  const combinedData = useMemo(
    () => [...(mainnetQuery.data ?? []), ...(testnetQuery.data ?? [])],
    [mainnetQuery.data, testnetQuery.data],
  );

  const balanceIndex = useMemo<BalanceIndex>(() => {
    if (combinedData.length === 0) return {};
    return toBalanceIndex(combinedData);
  }, [combinedData]);

  const nonZero = useMemo(() => combinedData.filter((b) => b.balance !== '0'), [combinedData]);

  return {
    data: combinedData,
    nonZero,
    balanceIndex,
    isLoading: mainnetQuery.isLoading || testnetQuery.isLoading,
    isError: mainnetQuery.isError || testnetQuery.isError,
    error: mainnetQuery.error || testnetQuery.error,
  };
}

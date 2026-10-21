import type { Token } from '@/app/types/token';
import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// This suite's whole job is the routing decision in useTokenBalance's
// queryFn: which of native.getNativeBalance / native.erc20(...).getBalance
// gets called, for a native token with/without a currency.wethToken
// override, and for a plain ERC-20. See config/configSchema.mjs's wethToken
// comment -- the override only changes the *displayed* balance source, never
// the bridge deposit itself.
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggNative: vi.fn()
}));
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';

import { useTokenBalance } from './useTokenBalance';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const WETH_ADDRESS = '0x0000003f0000003F0000003F0000003f0000003f';
const ERC20_ADDRESS = '0x00000000000000000000000000000000000000aa';
const USER_ADDRESS = '0x00000000000000000000000000000000000000bb';

const nativeToken = (wethToken?: string): Token => ({
  chainId: 1,
  address: ZERO_ADDRESS,
  decimals: 18,
  symbol: 'ETH',
  name: 'Ether',
  isNative: true,
  ...(wethToken !== undefined ? { wethToken } : {})
});

const erc20Token: Token = {
  chainId: 1,
  address: ERC20_ADDRESS,
  decimals: 18,
  symbol: 'USDC',
  name: 'USD Coin'
};

const renderBalance = (token: Token) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTokenBalance({ token, userAddress: USER_ADDRESS }), { wrapper });
};

const mockNative = (
  getNativeBalance: ReturnType<typeof vi.fn>,
  getBalance: ReturnType<typeof vi.fn>
) => {
  const erc20 = vi.fn().mockReturnValue({ getBalance });
  vi.mocked(useAggNative).mockReturnValue({
    getNativeBalance,
    erc20
  } as unknown as ReturnType<typeof useAggNative>);
  return { erc20 };
};

describe('useTokenBalance', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({ mode: 'devnet' } as unknown as ReturnType<
      typeof useAppMode
    >);
  });

  it('reads the native balance for a native token with no wethToken override', async () => {
    const getNativeBalance = vi.fn().mockResolvedValue('1000');
    const getBalance = vi.fn().mockResolvedValue('999');
    const { erc20 } = mockNative(getNativeBalance, getBalance);

    const { result } = renderBalance(nativeToken());

    await waitFor(() => expect(result.current.rawBalance).toBe('1000'));
    expect(getNativeBalance).toHaveBeenCalledWith(USER_ADDRESS, 1);
    expect(erc20).not.toHaveBeenCalled();
  });

  it('reads the native balance for a native token whose wethToken is the zero address', async () => {
    const getNativeBalance = vi.fn().mockResolvedValue('1000');
    const getBalance = vi.fn().mockResolvedValue('999');
    const { erc20 } = mockNative(getNativeBalance, getBalance);

    const { result } = renderBalance(nativeToken(ZERO_ADDRESS));

    await waitFor(() => expect(result.current.rawBalance).toBe('1000'));
    expect(getNativeBalance).toHaveBeenCalledWith(USER_ADDRESS, 1);
    expect(erc20).not.toHaveBeenCalled();
  });

  it("reads the wethToken ERC-20 balance instead of the native balance when it's set and non-zero", async () => {
    const getNativeBalance = vi.fn().mockResolvedValue('1000');
    const getBalance = vi.fn().mockResolvedValue('777');
    const { erc20 } = mockNative(getNativeBalance, getBalance);

    const { result } = renderBalance(nativeToken(WETH_ADDRESS));

    await waitFor(() => expect(result.current.rawBalance).toBe('777'));
    expect(erc20).toHaveBeenCalledWith(WETH_ADDRESS, 1);
    expect(getBalance).toHaveBeenCalledWith(USER_ADDRESS);
    expect(getNativeBalance).not.toHaveBeenCalled();
  });

  it('reads the ERC-20 balance at the token address for a plain (non-native) token', async () => {
    const getNativeBalance = vi.fn().mockResolvedValue('1000');
    const getBalance = vi.fn().mockResolvedValue('42');
    const { erc20 } = mockNative(getNativeBalance, getBalance);

    const { result } = renderBalance(erc20Token);

    await waitFor(() => expect(result.current.rawBalance).toBe('42'));
    expect(erc20).toHaveBeenCalledWith(ERC20_ADDRESS, 1);
    expect(getNativeBalance).not.toHaveBeenCalled();
  });
});

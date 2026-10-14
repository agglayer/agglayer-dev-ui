import type { AppChain } from '@/app/types/appMode';
import type { Token } from '@/app/types/token';
import type { ReactNode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider's job under test: turn the aggregator's per-token answers into
// cached, derived tokens -- found answers become tokens on the target chain,
// "absent" ones are cached only briefly, and failures are never cached.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggkitAggregator: vi.fn()
}));

import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { STORAGE_KEYS } from '@/app/utils/storage';

import { TokenProvider, useTokens } from './token';

const L1_ID = 11155111;
const L2_ID = 82;
const L1_ADDRESS = '0x1111111111111111111111111111111111111111';
const WRAPPED_ADDRESS = '0x2222222222222222222222222222222222222222';

const nativeCurrency = (symbol: string) => ({
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  name: symbol,
  symbol,
  logoURI: '',
  wethToken: '0x0000000000000000000000000000000000000000'
});

const chains = [
  { id: L1_ID, networkId: 0, name: 'Sepolia', icon: '', nativeCurrency: nativeCurrency('ETH') },
  { id: L2_ID, networkId: 82, name: 'Bali 82', icon: '', nativeCurrency: nativeCurrency('ETH') }
] as unknown as AppChain[];

const usdc: Token = {
  chainId: L1_ID,
  address: L1_ADDRESS,
  decimals: 6,
  symbol: 'USDC',
  name: 'USD Coin'
};

const getWrappedTokens = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => (
  <TokenProvider>{children}</TokenProvider>
);

const renderTokens = () => {
  const view = renderHook(() => useTokens(), { wrapper });
  act(() => view.result.current.addCustomToken(usdc));
  return view;
};

describe('TokenProvider wrapped token resolution', () => {
  beforeEach(() => {
    localStorage.clear();
    getWrappedTokens.mockReset();
    vi.mocked(useAppMode).mockReturnValue({
      mode: 'testnet',
      chains
    } as unknown as ReturnType<typeof useAppMode>);
    vi.mocked(useAggkitAggregator).mockReturnValue({
      getWrappedTokens
    } as unknown as ReturnType<typeof useAggkitAggregator>);
  });

  it('derives the wrapped token on the target chain once the bridge reports it', async () => {
    getWrappedTokens.mockResolvedValue([
      {
        originNetwork: 0,
        originTokenAddress: L1_ADDRESS,
        status: 'found',
        wrappedTokenAddress: WRAPPED_ADDRESS
      }
    ]);
    const { result } = renderTokens();

    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));

    expect(getWrappedTokens).toHaveBeenCalledWith({
      networkId: 82,
      origins: [{ originNetwork: 0, originTokenAddress: L1_ADDRESS }]
    });
    const onL2 = result.current.listTokens(L2_ID).filter((token) => !token.isNative);
    expect(onL2).toHaveLength(1);
    expect(onL2[0]).toMatchObject({
      address: WRAPPED_ADDRESS,
      symbol: 'USDC',
      isComputed: true,
      sourceToken: { chainId: L1_ID, address: L1_ADDRESS }
    });
    // The user's own token is untouched and still the only one stored as custom.
    expect(result.current.customTokens).toHaveLength(1);
  });

  it('does not ask again for a found answer, nor for a recent absent one', async () => {
    getWrappedTokens.mockResolvedValue([
      {
        originNetwork: 0,
        originTokenAddress: L1_ADDRESS,
        status: 'absent',
        wrappedTokenAddress: null
      }
    ]);
    const { result } = renderTokens();

    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));
    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));

    expect(getWrappedTokens).toHaveBeenCalledTimes(1);
    expect(result.current.listTokens(L2_ID).filter((token) => !token.isNative)).toHaveLength(0);
  });

  it('caches nothing when the lookup reports an error, so the next call retries', async () => {
    getWrappedTokens.mockResolvedValue([
      {
        originNetwork: 0,
        originTokenAddress: L1_ADDRESS,
        status: 'error',
        wrappedTokenAddress: null,
        error: 'rpc down'
      }
    ]);
    const { result } = renderTokens();

    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));
    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));

    expect(getWrappedTokens).toHaveBeenCalledTimes(2);
  });

  it('caches nothing when the whole lookup rejects', async () => {
    getWrappedTokens.mockRejectedValue(new Error('network'));
    const { result } = renderTokens();

    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));
    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));

    expect(getWrappedTokens).toHaveBeenCalledTimes(2);
  });

  it('never looks a token up on its own origin chain', async () => {
    const { result } = renderTokens();

    await act(() => result.current.resolveWrappedTokens({ chainId: L1_ID }));

    expect(getWrappedTokens).not.toHaveBeenCalled();
  });

  it('drops the derived token and its cache entry when the source token is removed', async () => {
    getWrappedTokens.mockResolvedValue([
      {
        originNetwork: 0,
        originTokenAddress: L1_ADDRESS,
        status: 'found',
        wrappedTokenAddress: WRAPPED_ADDRESS
      }
    ]);
    const { result } = renderTokens();
    await act(() => result.current.resolveWrappedTokens({ chainId: L2_ID }));
    expect(result.current.computedTokens).toHaveLength(1);

    act(() => result.current.removeCustomToken(L1_ID, L1_ADDRESS));

    await waitFor(() => expect(result.current.computedTokens).toHaveLength(0));
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(STORAGE_KEYS.TOKEN_MAPPINGS_CACHE('testnet')) ?? '{}')
      ).toEqual({})
    );
  });

  it('reloads the cache persisted by a previous session', async () => {
    localStorage.setItem(STORAGE_KEYS.CUSTOM_TOKENS, JSON.stringify([usdc]));
    localStorage.setItem(
      STORAGE_KEYS.TOKEN_MAPPINGS_CACHE('testnet'),
      JSON.stringify({
        [`${L1_ID}:${L1_ADDRESS}:${L2_ID}`]: {
          status: 'found',
          wrappedAddress: WRAPPED_ADDRESS,
          checkedAt: 1
        }
      })
    );

    const { result } = renderHook(() => useTokens(), { wrapper });

    expect(result.current.getToken(L2_ID, WRAPPED_ADDRESS)).toMatchObject({ isComputed: true });
  });
});

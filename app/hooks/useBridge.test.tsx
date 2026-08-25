import type { Token } from '@/app/types/token';

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// This suite's whole job is useBridge's `nativeBridgeUrl` derivation:
// advisory-only, surfaced ONLY when bridging native ETH (isNative) FROM
// mainnet (fromChain.networkId === 0) TO a chain that declares its own
// nativeBridgeURL -- see config/configSchema.mjs's nativeBridgeURL comment.
// Every other dependency (allowance, gas estimate, token balance) is mocked
// out so this stays scoped to that one derivation.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/token', () => ({
  useTokens: vi.fn()
}));
vi.mock('@/app/context/walletContext', () => ({
  useWallet: vi.fn()
}));
vi.mock('@/app/hooks/useCheckAllowance', () => ({
  useCheckAllowance: vi.fn()
}));
vi.mock('@/app/hooks/useGasEstimate', () => ({
  useGasEstimate: vi.fn()
}));
vi.mock('@/app/hooks/useTokenBalance', () => ({
  useTokenBalance: vi.fn()
}));

import { useAppMode } from '@/app/context/appMode';
import { useTokens } from '@/app/context/token';
import { useWallet } from '@/app/context/walletContext';
import { useCheckAllowance } from '@/app/hooks/useCheckAllowance';
import { useGasEstimate } from '@/app/hooks/useGasEstimate';
import { useTokenBalance } from '@/app/hooks/useTokenBalance';

import { useBridge } from './useBridge';

const mkAddress = (suffix: string) => `0x${'0'.repeat(40 - suffix.length)}${suffix}`;
const ZERO_ADDRESS = mkAddress('0');
const NATIVE_BRIDGE_URL = 'https://bridge.example.com';

const L1_CHAIN_ID = 1;
const L2_CHAIN_ID = 2;
const L2_OTHER_CHAIN_ID = 3;

const makeChain = (overrides: Record<string, unknown> = {}) => ({
  id: L2_CHAIN_ID,
  name: 'L2',
  icon: '',
  explorer: '',
  networkId: 1,
  isTestnet: true,
  rpcUrl: 'https://rpc.example',
  eta: 1,
  bridgeAddress: mkAddress('bb'),
  nativeCurrency: {
    address: ZERO_ADDRESS,
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
    logoURI: '',
    wethToken: ZERO_ADDRESS
  },
  ...overrides
});

const l1Chain = makeChain({ id: L1_CHAIN_ID, name: 'L1', networkId: 0 });
const l2ChainWithNativeBridge = makeChain({
  id: L2_CHAIN_ID,
  name: 'L2',
  networkId: 1,
  nativeBridgeURL: NATIVE_BRIDGE_URL
});
const l2ChainWithoutNativeBridge = makeChain({ id: L2_CHAIN_ID, name: 'L2', networkId: 1 });
const l2OtherChain = makeChain({ id: L2_OTHER_CHAIN_ID, name: 'L2 other', networkId: 2 });

const nativeToken: Token = {
  chainId: L1_CHAIN_ID,
  address: ZERO_ADDRESS,
  decimals: 18,
  symbol: 'ETH',
  name: 'Ether',
  isNative: true
};

const erc20Token: Token = {
  chainId: L1_CHAIN_ID,
  address: mkAddress('cc'),
  decimals: 18,
  symbol: 'USDC',
  name: 'USD Coin'
};

const setUpMocks = (chains: unknown[], tokens: Token[]) => {
  vi.mocked(useAppMode).mockReturnValue({
    chains,
    defaultFromChainId: L1_CHAIN_ID,
    defaultToChainId: L2_CHAIN_ID
  } as unknown as ReturnType<typeof useAppMode>);
  vi.mocked(useTokens).mockReturnValue({
    listTokens: () => tokens
  } as unknown as ReturnType<typeof useTokens>);
  vi.mocked(useWallet).mockReturnValue({
    address: undefined,
    status: 'disconnected'
  } as unknown as ReturnType<typeof useWallet>);
  vi.mocked(useCheckAllowance).mockReturnValue({
    needsApproval: false,
    loading: false,
    refetchAllowance: vi.fn()
  } as unknown as ReturnType<typeof useCheckAllowance>);
  vi.mocked(useGasEstimate).mockReturnValue({
    maxAmount: BigInt(0),
    feeFormatted: '',
    isLoading: false
  } as unknown as ReturnType<typeof useGasEstimate>);
  vi.mocked(useTokenBalance).mockReturnValue({
    rawBalance: undefined,
    isLoading: false,
    isError: false
  } as unknown as ReturnType<typeof useTokenBalance>);
};

describe('useBridge — nativeBridgeUrl', () => {
  it('surfaces the URL when bridging native ETH from mainnet to a chain that declares one', () => {
    setUpMocks([l1Chain, l2ChainWithNativeBridge], [nativeToken]);
    const { result } = renderHook(() => useBridge());

    expect(result.current.derived.nativeBridgeUrl).toBe(NATIVE_BRIDGE_URL);
  });

  it('stays undefined when the destination chain declares no nativeBridgeURL', () => {
    setUpMocks([l1Chain, l2ChainWithoutNativeBridge], [nativeToken]);
    const { result } = renderHook(() => useBridge());

    expect(result.current.derived.nativeBridgeUrl).toBeUndefined();
  });

  it('stays undefined when the source chain is not mainnet, even with a native token selected', () => {
    // Origin is L2 (networkId 1), not mainnet (networkId 0).
    setUpMocks(
      [l2ChainWithoutNativeBridge, l2OtherChain],
      [{ ...nativeToken, chainId: L2_CHAIN_ID }]
    );
    const { result } = renderHook(() => useBridge());

    expect(result.current.derived.nativeBridgeUrl).toBeUndefined();
  });

  it('stays undefined when the selected token is a plain ERC-20, not native ETH', () => {
    setUpMocks([l1Chain, l2ChainWithNativeBridge], [erc20Token]);
    const { result } = renderHook(() => useBridge());

    expect(result.current.derived.nativeBridgeUrl).toBeUndefined();
  });
});

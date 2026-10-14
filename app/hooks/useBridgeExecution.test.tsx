import type { Token } from '@/app/types/token';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// This suite's whole job is the `token` param useBridgeExecution passes to
// buildBridgeAsset for a native-currency bridge: ZERO_ADDRESS by default, or
// the source chain's nativeCurrency.wethToken when configured -- see
// config/configSchema.mjs's wethToken comment and AgglayerBridge.sol
// (agglayer/agglayer-contracts v12.2.3): a network whose gas token isn't
// ether deploys a WETHToken contract, and bridging it out must pass its
// address as `token` (bridgeAsset special-cases `token === WETHToken` into a
// privileged burn requiring msg.value === 0, unlike token === address(0)
// which requires msg.value === amount). It never touches the approval path
// (never exercised for a native bridge) or the plain-ERC20 path.
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggNative: vi.fn()
}));
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/walletContext', () => ({
  useWallet: vi.fn()
}));
vi.mock('@/app/hooks/useSenderAccount', () => ({
  useSenderAccount: vi.fn()
}));
vi.mock('wagmi', () => ({
  usePublicClient: vi.fn(),
  useSendTransaction: vi.fn()
}));

import { useAggNative } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useWallet } from '@/app/context/walletContext';
import { useSenderAccount } from '@/app/hooks/useSenderAccount';
import { usePublicClient, useSendTransaction } from 'wagmi';

import { useBridgeExecution } from './useBridgeExecution';

const mkAddress = (suffix: string) => `0x${'0'.repeat(40 - suffix.length)}${suffix}`;

const ZERO_ADDRESS = mkAddress('0');
const WETH_ADDRESS = mkAddress('3f');
const BRIDGE_ADDRESS = mkAddress('bb');
const USER_ADDRESS = mkAddress('aa');
const ERC20_ADDRESS = mkAddress('cc');

const FROM_CHAIN_ID = 1;
const TO_CHAIN_ID = 2;

const makeChain = (overrides: { wethToken?: string } = {}) => [
  {
    id: FROM_CHAIN_ID,
    name: 'From',
    icon: '',
    explorer: '',
    networkId: 1,
    isTestnet: true,
    rpcUrl: 'https://rpc.example',
    etaL1Minutes: 1,
    etaL2Minutes: 1,
    bridgeAddress: BRIDGE_ADDRESS,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: '',
      wethToken: overrides.wethToken ?? ZERO_ADDRESS
    }
  },
  {
    id: TO_CHAIN_ID,
    name: 'To',
    icon: '',
    explorer: '',
    networkId: 2,
    isTestnet: true,
    rpcUrl: 'https://rpc.example',
    etaL1Minutes: 1,
    etaL2Minutes: 1,
    bridgeAddress: BRIDGE_ADDRESS,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: '',
      wethToken: ZERO_ADDRESS
    }
  }
];

const nativeToken: Token = {
  chainId: FROM_CHAIN_ID,
  address: ZERO_ADDRESS,
  decimals: 18,
  symbol: 'ETH',
  name: 'Ether',
  isNative: true
};

const erc20Token: Token = {
  chainId: FROM_CHAIN_ID,
  address: ERC20_ADDRESS,
  decimals: 18,
  symbol: 'USDC',
  name: 'USD Coin'
};

const setUpMocks = (wethToken?: string) => {
  vi.mocked(useAppMode).mockReturnValue({
    chains: makeChain({ wethToken })
  } as unknown as ReturnType<typeof useAppMode>);
  vi.mocked(useWallet).mockReturnValue({
    address: USER_ADDRESS,
    status: 'connected'
  } as unknown as ReturnType<typeof useWallet>);
  vi.mocked(useSenderAccount).mockReturnValue(
    USER_ADDRESS as unknown as ReturnType<typeof useSenderAccount>
  );
  vi.mocked(usePublicClient).mockReturnValue({
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' })
  } as unknown as ReturnType<typeof usePublicClient>);

  const sendTransactionAsync = vi.fn().mockResolvedValue('0xhash');
  vi.mocked(useSendTransaction).mockReturnValue({ sendTransactionAsync } as unknown as ReturnType<
    typeof useSendTransaction
  >);

  const buildBridgeAsset = vi
    .fn()
    .mockResolvedValue({ to: BRIDGE_ADDRESS, data: '0xabcdef', value: undefined });
  const bridge = vi.fn().mockReturnValue({ buildBridgeAsset });
  const getBalance = vi.fn().mockResolvedValue('0');
  const bridgeTo = vi
    .fn()
    .mockResolvedValue({ to: BRIDGE_ADDRESS, data: '0xabcdef', value: undefined });
  const erc20 = vi.fn().mockReturnValue({ getBalance, bridgeTo, buildApprove: vi.fn() });
  vi.mocked(useAggNative).mockReturnValue({ bridge, erc20 } as unknown as ReturnType<
    typeof useAggNative
  >);

  return { bridge, buildBridgeAsset, erc20, sendTransactionAsync };
};

describe('useBridgeExecution — native bridge token param', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes ZERO_ADDRESS as the bridgeAsset token when the source chain has no wethToken configured', async () => {
    const { buildBridgeAsset } = setUpMocks(ZERO_ADDRESS);
    const { result } = renderHook(() => useBridgeExecution({ fromChainId: FROM_CHAIN_ID }));

    await act(async () => {
      await result.current.execute({
        toChainId: TO_CHAIN_ID,
        token: nativeToken,
        amountWei: BigInt(1000),
        needsApproval: false,
        isNative: true
      });
    });

    await waitFor(() => expect(result.current.state.currentStep).toBe('success'));
    expect(buildBridgeAsset).toHaveBeenCalledWith(
      expect.objectContaining({ token: ZERO_ADDRESS }),
      USER_ADDRESS
    );
  });

  it("passes the source chain's wethToken as the bridgeAsset token when configured", async () => {
    const { buildBridgeAsset } = setUpMocks(WETH_ADDRESS);
    const { result } = renderHook(() => useBridgeExecution({ fromChainId: FROM_CHAIN_ID }));

    await act(async () => {
      await result.current.execute({
        toChainId: TO_CHAIN_ID,
        token: nativeToken,
        amountWei: BigInt(1000),
        needsApproval: false,
        isNative: true
      });
    });

    await waitFor(() => expect(result.current.state.currentStep).toBe('success'));
    expect(buildBridgeAsset).toHaveBeenCalledWith(
      expect.objectContaining({ token: WETH_ADDRESS }),
      USER_ADDRESS
    );
  });

  it('never calls buildBridgeAsset for a plain ERC-20 bridge, wethToken configured or not', async () => {
    const { buildBridgeAsset, erc20 } = setUpMocks(WETH_ADDRESS);
    const { result } = renderHook(() => useBridgeExecution({ fromChainId: FROM_CHAIN_ID }));

    await act(async () => {
      await result.current.execute({
        toChainId: TO_CHAIN_ID,
        token: erc20Token,
        amountWei: BigInt(1000),
        needsApproval: false,
        isNative: false
      });
    });

    await waitFor(() => expect(result.current.state.currentStep).toBe('success'));
    expect(buildBridgeAsset).not.toHaveBeenCalled();
    expect(erc20).toHaveBeenCalledWith(ERC20_ADDRESS, FROM_CHAIN_ID);
  });
});

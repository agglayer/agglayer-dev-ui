import type { AppChain } from '@/app/types/appMode';
import type { Transaction } from '@/app/types/transaction';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors useBridgeExecution.test.tsx's setup: mock every context/hook
// useClaimExecution reads from directly so the suite only has to reason
// about the claim flow itself.
vi.mock('@/app/context/aggLayerSdk', () => ({
  useAggNative: vi.fn(),
  useAggkitAggregator: vi.fn()
}));
vi.mock('@/app/context/walletContext', () => ({
  useWallet: vi.fn()
}));
vi.mock('@/app/hooks/useSenderAccount', () => ({
  useSenderAccount: vi.fn()
}));
vi.mock('wagmi', () => ({
  useConfig: vi.fn(),
  useSendTransaction: vi.fn()
}));

import { useAggkitAggregator, useAggNative } from '@/app/context/aggLayerSdk';
import { useWallet } from '@/app/context/walletContext';
import { useSenderAccount } from '@/app/hooks/useSenderAccount';
import { useConfig, useSendTransaction } from 'wagmi';

import { useClaimExecution } from './useClaimExecution';

const mkAddress = (suffix: string) => `0x${'0'.repeat(40 - suffix.length)}${suffix}`;

const BRIDGE_ADDRESS = mkAddress('bb');
const USER_ADDRESS = mkAddress('aa');
const DESTINATION_CHAIN_ID = 2;

const chains: AppChain[] = [
  {
    id: DESTINATION_CHAIN_ID,
    name: 'Destination',
    icon: '',
    explorer: '',
    networkId: 2,
    isTestnet: true,
    rpcUrl: 'https://rpc.example',
    etaL1Minutes: 1,
    etaL2Minutes: 1,
    bridgeAddress: BRIDGE_ADDRESS,
    nativeCurrency: {
      address: mkAddress('0'),
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: '',
      wethToken: mkAddress('0')
    }
  }
];

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    hubUID: 'bridge-1',
    txSender: USER_ADDRESS,
    fromAddress: USER_ADDRESS,
    receiverAddress: USER_ADDRESS,
    sourceNetwork: 0,
    destinationNetwork: DESTINATION_CHAIN_ID,
    amount: '1',
    status: 'READY_TO_CLAIM',
    lastUpdatedAt: 0,
    bridgeHash: 'bridge-1',
    metadata: '0x',
    leafType: 'asset',
    depositCount: 1,
    transactionIndex: 0,
    transactionHash: '0xdeposit',
    blockNumber: 0,
    originTokenAddress: mkAddress('0'),
    originTokenNetwork: 0,
    timestamp: 0,
    leafIndex: 1,
    // buildClaimAssetParams now reads this straight off the SDK's own
    // AggkitTransaction.globalIndex instead of re-deriving it -- an
    // arbitrary numeric string is fine here, the flow below never asserts
    // its value.
    globalIndex: '1',
    ...overrides
  }) as Transaction;

const claimProof = {
  proof_local_exit_root: ['0x1'],
  proof_rollup_exit_root: ['0x2'],
  l1_info_tree_leaf: {
    block_num: 1,
    block_pos: 0,
    l1_info_tree_index: 1,
    previous_block_hash: '0x0',
    timestamp: 0,
    mainnet_exit_root: '0x3',
    rollup_exit_root: '0x4',
    global_exit_root: '0x5',
    hash: '0x6'
  }
};

const setUpMocks = (params: {
  isClaimed: ReturnType<typeof vi.fn>;
  sendTransactionAsync: ReturnType<typeof vi.fn>;
}) => {
  const { isClaimed, sendTransactionAsync } = params;

  vi.mocked(useWallet).mockReturnValue({ address: USER_ADDRESS } as unknown as ReturnType<
    typeof useWallet
  >);
  vi.mocked(useSenderAccount).mockReturnValue(
    USER_ADDRESS as unknown as ReturnType<typeof useSenderAccount>
  );
  vi.mocked(useConfig).mockReturnValue({} as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useSendTransaction).mockReturnValue({ sendTransactionAsync } as unknown as ReturnType<
    typeof useSendTransaction
  >);

  const buildClaimAsset = vi
    .fn()
    .mockResolvedValue({ to: BRIDGE_ADDRESS, data: '0xabcdef', value: undefined });
  const bridge = vi.fn().mockReturnValue({ isClaimed, buildClaimAsset });
  vi.mocked(useAggNative).mockReturnValue({ bridge } as unknown as ReturnType<typeof useAggNative>);

  const getClaimInputs = vi.fn().mockResolvedValue({ claimable: true, proof: claimProof });
  vi.mocked(useAggkitAggregator).mockReturnValue({ getClaimInputs } as unknown as ReturnType<
    typeof useAggkitAggregator
  >);

  return { bridge, buildClaimAsset, getClaimInputs };
};

describe('useClaimExecution — AlreadyClaimed race recheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips the isClaimed backoff loop entirely when the wallet rejects the claim transaction', async () => {
    const isClaimed = vi.fn().mockResolvedValue(false); // pre-flight check only
    const sendTransactionAsync = vi.fn().mockRejectedValue(new Error('User rejected the request'));
    setUpMocks({ isClaimed, sendTransactionAsync });

    const { result } = renderHook(() => useClaimExecution({ chains }));

    await act(async () => {
      await result.current.execute({
        transaction: makeTransaction(),
        destinationChainId: DESTINATION_CHAIN_ID
      });
    });

    await waitFor(() => expect(result.current.state.currentStep).toBe('error'));
    // Exactly the single pre-flight call, not the extra 400ms/1000ms backoff
    // re-checks -- proves the loop never ran instead of merely resolving
    // fast.
    expect(isClaimed).toHaveBeenCalledTimes(1);
    expect(result.current.state.error?.message).toBe('User rejected the request');
    expect(result.current.state.error?.message).not.toBe('This deposit has already been claimed');
  });

  it('skips the backoff loop for a raw code-4001 rejection whose message matches no substring', async () => {
    // The case the message-substring check genuinely cannot see, and why
    // review comment 3862948256 (C7) asked for code 4001 specifically. Note
    // a viem-MAPPED rejection was already caught by the substrings, because
    // viem overwrites the wallet's copy with its own fixed "User rejected
    // the request." shortMessage. This is the unmapped path: a provider
    // error that reaches the catch block as-is, reporting the rejection
    // only via its EIP-1193 code.
    const rawRejection = { code: 4001, message: 'Usuario cancelo la solicitud' };
    const isClaimed = vi.fn().mockResolvedValue(false); // pre-flight check only
    const sendTransactionAsync = vi.fn().mockRejectedValue(rawRejection);
    setUpMocks({ isClaimed, sendTransactionAsync });

    const { result } = renderHook(() => useClaimExecution({ chains }));

    await act(async () => {
      await result.current.execute({
        transaction: makeTransaction(),
        destinationChainId: DESTINATION_CHAIN_ID
      });
    });

    await waitFor(() => expect(result.current.state.currentStep).toBe('error'));
    expect(isClaimed).toHaveBeenCalledTimes(1);
    expect(result.current.state.error?.message).not.toBe('This deposit has already been claimed');
  });

  it('still runs the isClaimed backoff loop and reports the race for a non-rejection failure', async () => {
    const isClaimed = vi
      .fn()
      .mockResolvedValueOnce(false) // pre-flight check
      .mockResolvedValueOnce(true); // backoff loop's first (0ms) re-check
    const sendTransactionAsync = vi
      .fn()
      .mockRejectedValue(new Error('Execution reverted for an unknown reason'));
    setUpMocks({ isClaimed, sendTransactionAsync });

    const { result } = renderHook(() => useClaimExecution({ chains }));

    await act(async () => {
      await result.current.execute({
        transaction: makeTransaction(),
        destinationChainId: DESTINATION_CHAIN_ID
      });
    });

    await waitFor(() => expect(result.current.state.currentStep).toBe('error'));
    expect(isClaimed).toHaveBeenCalledTimes(2);
    expect(result.current.state.error?.message).toBe('This deposit has already been claimed');
  });
});

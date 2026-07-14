import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// TransactionsView pulls in a wide dependency graph (wallet/app-mode/refetch
// contexts, claim execution, chain-switch enforcement). This step (S8) only
// changes how `failedNetworks` from useTransactions is surfaced, so every
// other collaborator is mocked to its simplest steady-state shape and the
// assertions focus solely on the partial/all/zero-failure notice branching.
vi.mock('@/app/context/walletContext', () => ({
  useWallet: vi.fn()
}));
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/refetch', () => ({
  useRefetch: vi.fn()
}));
vi.mock('@/app/hooks/useClaimExecution', () => ({
  useClaimExecution: vi.fn()
}));
vi.mock('@/app/hooks/useEnforceCorrectChain', () => ({
  useEnforceCorrectChain: vi.fn()
}));
vi.mock('@/app/hooks/useTransactions', () => ({
  TOTAL_REFETCH_TIME: 6500,
  useTransactions: vi.fn()
}));
// Stubs the real list (which pulls in token-metadata queries and other
// unrelated context) with a minimal render that only proves the items made
// it to the view — the notice/error branching is what this suite verifies.
vi.mock('@/app/components/transactions/transactionList', () => ({
  TransactionList: ({ transactions }: { transactions: Transaction[] }) => (
    <div data-testid="transaction-list">{transactions.length} transaction(s)</div>
  )
}));
// Both modals pull in TokenProvider/other contexts unrelated to S8 and are
// always rendered by TransactionsView (gated internally on `open`); stub
// them out since this suite only exercises the notice/error branching.
vi.mock('@/app/components/transactions/transactionDetailsModal/transactionDetailsModal', () => ({
  TransactionDetailsModal: () => null
}));
vi.mock('@/app/components/transactions/claimResultModal', () => ({
  ClaimResultModal: () => null
}));

import { useAppMode } from '@/app/context/appMode';
import { useRefetch } from '@/app/context/refetch';
import { useWallet } from '@/app/context/walletContext';
import { useClaimExecution } from '@/app/hooks/useClaimExecution';
import { useEnforceCorrectChain } from '@/app/hooks/useEnforceCorrectChain';
import { useTransactions } from '@/app/hooks/useTransactions';

import { TransactionsView } from './transactionsView';

const mockChains = [
  { id: 1, networkId: 0, name: 'Ethereum' },
  { id: 137, networkId: 137, name: 'Polygon zkEVM' },
  { id: 1101, networkId: 1101, name: 'Astar zkEVM' }
];

const makeTransaction = (hubUID: string): Transaction =>
  ({
    hubUID,
    txSender: '0x1',
    fromAddress: '0x1',
    receiverAddress: '0x1',
    sourceNetwork: 0,
    destinationNetwork: 137,
    amount: '1',
    status: 'CLAIMED',
    lastUpdatedAt: 0,
    bridgeHash: '0x1',
    metadata: '0x',
    leafType: 'asset',
    depositCount: 1,
    transactionIndex: 0,
    transactionHash: '0x1',
    blockNumber: 1,
    originTokenAddress: '0x0',
    originTokenNetwork: 0,
    timestamp: 0,
    leafIndex: 1
  }) as Transaction;

const renderView = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<TransactionsView />, { wrapper });
};

describe('TransactionsView partial-failure notice', () => {
  beforeEach(() => {
    vi.mocked(useWallet).mockReturnValue({
      address: '0xabc',
      status: 'connected',
      chainId: 1,
      connect: vi.fn(),
      disconnect: vi.fn(),
      switchNetwork: vi.fn()
    } as unknown as ReturnType<typeof useWallet>);

    vi.mocked(useAppMode).mockReturnValue({
      defaultFromChainId: 1,
      chains: mockChains,
      bridgeAddress: '0xbridge'
    } as unknown as ReturnType<typeof useAppMode>);

    vi.mocked(useRefetch).mockReturnValue({
      aggressiveRefetch: false,
      triggerAggressiveRefetch: vi.fn(),
      clearAggressiveRefetch: vi.fn()
    });

    vi.mocked(useClaimExecution).mockReturnValue({
      state: { isExecuting: false, currentStep: 'idle' },
      execute: vi.fn(),
      reset: vi.fn()
    } as unknown as ReturnType<typeof useClaimExecution>);

    vi.mocked(useEnforceCorrectChain).mockReturnValue(vi.fn());
  });

  it('partial failure renders items + a notice naming the failed network by display name', () => {
    vi.mocked(useTransactions).mockReturnValue({
      data: {
        pages: [
          {
            status: 'success',
            data: [makeTransaction('tx-1'), makeTransaction('tx-2')],
            pagination: { total: 2 },
            failedNetworks: [{ networkId: 1101, error: 'timeout' }]
          }
        ],
        pageParams: [undefined]
      },
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
      failedNetworks: [{ networkId: 1101, error: 'timeout' }]
    } as unknown as ReturnType<typeof useTransactions>);

    renderView();

    // items are still shown despite the partial failure
    expect(screen.getByTestId('transaction-list')).toHaveTextContent('2 transaction(s)');

    // notice names the failed network by display name, not raw network id
    expect(screen.getByText(/Astar zkEVM/)).toBeInTheDocument();
    expect(screen.queryByText(/1101/)).not.toBeInTheDocument();

    // this is not the full "all networks failed" error state
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('all networks failing renders the existing full error state, not the partial notice', () => {
    vi.mocked(useTransactions).mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      error: new Error('AggkitBridgeAggregator.getActivity: all configured networks failed'),
      refetch: vi.fn(),
      isRefetching: false,
      failedNetworks: []
    } as unknown as ReturnType<typeof useTransactions>);

    renderView();

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByTestId('transaction-list')).not.toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/)).not.toBeInTheDocument();
  });

  it('zero failures renders items with no notice', () => {
    vi.mocked(useTransactions).mockReturnValue({
      data: {
        pages: [
          {
            status: 'success',
            data: [makeTransaction('tx-1')],
            pagination: { total: 1 },
            failedNetworks: []
          }
        ],
        pageParams: [undefined]
      },
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
      failedNetworks: []
    } as unknown as ReturnType<typeof useTransactions>);

    renderView();

    expect(screen.getByTestId('transaction-list')).toHaveTextContent('1 transaction(s)');
    expect(screen.queryByText(/temporarily unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});

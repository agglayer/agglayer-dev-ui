import type { Transaction } from '@/app/types/transaction';
import type { ReactNode } from 'react';

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// TransactionsView pulls in a wide dependency graph (wallet/app-mode/refetch
// contexts, claim execution, chain-switch enforcement), so every collaborator
// is mocked to its simplest steady-state shape and assertions focus on
// useTransactions' {transactions, totalCount, error} -> rendered-view
// contract. (S-review 2026-08-28: replaces the old suite, which exercised
// the `failedNetworks` partial-failure notice -- removed along with the
// per-network fan-out it described; the single-request activity endpoint has
// no equivalent to report.)
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
// it to the view.
vi.mock('@/app/components/transactions/transactionList', () => ({
  TransactionList: ({ transactions }: { transactions: Transaction[] }) => (
    <div data-testid="transaction-list">{transactions.length} transaction(s)</div>
  )
}));
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
  { id: 137, networkId: 137, name: 'Polygon zkEVM' }
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

describe('TransactionsView', () => {
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

  it('renders the fetched transactions and their total count', () => {
    vi.mocked(useTransactions).mockReturnValue({
      transactions: [makeTransaction('tx-1'), makeTransaction('tx-2')],
      totalCount: 2,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      error: null,
      refetch: vi.fn(),
      isRefetching: false
    } as unknown as ReturnType<typeof useTransactions>);

    renderView();

    expect(screen.getByTestId('transaction-list')).toHaveTextContent('2 transaction(s)');
    expect(screen.getByText(/Total transactions:/)).toBeInTheDocument();
  });

  it('renders the full error state when the activity fetch fails, hiding the list', () => {
    vi.mocked(useTransactions).mockReturnValue({
      transactions: [],
      totalCount: 0,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      error: new Error('ACTIVITY_FETCH_FAILED: 500'),
      refetch: vi.fn(),
      isRefetching: false
    } as unknown as ReturnType<typeof useTransactions>);

    renderView();

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByTestId('transaction-list')).not.toBeInTheDocument();
  });

  it('renders nothing extra when there are zero transactions and no error', () => {
    vi.mocked(useTransactions).mockReturnValue({
      transactions: [],
      totalCount: 0,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      error: null,
      refetch: vi.fn(),
      isRefetching: false
    } as unknown as ReturnType<typeof useTransactions>);

    renderView();

    expect(screen.getByTestId('transaction-list')).toHaveTextContent('0 transaction(s)');
    expect(screen.queryByText(/Total transactions:/)).not.toBeInTheDocument();
  });
});

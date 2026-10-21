import type { Transaction } from '@/app/types/transaction';

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A completed (CLAIMED) row has no embedded tracking to show automatically
// (see useBridgeTracking.ts) -- this suite proves the modal gates its step
// timeline behind an explicit "Show bridge steps" button for CLAIMED rows
// only, and mounts TrackerDetail in on-demand mode once clicked. TrackerDetail
// itself (loading/finished/error rendering) is covered by trackerDetail.test.tsx,
// so it's stubbed here to a simple marker that echoes its props.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/token', () => ({
  useTokens: vi.fn()
}));
vi.mock('@/app/hooks/useTokenMetadata', () => ({
  useTokenMetadata: vi.fn()
}));
vi.mock('@/app/components/transactions/trackerDetail', () => ({
  TrackerDetail: ({ transaction, onDemand }: { transaction: Transaction; onDemand?: boolean }) => (
    <div data-testid="tracker-detail-stub">
      {transaction.hubUID}:{onDemand ? 'on-demand' : 'live'}
    </div>
  )
}));

import { useAppMode } from '@/app/context/appMode';
import { useTokens } from '@/app/context/token';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';

import { TransactionDetailsModal } from './transactionDetailsModal';

const mockChains = [
  { id: 1, networkId: 0, name: 'Ethereum', explorer: 'https://etherscan.io' },
  { id: 137, networkId: 137, name: 'Polygon zkEVM', explorer: 'https://zkevm.polygonscan.com' }
];

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    hubUID: 'tx-1',
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
    transactionHash: '0xabc',
    blockNumber: 1,
    originTokenAddress: '0x0000000000000000000000000000000000000000',
    originTokenNetwork: 0,
    timestamp: 0,
    leafIndex: 1,
    ...overrides
  }) as Transaction;

const renderModal = (transaction: Transaction | null) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransactionDetailsModal open transaction={transaction} onClose={vi.fn()} />
    </QueryClientProvider>
  );
};

describe('TransactionDetailsModal', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({ chains: mockChains } as unknown as ReturnType<
      typeof useAppMode
    >);
    vi.mocked(useTokens).mockReturnValue({ getToken: vi.fn() } as unknown as ReturnType<
      typeof useTokens
    >);
    vi.mocked(useTokenMetadata).mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useTokenMetadata
    >);
  });

  it('shows a "Show bridge steps" button for a CLAIMED transaction instead of the timeline', () => {
    renderModal(makeTransaction());

    expect(screen.queryByTestId('tracker-detail-stub')).not.toBeInTheDocument();
    expect(screen.getByText('Show bridge steps')).toBeInTheDocument();
  });

  it('fetches and renders the on-demand tracker detail once the button is clicked', () => {
    renderModal(makeTransaction());

    fireEvent.click(screen.getByText('Show bridge steps'));

    expect(screen.queryByText('Show bridge steps')).not.toBeInTheDocument();
    expect(screen.getByTestId('tracker-detail-stub')).toHaveTextContent('tx-1:on-demand');
  });

  it('renders the live timeline directly (no button) for a non-CLAIMED transaction', () => {
    renderModal(makeTransaction({ status: 'READY_TO_CLAIM' }));

    expect(screen.queryByText('Show bridge steps')).not.toBeInTheDocument();
    expect(screen.getByTestId('tracker-detail-stub')).toHaveTextContent('tx-1:live');
  });

  it('resets back to the button when a different transaction is opened', () => {
    const { rerender } = renderModal(makeTransaction({ hubUID: 'tx-1' }));

    fireEvent.click(screen.getByText('Show bridge steps'));
    expect(screen.getByTestId('tracker-detail-stub')).toHaveTextContent('tx-1:on-demand');

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <TransactionDetailsModal
          open
          transaction={makeTransaction({ hubUID: 'tx-2' })}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(screen.getByText('Show bridge steps')).toBeInTheDocument();
    expect(screen.queryByTestId('tracker-detail-stub')).not.toBeInTheDocument();
  });
});

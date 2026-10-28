import type { Transaction } from '@/app/types/transaction';

import '@testing-library/jest-dom/vitest';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Review comment 3862949417 (C14): the row is a click target wrapping nested
// interactive elements (Copy / Claim buttons), so it needs role="button" +
// tabIndex + an Enter/Space handler to be keyboard- and screen-reader-
// operable, without breaking the nested buttons' own click handling. Mocks
// follow the sibling trackerDetail.test.tsx/trackerProgressBar.test.tsx
// pattern: useAppMode is stubbed directly rather than rendered through
// AppModeProvider, and useBridgeTracking is stubbed so TrackerProgressBar
// (mounted for real) renders nothing. Elements are queried via
// `[data-test-id=...]` (this repo's e2e attribute) rather than
// getByTestId/data-testid, matching trackerProgressBar.test.tsx /
// trackerDetail.test.tsx.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/context/token', () => ({
  useTokens: vi.fn()
}));
vi.mock('@/app/hooks/useTokenMetadata', () => ({
  useTokenMetadata: vi.fn()
}));
vi.mock('@/app/hooks/useAutoclaimGate', () => ({
  useAutoclaimGate: vi.fn()
}));
vi.mock('@/app/hooks/useBridgeTracking', () => ({
  useBridgeTracking: vi.fn()
}));

import { useAppMode } from '@/app/context/appMode';
import { useTokens } from '@/app/context/token';
import { useAutoclaimGate } from '@/app/hooks/useAutoclaimGate';
import { useBridgeTracking } from '@/app/hooks/useBridgeTracking';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';

import { TransactionListItem } from './transactionListItem';

const mockChains = [
  { id: 1, networkId: 0, name: 'Devnet L1' },
  { id: 2, networkId: 1, name: 'Devnet L2-001' }
];

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    hubUID: 'tx-1',
    txSender: '0x1',
    fromAddress: '0x1',
    receiverAddress: '0x1',
    sourceNetwork: 0,
    destinationNetwork: 1,
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
    originTokenAddress: '0x0',
    originTokenNetwork: 0,
    timestamp: 0,
    leafIndex: 1,
    ...overrides
  }) as Transaction;

describe('TransactionListItem', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({
      chains: mockChains
    } as unknown as ReturnType<typeof useAppMode>);

    vi.mocked(useTokens).mockReturnValue({
      getToken: vi.fn().mockReturnValue(undefined)
    } as unknown as ReturnType<typeof useTokens>);

    vi.mocked(useTokenMetadata).mockReturnValue({
      data: undefined
    } as unknown as ReturnType<typeof useTokenMetadata>);

    vi.mocked(useAutoclaimGate).mockReturnValue('no-autoclaim');

    vi.mocked(useBridgeTracking).mockReturnValue({
      data: undefined
    } as unknown as ReturnType<typeof useBridgeTracking>);
  });

  it('keeps the data-test-id keyed on the transaction hash', () => {
    const { container } = render(
      <TransactionListItem transaction={makeTransaction({ transactionHash: '0xdeadbeef' })} />
    );

    expect(
      container.querySelector('[data-test-id="transaction-row-0xdeadbeef"]')
    ).toBeInTheDocument();
  });

  it('is focusable and exposed as a button to assistive tech', () => {
    const { container } = render(<TransactionListItem transaction={makeTransaction()} />);

    const row = container.querySelector('[data-test-id="transaction-row-0xabc"]');
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabIndex', '0');
  });

  it('activates onSelect on Enter', () => {
    const onSelect = vi.fn();
    const transaction = makeTransaction();
    const { container } = render(
      <TransactionListItem transaction={transaction} onSelect={onSelect} />
    );

    const row = container.querySelector('[data-test-id="transaction-row-0xabc"]') as Element;
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(transaction);
  });

  it('activates onSelect on Space', () => {
    const onSelect = vi.fn();
    const transaction = makeTransaction();
    const { container } = render(
      <TransactionListItem transaction={transaction} onSelect={onSelect} />
    );

    const row = container.querySelector('[data-test-id="transaction-row-0xabc"]') as Element;
    fireEvent.keyDown(row, { key: ' ' });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(transaction);
  });

  it('does not activate onSelect for unrelated keys', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TransactionListItem transaction={makeTransaction()} onSelect={onSelect} />
    );

    const row = container.querySelector('[data-test-id="transaction-row-0xabc"]') as Element;
    fireEvent.keyDown(row, { key: 'a' });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('still fires onSelect on click', () => {
    const onSelect = vi.fn();
    const transaction = makeTransaction();
    const { container } = render(
      <TransactionListItem transaction={transaction} onSelect={onSelect} />
    );

    const row = container.querySelector('[data-test-id="transaction-row-0xabc"]') as Element;
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledWith(transaction);
  });

  it('clicking the nested Claim button does not also trigger the row onSelect', () => {
    const onSelect = vi.fn();
    const onClaim = vi.fn();
    const transaction = makeTransaction({ status: 'READY_TO_CLAIM' });
    const { container } = render(
      <TransactionListItem
        transaction={transaction}
        onSelect={onSelect}
        onClaim={onClaim}
        claimStep="idle"
      />
    );

    const claimButton = container.querySelector('[data-test-id="claim-tokens-button"]') as Element;
    fireEvent.click(claimButton);

    expect(onClaim).toHaveBeenCalledWith(transaction);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('pressing Enter on the nested Claim button does not also trigger the row onSelect', () => {
    // The button's own Enter-to-click activation dispatches a click that
    // bubbles to the row; the row's keydown handler ignores this because the
    // keydown's target is the button, not the row div itself.
    const onSelect = vi.fn();
    const onClaim = vi.fn();
    const transaction = makeTransaction({ status: 'READY_TO_CLAIM' });
    const { container } = render(
      <TransactionListItem
        transaction={transaction}
        onSelect={onSelect}
        onClaim={onClaim}
        claimStep="idle"
      />
    );

    const claimButton = container.querySelector('[data-test-id="claim-tokens-button"]') as Element;
    fireEvent.keyDown(claimButton, { key: 'Enter' });
    fireEvent.click(claimButton);

    expect(onClaim).toHaveBeenCalledWith(transaction);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

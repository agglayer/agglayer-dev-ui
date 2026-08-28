import type * as UseBridgeTrackingModule from '@/app/hooks/useBridgeTracking';
import type { Transaction } from '@/app/types/transaction';

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Full tracker timeline for the transaction details modal: renders
// nothing without tracking data, an info alert for
// the giving-up terminal, a warning alert for a step-level error (while
// still rendering the rest of the timeline -- the tracker retries these, it
// does not stop), and per-step result detail (certificate id, claim tx,
// GER/LER...) keyed on `step_name`. See trackerDetail.tsx.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/hooks/useBridgeTracking', async () => {
  const actual = await vi.importActual<typeof UseBridgeTrackingModule>(
    '@/app/hooks/useBridgeTracking'
  );
  // Only useBridgeTracking itself is mocked (per-test, via mockTracking
  // below) -- isTrackingTerminal is a pure function trackerDetail.tsx
  // imports directly, kept real here so the onDemand loading/terminal
  // branches below exercise the actual terminal-state logic.
  return { ...actual, useBridgeTracking: vi.fn() };
});

import {
  errorGiveupFixture,
  l1l2FinishedFixture,
  l1l2RunningFixture,
  l2l1FinishedFixture,
  l2l2RunningStepErrorFixture
} from '@/app/__fixtures__/tracker';
import { useAppMode } from '@/app/context/appMode';
import { useBridgeTracking } from '@/app/hooks/useBridgeTracking';
import { shortenAddress } from '@/app/utils/address';

import { TrackerDetail } from './trackerDetail';

const mockChains = [
  { id: 1, networkId: 0, name: 'Devnet L1' },
  { id: 2, networkId: 1, name: 'Devnet L2-001' },
  { id: 3, networkId: 2, name: 'Devnet L2-002' }
];

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    hubUID: 'tx-1',
    txSender: '0x1',
    fromAddress: '0x1',
    receiverAddress: '0x1',
    sourceNetwork: 1,
    destinationNetwork: 0,
    amount: '1',
    status: 'READY_TO_CLAIM',
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

const mockTracking = (data: unknown) =>
  vi
    .mocked(useBridgeTracking)
    .mockReturnValue({ data } as unknown as ReturnType<typeof useBridgeTracking>);

describe('TrackerDetail', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({ chains: mockChains } as unknown as ReturnType<
      typeof useAppMode
    >);
  });

  it('renders nothing when there is no tracking data at all', () => {
    mockTracking(undefined);
    const { container } = render(
      <TrackerDetail transaction={makeTransaction({ status: 'CLAIMED' })} />
    );
    expect(container.querySelector('[data-test-id="tracker-detail"]')).not.toBeInTheDocument();
  });

  it('renders an info alert for the giving-up terminal, with no step timeline', () => {
    mockTracking(errorGiveupFixture);
    const { container } = render(<TrackerDetail transaction={makeTransaction()} />);

    expect(container.querySelector('[data-test-id="tracker-detail"]')).toBeInTheDocument();
    expect(screen.getByText('Tracking unavailable')).toBeInTheDocument();
    expect(screen.getByText('Tracking is unavailable for this transaction.')).toBeInTheDocument();
    expect(
      container.querySelector('[data-test-id^="tracker-detail-step-"]')
    ).not.toBeInTheDocument();
  });

  it("renders certificate id + claim tx from a finished L2->L1 bridge's step results", () => {
    mockTracking(l2l1FinishedFixture);
    render(<TrackerDetail transaction={makeTransaction()} />);

    // PendingInclusion's result: certificate id.
    expect(screen.getByText('Certificate')).toBeInTheDocument();
    const certificateId = (l2l1FinishedFixture.all_steps![1].result as { certificate_id: string })
      .certificate_id;
    expect(screen.getByText(shortenAddress(certificateId, 6))).toBeInTheDocument();

    // WaitingClaim's result: claim tx.
    expect(screen.getByText('Claim tx')).toBeInTheDocument();
    const claimTx = (l2l1FinishedFixture.all_steps![4].result as { claim_tx: string }).claim_tx;
    expect(screen.getByText(shortenAddress(claimTx, 6))).toBeInTheDocument();
  });

  // S10a regression (mirrors trackerProgressBar.test.tsx): a LIVE transition,
  // not a row that loads already-CLAIMED (the first test above covers that,
  // and it's also already gated by the caller -- transactionDetailsModal.tsx
  // only mounts TrackerDetail while tx.status !== 'CLAIMED'). Here the mocked
  // hook keeps returning the same finished fixture across the rerender,
  // simulating a disabled react-query query still serving its last-cached
  // `data`, so this only passes because the component checks
  // `transaction.status` directly.
  it('hides the timeline on a live CLAIMED transition even though the tracker cache is still warm', () => {
    mockTracking(l1l2FinishedFixture);
    const { container, rerender } = render(<TrackerDetail transaction={makeTransaction()} />);
    expect(container.querySelector('[data-test-id="tracker-detail"]')).toBeInTheDocument();

    rerender(<TrackerDetail transaction={makeTransaction({ status: 'CLAIMED' })} />);
    expect(container.querySelector('[data-test-id="tracker-detail"]')).not.toBeInTheDocument();
  });

  it('renders a warning alert for a step-level error while the rest of the timeline still shows (non-terminal)', () => {
    mockTracking(l2l2RunningStepErrorFixture);
    const { container } = render(<TrackerDetail transaction={makeTransaction()} />);

    expect(screen.getByText('transient error (retry 2)')).toBeInTheDocument();
    // The full 7-step timeline still renders -- a step error is not terminal.
    expect(container.querySelectorAll('[data-test-id^="tracker-detail-step-"]')).toHaveLength(7);
  });

  // On-demand mode (transactionDetailsModal.tsx's "Show bridge steps" button
  // for a completed row): the CLAIMED guard above is deliberately bypassed,
  // and nothing renders except a loading state until the tracker reaches a
  // terminal state -- a completed bridge has no "current step" worth
  // showing mid-resolution.
  describe('onDemand', () => {
    it('renders a loading state for a CLAIMED transaction while the tracker has not resolved yet', () => {
      mockTracking(undefined);
      render(<TrackerDetail transaction={makeTransaction({ status: 'CLAIMED' })} onDemand />);
      expect(screen.getByText('Loading bridge steps…')).toBeInTheDocument();
    });

    it('keeps the loading state while tracking_status is non-terminal (registered/running)', () => {
      mockTracking(l1l2RunningFixture);
      const { container } = render(
        <TrackerDetail transaction={makeTransaction({ status: 'CLAIMED' })} onDemand />
      );
      expect(screen.getByText('Loading bridge steps…')).toBeInTheDocument();
      expect(
        container.querySelector('[data-test-id^="tracker-detail-step-"]')
      ).not.toBeInTheDocument();
    });

    it('renders the full timeline once tracking_status is finished', () => {
      mockTracking(l1l2FinishedFixture);
      const { container } = render(
        <TrackerDetail transaction={makeTransaction({ status: 'CLAIMED' })} onDemand />
      );
      expect(screen.queryByText('Loading bridge steps…')).not.toBeInTheDocument();
      expect(container.querySelectorAll('[data-test-id^="tracker-detail-step-"]')).toHaveLength(4);
    });

    it('renders the giving-up alert (not the loading state) once the tracker terminally fails', () => {
      mockTracking(errorGiveupFixture);
      render(<TrackerDetail transaction={makeTransaction({ status: 'CLAIMED' })} onDemand />);
      expect(screen.queryByText('Loading bridge steps…')).not.toBeInTheDocument();
      expect(screen.getByText('Tracking unavailable')).toBeInTheDocument();
    });
  });
});

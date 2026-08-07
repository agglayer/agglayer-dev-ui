import type { Transaction } from '@/app/types/transaction';

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Full tracker timeline for the transaction details modal (design.md
// §Tracker / S8): renders nothing without tracking data, an info alert for
// the giving-up terminal, a warning alert for a step-level error (while
// still rendering the rest of the timeline -- the tracker retries these, it
// does not stop), and per-step result detail (certificate id, claim tx,
// GER/LER...) keyed on `step_name`. See trackerDetail.tsx.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/hooks/useBridgeTracking', () => ({
  useBridgeTracking: vi.fn()
}));

import {
  errorGiveupFixture,
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

  it('renders a warning alert for a step-level error while the rest of the timeline still shows (non-terminal)', () => {
    mockTracking(l2l2RunningStepErrorFixture);
    const { container } = render(<TrackerDetail transaction={makeTransaction()} />);

    expect(screen.getByText('transient error (retry 2)')).toBeInTheDocument();
    // The full 7-step timeline still renders -- a step error is not terminal.
    expect(container.querySelectorAll('[data-test-id^="tracker-detail-step-"]')).toHaveLength(7);
  });
});

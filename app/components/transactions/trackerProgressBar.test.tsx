import type { Transaction } from '@/app/types/transaction';

import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Renders nothing when there's no resolved route yet (null `all_steps`) or
// when the polling hook is disabled (CLAIMED rows); otherwise one dot per
// expected step of the route, with per-step status reflected in
// `data-status`/`data-step` and the dot's fill class -- see
// trackerProgressBar.tsx and useBridgeTracking.ts.
vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));
vi.mock('@/app/hooks/useBridgeTracking', () => ({
  useBridgeTracking: vi.fn()
}));

import {
  l1l2FinishedFixture,
  l1l2RunningFixture,
  l2l2RunningFixture,
  registeredFixture
} from '@/app/__fixtures__/tracker';
import { useAppMode } from '@/app/context/appMode';
import { useBridgeTracking } from '@/app/hooks/useBridgeTracking';

import { TrackerProgressBar } from './trackerProgressBar';

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
    sourceNetwork: 0,
    destinationNetwork: 1,
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

describe('TrackerProgressBar', () => {
  beforeEach(() => {
    vi.mocked(useAppMode).mockReturnValue({ chains: mockChains } as unknown as ReturnType<
      typeof useAppMode
    >);
  });

  it('renders nothing while all_steps is null (registered, route not resolved yet)', () => {
    mockTracking(registeredFixture);
    const { container } = render(<TrackerProgressBar transaction={makeTransaction()} />);
    expect(container.querySelector('[data-test-id="tracker-progress"]')).not.toBeInTheDocument();
  });

  it('renders nothing for a CLAIMED row (hook disabled, data undefined)', () => {
    mockTracking(undefined);
    const { container } = render(
      <TrackerProgressBar transaction={makeTransaction({ status: 'CLAIMED' })} />
    );
    expect(container.querySelector('[data-test-id="tracker-progress"]')).not.toBeInTheDocument();
  });

  it('renders 4 dots for an L1->L2 mid-flight bridge, with per-step status attrs and fill classes', () => {
    mockTracking(l1l2RunningFixture);
    const { container } = render(<TrackerProgressBar transaction={makeTransaction()} />);

    expect(container.querySelectorAll('[data-test-id^="tracker-step-"]')).toHaveLength(4);

    const doneDot = container.querySelector('[data-test-id="tracker-step-0"]');
    expect(doneDot).toHaveAttribute('data-step', 'WaitingGERUpdate');
    expect(doneDot).toHaveAttribute('data-status', 'done');
    expect(doneDot).toHaveClass('border-green', 'bg-green');

    const inProgressDot = container.querySelector('[data-test-id="tracker-step-2"]');
    expect(inProgressDot).toHaveAttribute('data-step', 'WaitingClaim');
    expect(inProgressDot).toHaveAttribute('data-status', 'inProgress');
    expect(inProgressDot).toHaveClass('border-blue', 'bg-blue', 'animate-pulse');

    const pendingDot = container.querySelector('[data-test-id="tracker-step-3"]');
    expect(pendingDot).toHaveAttribute('data-step', 'Claimed');
    expect(pendingDot).toHaveAttribute('data-status', 'pending');
    expect(pendingDot).toHaveClass('border-grey-light', 'bg-transparent');
  });

  it('renders 7 dots for an L2->L2 mid-flight bridge', () => {
    mockTracking(l2l2RunningFixture);
    const { container } = render(<TrackerProgressBar transaction={makeTransaction()} />);
    expect(container.querySelectorAll('[data-test-id^="tracker-step-"]')).toHaveLength(7);
  });

  // S10a regression: a LIVE transition, not a row that loads already-CLAIMED
  // (that's the 'hook disabled, data undefined' case above). Here the mocked
  // hook keeps returning the same finished fixture across the rerender --
  // simulating react-query's real behavior of a disabled query still serving
  // its last-cached `data` -- so this only passes because the component
  // checks `transaction.status` directly rather than trusting `data`/`steps`
  // alone. Without that guard, this rerender would still find the bar.
  it('hides the bar on a live CLAIMED transition even though the tracker cache is still warm', () => {
    mockTracking(l1l2FinishedFixture);
    const { container, rerender } = render(<TrackerProgressBar transaction={makeTransaction()} />);
    expect(container.querySelectorAll('[data-test-id^="tracker-step-"]')).toHaveLength(4);

    rerender(<TrackerProgressBar transaction={makeTransaction({ status: 'CLAIMED' })} />);
    expect(container.querySelector('[data-test-id="tracker-progress"]')).not.toBeInTheDocument();
  });

  it('tooltip copy for the inProgress step names the destination chain and its status', () => {
    mockTracking(l1l2RunningFixture);
    const { container } = render(<TrackerProgressBar transaction={makeTransaction()} />);

    const dot = container.querySelector('[data-test-id="tracker-step-2"]');
    const tooltip = dot?.parentElement?.querySelector('[role="tooltip"]');
    expect(tooltip).toHaveTextContent(
      'Ready — waiting for the claim on Devnet L2-001 — In progress'
    );
  });
});

import {
  E2E_BACKEND_MODE,
  E2E_CLAIM_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_L2_CHAIN_IDS,
  E2E_L2_TO_L2_CLAIM_TIMEOUT_MS,
  E2E_NATIVE_BRIDGE_AMOUNT,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// Bridge tracker UX (design.md §Tracker / S6-S9 landed feature): the
// useBridgeTracking hook polls aggkit's tracker API and
// trackerProgressBar.tsx / trackerDetail.tsx render its `all_steps`. Like
// the other route-specific specs in this directory, this depends on
// devnet-specific infrastructure -- the tracker component
// (`aggkit-proxy-001 --components=proxy,tracker`, enclave-notes.md) that
// testnet mode doesn't run, and the fixed step counts/latencies below are
// devnet fixtures (see app/__fixtures__/tracker.ts).
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'Bridge tracker UX (aggkit tracker polling) is devnet-specific; see the comment above.'
);

// step_name order per route -- captured from the live enclave fixtures
// (app/__fixtures__/tracker.ts), which ship the full ordered `all_steps`
// array (later entries `pending`) as soon as the tracker resolves the route,
// well before any step actually starts.
const L1_TO_L2_STEP_NAMES = ['WaitingGERUpdate', 'WaitingGERInjection', 'WaitingClaim', 'Claimed'];
const L2_TO_L2_STEP_NAMES = [
  'WaitingLERUpdate',
  'PendingInclusion',
  'CertificatePending',
  'WaitL1SettledGER',
  'WaitingGERInjection',
  'WaitingClaim',
  'Claimed'
];

// Human-readable label text per step_name (getTrackerStepLabel,
// app/utils/trackerSteps.ts), in the L2->L2 step order above. Loose on the
// interpolated chain name (`.+`) so these don't depend on config.json's
// exact devnet chain display name (regenerated per enclave bring-up by
// scripts/kurtosisDevnetEnv.mjs).
const L2_TO_L2_STEP_LABEL_PATTERNS = [
  /Waiting for the local exit root update on .+/,
  /Waiting for inclusion in an agglayer certificate/,
  /Waiting for the certificate to settle/,
  /Waiting for settlement to confirm on L1/,
  /Waiting for the exit root to reach .+/,
  /Finalizing claim data for .+/,
  /Claimed/
];

test('L1→L2 tracker progress bar shows 4 steps, advances, then disappears on Completed', async ({
  page
}) => {
  // Merged bar-appear + at-least-one-done-dot poll, then a final wait for
  // Completed -- both bounded by E2E_CLAIM_TIMEOUT_MS (the same devnet
  // send->claimed budget claim-autoclaim.spec.ts uses for this exact route).
  // +90s for everything else in the journey (connect, fill, submit,
  // navigate, the modal-free assertions in between).
  test.setTimeout(2 * E2E_CLAIM_TIMEOUT_MS + 90_000);

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();
  await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
  await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await bridgePage.waitForBridgeSuccess();

  const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  const transactionHash = explorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0];
  if (!transactionHash) {
    throw new Error('E2E: could not read the bridge transaction hash from the success view');
  }

  await bridgePage.bridgeSuccessCta.click();

  const row = bridgePage.getTransactionRow(transactionHash);
  await expect(row).toBeVisible();

  const trackerBar = bridgePage.getTrackerBar(transactionHash);

  // Single poll loop covering both "the bar renders with its 4 dots" and
  // "at least one dot reaches done" -- the tracker needs its own poll cycle
  // to resolve `all_steps` (registered -> running), so the bar may not exist
  // for the first refresh or two. Per-step mid-flight status strings are
  // recorded as annotations rather than asserted: L1->L2 can autoclaim in
  // ~35s against this hook's own 5s poll interval (useBridgeTracking.ts), and
  // per S7 the bar disappears entirely the instant the row reaches CLAIMED --
  // a fast-enough autoclaim can beat this poll to ever observing a 'done'
  // dot, which is recorded rather than failed.
  const capturedStepNames: string[] = [];
  const observedStatusSnapshots: string[] = [];
  let sawDoneDot = false;
  let completedBeforeDoneDot = false;

  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();

        const barVisible = await trackerBar.isVisible().catch(() => false);
        if (!barVisible) {
          completedBeforeDoneDot = await row
            .getByText('Completed')
            .isVisible()
            .catch(() => false);
          return completedBeforeDoneDot;
        }

        const dots = await Promise.all(
          L1_TO_L2_STEP_NAMES.map((_, index) => {
            const dot = bridgePage.getTrackerStep(transactionHash, index);
            return Promise.all([dot.getAttribute('data-step'), dot.getAttribute('data-status')]);
          })
        );
        if (capturedStepNames.length === 0) {
          capturedStepNames.push(...dots.map(([step]) => step ?? ''));
        }
        const statuses = dots.map(([, status]) => status ?? '');
        observedStatusSnapshots.push(statuses.join(','));
        if (statuses.some((status) => status === 'done')) {
          sawDoneDot = true;
          return true;
        }
        return false;
      },
      {
        message: "Waiting for the tracker bar to render and at least one dot to reach 'done'",
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  // Route shape: exactly 4 dots, in the fixed step_name order the tracker
  // resolves them in (this is the acceptance-criterion assertion, not a
  // timing-sensitive one -- the full ordered array is present from the
  // first non-null `all_steps` response, see the comment above).
  expect(capturedStepNames).toEqual(L1_TO_L2_STEP_NAMES);
  await expect(bridgePage.getTrackerStep(transactionHash, L1_TO_L2_STEP_NAMES.length)).toHaveCount(
    0
  );

  test.info().annotations.push({
    type: 'tracker-step-status-snapshots',
    description:
      observedStatusSnapshots.join(' | ') || '(row reached Completed before any snapshot)'
  });
  test.info().annotations.push({
    type: 'tracker-completed-before-done-dot-observed',
    description: String(completedBeforeDoneDot)
  });
  expect(sawDoneDot || completedBeforeDoneDot).toBe(true);

  // Terminal assertion (S7's chosen behavior): once the row reaches
  // Completed, useBridgeTracking's query is disabled (status === 'CLAIMED')
  // and trackerProgressBar.tsx renders nothing -- the bar must be gone, not
  // just stale. (No-op wait if completedBeforeDoneDot already made this
  // true above.)
  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return row
          .getByText('Completed')
          .isVisible()
          .catch(() => false);
      },
      {
        message: 'Waiting for the row to reach Completed (CLAIMED)',
        timeout: E2E_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  await expect(trackerBar).toHaveCount(0);
});

test('L2-1→L2-2 tracker: 7-step bar, modal detail mid-flight, disappears on Completed', async ({
  page
}) => {
  // L2->L2 requires a second devnet L2 -- same guard l2-to-l2.spec.ts uses.
  test.skip(
    E2E_BACKEND_MODE !== 'devnet' || E2E_L2_CHAIN_IDS.length < 2,
    'L2->L2 requires a second devnet L2 (E2E_L2_CHAIN_IDS); not available in testnet mode.'
  );

  // Same budget composition as l2-to-l2.spec.ts: E2E_L2_TO_L2_CLAIM_TIMEOUT_MS
  // for the tracked L2->L2 send->claimed leg (this route's long window is
  // exactly why the mid-flight modal assertion below lives on this test
  // rather than the fast L1->L2 one), plus one E2E_CLAIM_TIMEOUT_MS round
  // trip for the L1->L2-1 top-up, plus 120s slack for the rest of the
  // journey (connect, fill, submit, navigate, modal open/close).
  test.setTimeout(E2E_L2_TO_L2_CLAIM_TIMEOUT_MS + E2E_CLAIM_TIMEOUT_MS + 120_000);

  const [fromChainId, toChainId] = E2E_L2_CHAIN_IDS;

  const bridgePage = new BridgePage({ page });

  await bridgePage.navigate();
  await bridgePage.connectWallet();

  // Top-up: the L2-1->L2-2 native bridge below spends L2-1's
  // LocalBalanceTree credit for origin-network-0 native ETH -- same
  // dependency l2-to-l2.spec.ts documents and funds for itself (its own
  // BridgePage.fundLocalBalanceTree doc comment has the full writeup). Fund
  // it here too so this spec doesn't depend on suite order.
  await bridgePage.fundLocalBalanceTree({
    fromChainId: E2E_FROM_CHAIN_ID,
    toChainId: fromChainId,
    amount: E2E_NATIVE_BRIDGE_AMOUNT,
    claimTimeoutMs: E2E_CLAIM_TIMEOUT_MS
  });

  // fundLocalBalanceTree leaves the browser on the transactions route.
  await bridgePage.navigate();
  await bridgePage.connectWallet();

  await bridgePage.selectChainPair(fromChainId, toChainId);
  await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
  await bridgePage.submitBridge();
  await bridgePage.waitForTransactionModal();
  await bridgePage.waitForBridgeSuccess();

  const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
  const transactionHash = explorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0];
  if (!transactionHash) {
    throw new Error('E2E: could not read the bridge transaction hash from the success view');
  }

  await bridgePage.bridgeSuccessCta.click();

  const row = bridgePage.getTransactionRow(transactionHash);
  await expect(row).toBeVisible();

  const trackerBar = bridgePage.getTrackerBar(transactionHash);

  // Wait for the bar to resolve its 7 dots, capturing the step order on
  // first sighting -- see the L1->L2 test above for why this needs its own
  // poll rather than a single refreshActivity().
  const capturedStepNames: string[] = [];

  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        if (!(await trackerBar.isVisible().catch(() => false))) return false;

        const stepNames = await Promise.all(
          L2_TO_L2_STEP_NAMES.map((_, index) =>
            bridgePage.getTrackerStep(transactionHash, index).getAttribute('data-step')
          )
        );
        capturedStepNames.length = 0;
        capturedStepNames.push(...stepNames.map((name) => name ?? ''));
        return true;
      },
      {
        message: 'Waiting for the tracker to resolve the L2->L2 route and render its 7 dots',
        // This route's dominant latency term (source-side certificate
        // settlement, see E2E_L2_TO_L2_CLAIM_TIMEOUT_MS's comment in
        // app/constants/e2e.ts) is downstream of route resolution, so
        // resolution itself should land well inside this budget.
        timeout: E2E_L2_TO_L2_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  expect(capturedStepNames).toEqual(L2_TO_L2_STEP_NAMES);
  await expect(bridgePage.getTrackerStep(transactionHash, L2_TO_L2_STEP_NAMES.length)).toHaveCount(
    0
  );

  // Mid-flight modal detail check: transactionDetailsModal.tsx only mounts
  // TrackerDetail while tx.status !== 'CLAIMED', so this must happen now,
  // while the bar above is still visible -- L2->L2's multi-minute window
  // (vs. L1->L2's ~35-67s) is exactly what makes this reliable here rather
  // than on the fast route. TrackerDetail shares its react-query cache key
  // with the row's own poll (trackerDetail.tsx's doc comment), so `data` is
  // already warm from the bar above -- no extra wait needed for it to
  // populate.
  await bridgePage.openTransactionDetails(transactionHash);
  await expect(bridgePage.trackerDetail).toBeVisible();

  for (const [index, pattern] of L2_TO_L2_STEP_LABEL_PATTERNS.entries()) {
    await expect(bridgePage.getTrackerDetailStep(index)).toContainText(pattern);
  }
  await expect(bridgePage.getTrackerDetailStep(L2_TO_L2_STEP_LABEL_PATTERNS.length)).toHaveCount(0);

  // Close before resuming refreshActivity()-driven polling below -- the
  // modal's full-viewport overlay would otherwise intercept that click.
  await bridgePage.closeTransactionDetailsModal();
  await expect(bridgePage.trackerDetail).toHaveCount(0);

  // Record whatever step is in progress at this point as an annotation
  // (race-prone -- not asserted) rather than silently discarding it.
  const midFlightStatuses = await Promise.all(
    L2_TO_L2_STEP_NAMES.map((_, index) =>
      bridgePage.getTrackerStep(transactionHash, index).getAttribute('data-status')
    )
  );
  test.info().annotations.push({
    type: 'tracker-mid-flight-statuses-at-modal-check',
    description: midFlightStatuses.join(',')
  });

  await expect
    .poll(
      async () => {
        await bridgePage.refreshActivity();
        return row
          .getByText('Completed')
          .isVisible()
          .catch(() => false);
      },
      {
        message: 'Waiting for the L2-1->L2-2 deposit to reach Completed (CLAIMED)',
        timeout: E2E_L2_TO_L2_CLAIM_TIMEOUT_MS,
        intervals: [5_000]
      }
    )
    .toBe(true);

  // Terminal assertion (S7's chosen behavior): bar disappears on CLAIMED.
  await expect(trackerBar).toHaveCount(0);
});

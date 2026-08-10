import type { AggkitBridgeStep, AggkitStepStatus } from '@agglayer/sdk';

// Humanized copy for each step of the aggkit tracker's route (design.md
// §Tracker / useBridgeTracking). Keyed on `step_name`, the bare string
// aggkit ships on the wire -- see useBridgeTracking.ts and the SDK's
// AggkitBridgeStep union for the full deviation writeup.
//
// `sourceName`/`destinationName` are interpolated where the copy needs to
// name a specific chain; both are optional since the tracker bar can render
// before chain metadata resolves (falls back to "the source"/"the
// destination").
interface TrackerStepLabelParams {
  sourceName?: string;
  destinationName?: string;
}

const STEP_LABELS: Record<AggkitBridgeStep, (params: TrackerStepLabelParams) => string> = {
  WaitingGERUpdate: () => 'Waiting for the global exit root update on L1',
  WaitingLERUpdate: ({ sourceName }) =>
    `Waiting for the local exit root update on ${sourceName || 'the source'}`,
  PendingInclusion: () => 'Waiting for inclusion in an agglayer certificate',
  CertificatePending: () => 'Waiting for the certificate to settle',
  WaitL1SettledGER: () => 'Waiting for settlement to confirm on L1',
  WaitingGERInjection: ({ destinationName }) =>
    `Waiting for the exit root to reach ${destinationName || 'the destination'}`,
  // Deliberately NOT "Ready" -- entering this step only means the tracker's
  // fast path (a direct read of the settlement tx's own L1 receipt) has
  // resolved; it does not mean aggkit's bridge-service has finished its own,
  // separate L1-info-tree sync, which is what actually gates the "Claim
  // tokens" button (status READY_TO_CLAIM) and what /claim-proof needs to
  // serve a proof. Measured gap on a live devnet L2->L1 bridge: tracker
  // entered this step at T+18s, the claim was not actually possible (proof
  // not servable) until T+40.5s -- see
  // plans/bridge-tracker/tracker-vs-claim-lag.md. Saying "Ready" here would
  // read as a UI bug the moment a user notices the claim button hasn't
  // appeared yet.
  WaitingClaim: ({ destinationName }) =>
    `Finalizing claim data for ${destinationName || 'the destination'}`,
  Claimed: () => 'Claimed'
};

export const getTrackerStepLabel = (
  stepName: AggkitBridgeStep,
  params: TrackerStepLabelParams = {}
): string => STEP_LABELS[stepName](params);

const STEP_STATUS_COPY: Record<AggkitStepStatus, string> = {
  pending: 'Pending',
  inProgress: 'In progress',
  done: 'Done',
  error: 'Error'
};

// Tooltip body: label + status. `expected_duration` is folded in when
// present, but it has never been observed on the wire (see the SDK's
// AggkitBridgeStepPath doc comment), so the copy must read fine without it.
export const getTrackerStepTooltip = (
  stepName: AggkitBridgeStep,
  status: AggkitStepStatus,
  params: TrackerStepLabelParams = {},
  expectedDuration?: string
): string => {
  const label = getTrackerStepLabel(stepName, params);
  const durationSuffix = expectedDuration ? ` (~${expectedDuration})` : '';
  return `${label}${durationSuffix} — ${STEP_STATUS_COPY[status]}`;
};

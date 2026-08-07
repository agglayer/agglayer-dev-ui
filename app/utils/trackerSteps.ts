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
  WaitingClaim: ({ destinationName }) =>
    `Ready — waiting for the claim on ${destinationName || 'the destination'}`,
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

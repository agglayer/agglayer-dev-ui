import { describe, expect, it } from 'vitest';

import type { AggkitBridgeStep } from '@agglayer/sdk';

import { getTrackerStepLabel, getTrackerStepTooltip } from './trackerSteps';

// Locks the current copy for every known step (comment 3862949155 / C12's
// fallback below must not change any of these) -- sourceName/destinationName
// are supplied throughout so the interpolated labels are covered too.
describe('getTrackerStepLabel', () => {
  const params = { sourceName: 'Devnet L2-001', destinationName: 'Devnet L1' };

  it.each<[AggkitBridgeStep, string]>([
    ['WaitingGERUpdate', 'Waiting for the global exit root update on L1'],
    ['WaitingLERUpdate', 'Waiting for the local exit root update on Devnet L2-001'],
    ['PendingInclusion', 'Waiting for inclusion in an agglayer certificate'],
    ['CertificatePending', 'Waiting for the certificate to settle'],
    ['WaitL1SettledGER', 'Waiting for settlement to confirm on L1'],
    ['WaitingGERInjection', 'Waiting for the exit root to reach Devnet L1'],
    ['WaitingClaim', 'Finalizing claim data for Devnet L1'],
    ['Claimed', 'Claimed']
  ])('keeps the existing copy for %s', (stepName, expected) => {
    expect(getTrackerStepLabel(stepName, params)).toBe(expected);
  });

  // C12: step_name ships as a bare string over the wire, so a value the SDK
  // adds later (or any payload outside the AggkitBridgeStep union) reaches
  // this function despite the type saying otherwise. It used to call
  // STEP_LABELS[stepName] unconditionally and throw a TypeError here --
  // before trackerDetail.tsx's UnrecognizedStepResult fallback ever had a
  // chance to render.
  it('falls back instead of throwing for an unrecognized step_name', () => {
    const unknownStep = 'SomeFutureStep' as AggkitBridgeStep;
    expect(() => getTrackerStepLabel(unknownStep, params)).not.toThrow();
    expect(getTrackerStepLabel(unknownStep, params)).toBe('Unrecognized step');
  });
});

describe('getTrackerStepTooltip', () => {
  it('does not throw for an unrecognized step_name either (label lookup is shared)', () => {
    const unknownStep = 'SomeFutureStep' as AggkitBridgeStep;
    expect(() => getTrackerStepTooltip(unknownStep, 'pending')).not.toThrow();
    expect(getTrackerStepTooltip(unknownStep, 'pending')).toBe('Unrecognized step — Pending');
  });
});

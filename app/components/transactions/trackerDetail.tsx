'use client';

import type { Transaction } from '@/app/types/transaction';

import { CopyText } from '@/app/components/copyText';
import { DOT_CLASSES } from '@/app/components/transactions/trackerProgressBar';
import { Alert } from '@/app/components/ui/alert';
import { useAppMode } from '@/app/context/appMode';
import { hasTrackingStarted, useBridgeTracking } from '@/app/hooks/useBridgeTracking';
import { shortenAddress } from '@/app/utils/address';
import { getChainByNetworkId } from '@/app/utils/chains';
import { cn } from '@/app/utils/common';
import { formatDateTime } from '@/app/utils/date';
import { getTrackerStepLabel } from '@/app/utils/trackerSteps';
import { Loader2 } from 'lucide-react';

import type {
  AggkitBridgeStepPath,
  AggkitBridgeStepResult,
  AggkitCertificateData,
  AggkitPendingInclusionResult,
  AggkitStepStatus,
  AggkitWaitingClaimResult,
  AggkitWaitingGERInjectionResult,
  AggkitWaitingGERUpdateResult,
  AggkitWaitingLERUpdateResult,
  AggkitWaitL1SettledGERResult
} from '@agglayer/sdk';

interface TrackerDetailProps {
  transaction: Transaction;
  // Explicit opt-in for a completed (CLAIMED) transaction: fetches fresh
  // tracker data on demand (useBridgeTracking's on-demand path) instead of
  // reading the embedded tracking that a CLAIMED row never has. The only
  // caller that ever sets this is transactionDetailsModal.tsx's "Show
  // bridge steps" button.
  onDemand?: boolean;
}

const STATUS_LABEL_CLASSES: Record<AggkitStepStatus, string> = {
  done: 'text-green',
  inProgress: 'text-blue',
  pending: 'text-grey',
  error: 'text-red'
};

const STATUS_COPY: Record<AggkitStepStatus, string> = {
  pending: 'Pending',
  inProgress: 'In progress',
  done: 'Done',
  error: 'Error'
};

// `start_date`/`end_date` ship as ISO strings (see useBridgeTracking.ts's
// SDK deviation writeup) -- formatDateTime expects unix seconds, so convert.
const formatIsoDateTime = (iso: string): string =>
  formatDateTime(Math.floor(new Date(iso).getTime() / 1000));

// Truncated hash + copy, matching the pattern transactionDetailsModal.tsx
// already uses for the source/destination tx hashes. No explorer link here:
// per-step artifacts (GER/LER/certificate ids) don't have a per-row explorer
// deep-link today (non-goal per S8 context pack).
const HashValue = ({ value, chars = 6 }: { value: string; chars?: number }) => (
  <span className="inline-flex items-center gap-px">
    <span className="font-mono text-black">{shortenAddress(value, chars)}</span>
    <CopyText
      textToCopy={value}
      buttonClassName="rounded p-1 hover:bg-surface text-black"
      iconClassName="size-3.5 text-grey"
    />
  </span>
);

// `AggkitBridgeStepResult` is a flat union, not one discriminated by
// `step_name` at the type level (no shared tag field ties a specific result
// shape to a specific step -- see the SDK's AggkitBridgeStepPath doc
// comment). Each guard below narrows on a field unique to that result shape
// using the `in` operator, which both type-narrows safely (no cast needed)
// and doubles as the runtime check for a malformed/unexpected payload --
// `'ger'` alone would also match `AggkitWaitL1SettledGERResult` (it carries
// a `ger` field too), hence the exclusion there.
const isGERResult = (
  result: AggkitBridgeStepResult
): result is AggkitWaitingGERUpdateResult | AggkitWaitingGERInjectionResult =>
  'ger' in result && !('tx_hash' in result);

const isLERResult = (result: AggkitBridgeStepResult): result is AggkitWaitingLERUpdateResult =>
  'ler' in result;

const isPendingInclusionResult = (
  result: AggkitBridgeStepResult
): result is AggkitPendingInclusionResult => 'new_ler' in result;

const isCertificateData = (result: AggkitBridgeStepResult): result is AggkitCertificateData =>
  'status_string' in result;

const isWaitL1SettledGERResult = (
  result: AggkitBridgeStepResult
): result is AggkitWaitL1SettledGERResult => 'tx_hash' in result;

const isWaitingClaimResult = (result: AggkitBridgeStepResult): result is AggkitWaitingClaimResult =>
  'claim_tx' in result;

// Rendered instead of guessing at a shape: either the step's `result` failed
// its guard above (malformed/unexpected wire payload for that `step_name`),
// or `step_name` itself isn't one of the recognized values at all. Either
// way this is a handled, visible branch -- never a silent `null` and never
// an unchecked cast into whatever shape the switch below expected.
const UnrecognizedStepResult = () => (
  <div data-test-id="tracker-detail-unrecognized-step-result" className="text-xs text-grey italic">
    Details unavailable
  </div>
);

// Per-step `result` shape depends on `step_name` (AggkitBridgeStepResult
// union) -- see useBridgeTracking.ts / the SDK's AggkitBridgeStepPath doc
// comment for the full field-by-field breakdown this switches on.
const StepResultDetail = ({ step }: { step: AggkitBridgeStepPath }) => {
  if (!step.result) return null;
  const { result } = step;

  switch (step.step_name) {
    case 'WaitingGERUpdate':
    case 'WaitingGERInjection': {
      if (!isGERResult(result)) return <UnrecognizedStepResult />;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>GER</span>
          <HashValue value={result.ger} />
        </div>
      );
    }
    case 'WaitingLERUpdate': {
      if (!isLERResult(result)) return <UnrecognizedStepResult />;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>LER</span>
          <HashValue value={result.ler} />
          <span>Block {result.block_number}</span>
        </div>
      );
    }
    case 'PendingInclusion': {
      if (!isPendingInclusionResult(result)) return <UnrecognizedStepResult />;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>Certificate</span>
          <HashValue value={result.certificate_id} />
        </div>
      );
    }
    case 'CertificatePending': {
      if (!isCertificateData(result)) return <UnrecognizedStepResult />;
      return (
        <div className="flex flex-col gap-1 text-xs text-grey">
          <div className="flex items-center gap-2">
            <span>Certificate status</span>
            <span className="font-semibold text-black">{result.status_string}</span>
          </div>
          {result.settlement_tx_hash && (
            <div className="flex items-center gap-2">
              <span>Settlement tx</span>
              <HashValue value={result.settlement_tx_hash} />
            </div>
          )}
          {result.error && <span className="text-red">{result.error}</span>}
        </div>
      );
    }
    case 'WaitL1SettledGER': {
      if (!isWaitL1SettledGERResult(result)) return <UnrecognizedStepResult />;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>Settlement tx</span>
          <HashValue value={result.tx_hash} />
          <span>Block {result.block_number}</span>
        </div>
      );
    }
    case 'WaitingClaim': {
      if (!isWaitingClaimResult(result)) return <UnrecognizedStepResult />;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>Claim tx</span>
          <HashValue value={result.claim_tx} />
          <span>Block {result.block_number}</span>
        </div>
      );
    }
    default:
      return <UnrecognizedStepResult />;
  }
};

// Full tracker picture for the transaction details modal: overall
// tracking status + bridge typology,
// then a vertical timeline of every `all_steps` entry with its label,
// status, dates, and per-step result detail. Mounts useBridgeTracking
// itself -- react-query dedupes the query key with the row's own poll
// (trackerProgressBar.tsx does the same), so opening the modal never starts
// a second poll for the same transaction.
//
// Renders nothing when there is no tracking data at all. This covers CLAIMED
// rows in the LIVE path (the hook's query is `enabled: false` there, so
// `data` never populates -- no tracker section, no polling) and the brief
// window before the tracker has registered a freshly-sent bridge. Pass
// `onDemand` to render a completed row's detail instead -- see
// useBridgeTracking.ts's on-demand path.
export const TrackerDetail = ({ transaction, onDemand = false }: TrackerDetailProps) => {
  const { chains } = useAppMode();
  const { data } = useBridgeTracking(transaction, { enabled: onDemand });

  // Explicit CLAIMED guard (S10a, mirrors trackerProgressBar.tsx) for the
  // LIVE path: a row that transitions from non-CLAIMED -> CLAIMED while
  // mounted keeps serving its last-cached, fully-`done` embedded tracking
  // (disabling a query does not clear its cache), so `data` alone is not a
  // reliable "hide on CLAIMED" signal there. `onDemand` is the deliberate
  // escape hatch -- a completed row's on-demand detail is SUPPOSED to render
  // for a CLAIMED transaction.
  if (transaction.status === 'CLAIMED' && !onDemand) return null;

  // On-demand mode still holds off on rendering anything until the tracker
  // has resolved the route at all: a single on-demand call can land before
  // that (`tracking_status` still `registered`, `all_steps` still null), so
  // there is nothing yet worth showing. Once it leaves `registered` (e.g.
  // `running`) there IS a current step worth showing, even mid-resolution --
  // no need to wait for `finished`. The hook keeps polling underneath
  // regardless (see useBridgeTracking.ts's isTrackingTerminal).
  if (onDemand && !hasTrackingStarted(data)) {
    return (
      <div
        data-test-id="tracker-detail"
        className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-grey"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading bridge steps…
      </div>
    );
  }

  if (!data) return null;

  // Giving-up terminal (useBridgeTracking.ts's isTrackingTerminal): the
  // tracker could not resolve this tx as a bridge at all. No steps exist.
  if (data.tracking_status === 'error' && data.bridge_status === null) {
    return (
      <div data-test-id="tracker-detail">
        <Alert
          type="info"
          title="Tracking unavailable"
          message="Tracking is unavailable for this transaction."
        />
      </div>
    );
  }

  const sourceName = getChainByNetworkId(chains, transaction.sourceNetwork)?.name;
  const destinationName = getChainByNetworkId(chains, transaction.destinationNetwork)?.name;
  const steps = data.all_steps;
  const bridgeType = data.bridge_status?.bridge_type;
  const leafType = data.bridge_status?.event.leaf_type;

  return (
    <div data-test-id="tracker-detail" className="space-y-3">
      <div className="flex items-center justify-between px-3 py-2 text-sm border-border border-b">
        <span className="text-grey font-medium">Tracking status</span>
        <span className="font-semibold text-black capitalize">
          {data.tracking_status}
          {bridgeType ? ` · ${bridgeType}` : ''}
          {leafType ? ` · ${leafType}` : ''}
        </span>
      </div>

      {steps && steps.length > 0 && (
        <div className="space-y-4 px-3 py-2">
          {steps.map((step, index) => (
            <div
              key={step.step_index}
              data-test-id={`tracker-detail-step-${index}`}
              className="flex gap-3"
            >
              <div className="flex flex-col items-center pt-1">
                <span
                  className={cn(
                    'block size-2.5 shrink-0 rounded-full border-2',
                    DOT_CLASSES[step.status]
                  )}
                />
                {index < steps.length - 1 && <div className="w-0.5 flex-1 bg-grey-light mt-1" />}
              </div>
              <div className="flex-1 pb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={cn('text-sm font-medium', STATUS_LABEL_CLASSES[step.status])}>
                    {getTrackerStepLabel(step.step_name, { sourceName, destinationName })}
                  </span>
                  <span className="text-xs text-grey">{STATUS_COPY[step.status]}</span>
                </div>
                {(step.start_date || step.end_date) && (
                  <div className="text-xs text-grey mt-0.5">
                    {step.start_date && `Started ${formatIsoDateTime(step.start_date)}`}
                    {step.start_date && step.end_date && ' · '}
                    {step.end_date && `Ended ${formatIsoDateTime(step.end_date)}`}
                  </div>
                )}
                <div className="mt-1">
                  <StepResultDetail step={step} />
                </div>
                {step.error && (
                  <Alert
                    className="mt-2"
                    type="warning"
                    title={`${step.error.error_type_string} error (retry ${step.error.retry_count})`}
                    message={step.error.description[step.error.description.length - 1] ?? ''}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

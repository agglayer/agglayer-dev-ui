'use client';

import type { Transaction } from '@/app/types/transaction';

import { CopyText } from '@/app/components/copyText';
import { DOT_CLASSES } from '@/app/components/transactions/trackerProgressBar';
import { Alert } from '@/app/components/ui/alert';
import { useAppMode } from '@/app/context/appMode';
import { isTrackingTerminal, useBridgeTracking } from '@/app/hooks/useBridgeTracking';
import { shortenAddress } from '@/app/utils/address';
import { getChainByNetworkId } from '@/app/utils/chains';
import { cn } from '@/app/utils/common';
import { formatDateTime } from '@/app/utils/date';
import { getTrackerStepLabel } from '@/app/utils/trackerSteps';
import { Loader2 } from 'lucide-react';

import type {
  AggkitBridgeStepPath,
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

// Per-step `result` shape depends on `step_name` (AggkitBridgeStepResult
// union) -- see useBridgeTracking.ts / the SDK's AggkitBridgeStepPath doc
// comment for the full field-by-field breakdown this switches on.
const StepResultDetail = ({ step }: { step: AggkitBridgeStepPath }) => {
  if (!step.result) return null;

  switch (step.step_name) {
    case 'WaitingGERUpdate':
    case 'WaitingGERInjection': {
      const result = step.result as AggkitWaitingGERUpdateResult | AggkitWaitingGERInjectionResult;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>GER</span>
          <HashValue value={result.ger} />
        </div>
      );
    }
    case 'WaitingLERUpdate': {
      const result = step.result as AggkitWaitingLERUpdateResult;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>LER</span>
          <HashValue value={result.ler} />
          <span>Block {result.block_number}</span>
        </div>
      );
    }
    case 'PendingInclusion': {
      const result = step.result as AggkitPendingInclusionResult;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>Certificate</span>
          <HashValue value={result.certificate_id} />
        </div>
      );
    }
    case 'CertificatePending': {
      const result = step.result as AggkitCertificateData;
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
      const result = step.result as AggkitWaitL1SettledGERResult;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>Settlement tx</span>
          <HashValue value={result.tx_hash} />
          <span>Block {result.block_number}</span>
        </div>
      );
    }
    case 'WaitingClaim': {
      const result = step.result as AggkitWaitingClaimResult;
      return (
        <div className="flex items-center gap-2 text-xs text-grey">
          <span>Claim tx</span>
          <HashValue value={result.claim_tx} />
          <span>Block {result.block_number}</span>
        </div>
      );
    }
    default:
      return null;
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

  // On-demand mode only ever wants the FINAL picture: a single on-demand
  // call can land mid-resolution (`tracking_status` still
  // `registered`/`running`), and there is no "current step" worth showing
  // for a bridge that has already completed -- so hold off on rendering
  // anything (not even a partial timeline) until the tracker reaches a
  // terminal state (`finished`, or its giving-up `error`). The hook keeps
  // polling underneath until then.
  if (onDemand && !isTrackingTerminal(data)) {
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

'use client';

import type { Transaction } from '@/app/types/transaction';

import { Tooltip } from '@/app/components/ui/tooltip';
import { useAppMode } from '@/app/context/appMode';
import { useBridgeTracking } from '@/app/hooks/useBridgeTracking';
import { getChainByNetworkId } from '@/app/utils/chains';
import { cn } from '@/app/utils/common';
import { getTrackerStepTooltip } from '@/app/utils/trackerSteps';

import type { AggkitStepStatus } from '@agglayer/sdk';

interface TrackerProgressBarProps {
  transaction: Transaction;
}

// Dot fill per step status (design.md §Tracker / S7 context pack): done is
// filled green, inProgress is a highlighted blue that pulses, pending is a
// hollow ring, error is filled red.
export const DOT_CLASSES: Record<AggkitStepStatus, string> = {
  done: 'border-green bg-green',
  inProgress: 'border-blue bg-blue animate-pulse',
  pending: 'border-grey-light bg-transparent',
  error: 'border-red bg-red'
};

// Renders the aggkit tracker's `all_steps` as a row of dots + connector
// lines, one dot per expected step of this bridge's route (4 for L1->L2, 6
// for L2->L1, 7 for L2->L2 -- see useBridgeTracking.ts). Mounts the polling
// hook itself so callers just drop this in; it renders nothing while
// `all_steps` is still null (tracker hasn't resolved the route yet, or has
// given up) and nothing for CLAIMED rows (the hook disables its query for
// those, so `data` never populates).
export const TrackerProgressBar = ({ transaction }: TrackerProgressBarProps) => {
  const { chains } = useAppMode();
  const { data } = useBridgeTracking(transaction);
  const steps = data?.all_steps;

  // Explicit CLAIMED guard (S10a): useBridgeTracking disables its query once
  // status is CLAIMED, but disabling a react-query query only stops future
  // refetches -- it does NOT clear already-cached `data` for that query key.
  // A row that transitions live from non-CLAIMED -> CLAIMED while mounted
  // (rather than loading already-CLAIMED) keeps serving its last-fetched,
  // fully-`done` `all_steps` from cache, so relying on `data`/`steps` alone
  // does not actually hide the bar on that transition. Check `status`
  // directly rather than depending on cache semantics.
  if (transaction.status === 'CLAIMED' || !steps || steps.length === 0) return null;

  const sourceName = getChainByNetworkId(chains, transaction.sourceNetwork)?.name;
  const destinationName = getChainByNetworkId(chains, transaction.destinationNetwork)?.name;

  return (
    <div className="flex items-center pt-1" data-test-id="tracker-progress">
      {steps.map((step, index) => (
        <div key={step.step_index} className="flex flex-1 items-center last:flex-none">
          <Tooltip
            content={getTrackerStepTooltip(
              step.step_name,
              step.status,
              { sourceName, destinationName },
              step.expected_duration
            )}
          >
            <span
              data-test-id={`tracker-step-${index}`}
              data-step={step.step_name}
              data-status={step.status}
              className={cn(
                'block size-2.5 shrink-0 rounded-full border-2',
                DOT_CLASSES[step.status]
              )}
            />
          </Tooltip>
          {index < steps.length - 1 && (
            <div
              className={cn('h-0.5 flex-1', step.status === 'done' ? 'bg-green' : 'bg-grey-light')}
            />
          )}
        </div>
      ))}
    </div>
  );
};

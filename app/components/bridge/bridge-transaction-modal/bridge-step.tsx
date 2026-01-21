'use client';

import type { ReactNode } from 'react';
import type { Hex } from 'viem';
import { CircleCheck, Link as LinkIcon, Loader2, XCircle } from 'lucide-react';

export type StepState = 'idle' | 'pending' | 'success' | 'error';

interface BridgeStepProps {
  label: string;
  state: StepState;
  txHash?: Hex;
  explorerUrl?: string;
}

const statusLabelMap: Record<StepState, string> = {
  idle: 'Waiting',
  pending: 'Pending confirmation',
  success: 'Confirmed',
  error: 'Failed',
};

const iconMap: Record<StepState, ReactNode> = {
  idle: <CircleCheck className="size-5 text-grey" />,
  pending: <CircleCheck className="size-5 text-grey" />,
  success: <CircleCheck className="size-5 text-green" />,
  error: <XCircle className="size-5 text-red" />,
};

export const BridgeStep = ({ label, state, txHash, explorerUrl }: BridgeStepProps) => {
  const icon = iconMap[state];
  const showExplorer = Boolean(txHash && explorerUrl && state !== 'pending');
  const explorerHref = showExplorer ? `${explorerUrl}/tx/${txHash}` : undefined;

  return (
    <div className="flex items-center justify-between rounded-xl border-2 border-border px-4 py-3">
      <div className="flex items-center gap-3">
        {icon}
        <div className="flex flex-col">
          <span className="font-semibold text-black">{label}</span>
          <span className="text-xs text-muted">{statusLabelMap[state]}</span>
        </div>
      </div>
      {state === 'pending' && <Loader2 className="size-5 text-grey animate-spin" />}
      {explorerHref && (
        <a
          href={explorerHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue hover:underline"
        >
          View on explorer
          <LinkIcon className="size-4" />
        </a>
      )}
    </div>
  );
};

'use client';

import type { ClaimFailedStep } from '@/app/types/transaction';

import { Button } from '@/app/components/ui/button';
import { Modal } from '@/app/components/ui/modal';
import { getExternalLinks } from '@/app/config';
import { isUserRejectionMessage } from '@/app/utils/walletErrors';
import { CircleCheck, CircleX, ExternalLink, Info } from 'lucide-react';
import Link from 'next/link';

type ClaimResultStatus = 'success' | 'error';

interface ClaimResultModalProps {
  open: boolean;
  onClose: () => void;
  status: ClaimResultStatus | null;
  claimTxHash?: string;
  explorerUrl?: string;
  errorMessage?: string;
  errorStep?: ClaimFailedStep;
}

// User-facing label for each step useClaimExecution can fail at, shown in the
// collapsible "technical details" section below -- keep these short and
// specific enough to be useful in a support/bug report without requiring
// engineering context to read.
const CLAIM_FAILED_STEP_LABELS: Record<ClaimFailedStep, string> = {
  'validating-wallet': 'Validating wallet connection',
  'validating-configuration': 'Validating bridge configuration',
  'checking-claim-status': 'Checking whether the deposit was already claimed',
  'fetching-claim-proof': 'Fetching the claim proof',
  'building-claim-transaction': 'Building the claim transaction',
  'sending-transaction': 'Sending the claim transaction',
  'confirming-transaction': 'Confirming the claim transaction'
};

// useClaimExecution sets this exact message when its own pre-flight
// `bridge.isClaimed()` check (not a thrown exception) finds the deposit
// already settled -- e.g. raced by an external autoclaimer between the row
// rendering "Ready to claim" and the user's click. Unlike a thrown
// error's `.message` (RPC/viem internals, not meant for end users), this
// string is hand-authored specifically to be user-facing (see
// useClaimExecution.ts), so it's safe -- and more reassuring than the
// generic "contact support" copy -- to show verbatim instead of masking it.
const isAlreadyClaimed = (message?: string): boolean =>
  message === 'This deposit has already been claimed';

export const ClaimResultModal = ({
  open,
  onClose,
  status,
  claimTxHash,
  explorerUrl,
  errorMessage,
  errorStep
}: ClaimResultModalProps) => {
  if (!status) return null;

  const txExplorerUrl = explorerUrl && claimTxHash ? `${explorerUrl}/tx/${claimTxHash}` : undefined;
  const userRejected = isUserRejectionMessage(errorMessage);
  const alreadyClaimed = isAlreadyClaimed(errorMessage);
  const supportUrl = getExternalLinks().CONTACT_SUPPORT;
  const hasSupportUrl = !!supportUrl?.trim();

  const getErrorMessage = () => {
    if (userRejected) return 'User rejected the request.';
    if (alreadyClaimed) return 'Your funds have already arrived at the destination address.';
    if (!hasSupportUrl) return 'Something went wrong. Please try again.';

    return (
      <>
        Something went wrong. Please try again or{' '}
        <Link
          href={supportUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue hover:underline"
        >
          contact support
        </Link>
        .
      </>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Claim">
      <div className="flex w-full flex-col items-center gap-4 text-center py-4">
        {status === 'success' && (
          <>
            <CircleCheck aria-hidden className="size-12 text-green" />
            <div className="space-y-2">
              <h2 className="text-xl font-bold">Claim successful</h2>
            </div>
          </>
        )}
        {status === 'error' && alreadyClaimed && (
          <>
            <Info aria-hidden className="size-12 text-blue" />
            <div className="space-y-2">
              <h2 className="text-xl font-bold">Already claimed</h2>
              <p className="text-sm text-grey">{getErrorMessage()}</p>
            </div>
          </>
        )}
        {status === 'error' && !alreadyClaimed && (
          <>
            <CircleX aria-hidden className="size-12 text-red" />
            <div className="space-y-2">
              <h2 className="text-xl font-bold">Claim failed</h2>
              <p className="text-sm text-grey">{getErrorMessage()}</p>
            </div>
          </>
        )}
        {status === 'error' && !userRejected && (errorStep || errorMessage) && (
          <details className="w-full text-left text-sm" data-test-id="claim-error-details">
            <summary className="cursor-pointer text-grey hover:text-foreground">
              Technical details
            </summary>
            <div className="mt-2 space-y-1 rounded-lg bg-surface-muted p-3 text-xs text-grey">
              {errorStep && (
                <p>
                  <span className="font-semibold">Step:</span> {CLAIM_FAILED_STEP_LABELS[errorStep]}
                </p>
              )}
              {errorMessage && (
                <p className="break-words">
                  <span className="font-semibold">Error:</span> {errorMessage}
                </p>
              )}
            </div>
          </details>
        )}
        <div className="flex w-full flex-col gap-3 pt-2">
          {txExplorerUrl && (
            <a
              href={txExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 text-sm font-semibold text-blue hover:underline"
            >
              View on explorer
              <ExternalLink aria-hidden className="size-4" />
            </a>
          )}
          <Button onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
};

'use client';

import { Button } from '@/app/components/ui/button';
import { Modal } from '@/app/components/ui/modal';
import { getExternalLinks } from '@/app/config';
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
}

const isUserRejection = (message?: string): boolean => {
  if (!message) return false;
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('rejected') ||
    lowerMessage.includes('denied') ||
    lowerMessage.includes('user refused')
  );
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
  errorMessage
}: ClaimResultModalProps) => {
  if (!status) return null;

  const txExplorerUrl = explorerUrl && claimTxHash ? `${explorerUrl}/tx/${claimTxHash}` : undefined;
  const userRejected = isUserRejection(errorMessage);
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

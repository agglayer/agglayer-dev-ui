'use client';

import type { BridgeExecutionState } from '@/app/types/bridge';
import type { Token } from '@/app/types/token';

import { BridgeRoute } from '@/app/components/bridge/bridgeTransactionModal/bridgeRoute';
import { BridgeStep } from '@/app/components/bridge/bridgeTransactionModal/bridgeStep';
import { BridgeSuccessView } from '@/app/components/bridge/bridgeTransactionModal/bridgeSuccessView';
import { BridgeSummary } from '@/app/components/bridge/bridgeTransactionModal/bridgeSummary';
import { resolveBridgeTransactionModalContent } from '@/app/components/bridge/bridgeTransactionModal/bridgeTransactionModalContent';
import { Button } from '@/app/components/ui/button';
import { Modal } from '@/app/components/ui/modal';
import { cn } from '@/app/utils/common';
import { CheckCircle2, Link as LinkIcon, XCircle } from 'lucide-react';

const ALTERNATE_HEADLINE = 'Do not refresh page';

interface BridgeTransactionModalProps {
  open: boolean;
  onClose: () => void;
  state: BridgeExecutionState;
  token: Token;
  fromChainName: string;
  toChainName: string;
  fromChainIcon?: string;
  toChainIcon?: string;
  amount: string;
  needsApproval: boolean;
  explorerUrl?: string;
}

export const BridgeTransactionModal = ({
  open,
  onClose,
  state,
  token,
  fromChainName,
  toChainName,
  fromChainIcon,
  toChainIcon,
  amount,
  needsApproval,
  explorerUrl
}: BridgeTransactionModalProps) => {
  const content = resolveBridgeTransactionModalContent(state, {
    tokenSymbol: token.symbol,
    amount,
    fromChainName,
    toChainName
  });

  const isExecuting = state.isExecuting;

  const handleClose = () => {
    if (isExecuting) return;
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bridge assets"
      showCloseButton={!isExecuting}
      dismissible={!isExecuting}
      contentClassName="space-y-6"
      dataTestId="bridge-transaction-modal"
    >
      <div className="space-y-4 text-center">
        {content.mode === 'success' || content.mode === 'error' ? (
          <div
            className={cn(
              'mx-auto flex size-14 items-center justify-center rounded-full',
              content.mode === 'success' ? 'bg-green-light text-green' : 'bg-red-light text-red'
            )}
          >
            {content.mode === 'success' ? (
              <CheckCircle2 className="size-7" />
            ) : (
              <XCircle className="size-7" />
            )}
          </div>
        ) : (
          <BridgeRoute
            fromChainIcon={fromChainIcon}
            toChainIcon={toChainIcon}
            fromChainName={fromChainName}
            toChainName={toChainName}
          />
        )}
        <BridgeSummary
          headline={content.headline}
          subheadline={content.subheadline}
          showLoader={content.showLoader}
          alternateHeadline={ALTERNATE_HEADLINE}
          shouldAlternate={content.shouldAlternateHeadline}
        />
      </div>
      {content.mode === 'pending' && (
        <div className="space-y-3">
          {needsApproval && (
            <BridgeStep
              label={`Approve ${token.symbol}`}
              state={content.approveStepState}
              txHash={state.approvalTxHash}
              explorerUrl={explorerUrl}
              testId="bridge-step-approve"
            />
          )}
          <BridgeStep
            label="Bridge"
            state={content.bridgeStepState}
            txHash={state.bridgeTxHash}
            explorerUrl={explorerUrl}
            testId="bridge-step-bridge"
          />
        </div>
      )}
      {content.mode === 'success' && state.bridgeTxHash && (
        <BridgeSuccessView
          hash={state.bridgeTxHash}
          explorerUrl={explorerUrl ? `${explorerUrl}/tx/${state.bridgeTxHash}` : undefined}
          onClose={handleClose}
        />
      )}
      {content.mode === 'error' && (
        <div className="space-y-3 text-center">
          {state.error?.txHash && explorerUrl && (
            <a
              href={`${explorerUrl}/tx/${state.error.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-semibold text-blue hover:underline"
            >
              View on explorer
              <LinkIcon className="size-4" />
            </a>
          )}
          <Button onClick={handleClose} className="w-full">
            Close
          </Button>
        </div>
      )}
    </Modal>
  );
};

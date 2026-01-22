'use client';

import { CheckCircle2, Link as LinkIcon, XCircle } from 'lucide-react';
import { Modal } from '@/app/components/ui/modal';
import { Button } from '@/app/components/ui/button';
import type { BridgeExecutionState, BridgeStep as BridgeStepType } from '@/app/types/bridge';
import type { Token } from '@/app/types/token';
import { BridgeStep, StepState } from '@/app/components/bridge/bridgeTransactionModal/bridgeStep';
import { BridgeSuccessView } from '@/app/components/bridge/bridgeTransactionModal/bridgeSuccessView';
import { RouteVisual } from '@/app/components/bridge/bridgeTransactionModal/routeVisual';
import { BridgeSummary } from '@/app/components/bridge/bridgeTransactionModal/bridgeSummary';

type ModalMode = 'pending' | 'success' | 'error';

type ModalContent = {
  mode: ModalMode;
  headline: string;
  subheadline: string;
  showLoader: boolean;
  shouldAlternateHeadline: boolean;
  approveStepState: StepState;
  bridgeStepState: StepState;
};

type ModalContext = {
  tokenSymbol: string;
  amount: string;
  fromChainName: string;
  toChainName: string;
  needsApproval: boolean;
};

const ALTERNATE_HEADLINE = 'Do not refresh page';

const getStepState = (
  step: 'approve' | 'bridge',
  currentStep: BridgeStepType,
  hasApprovalTx: boolean,
  hasBridgeTx: boolean,
): StepState => {
  if (step === 'approve') {
    if (currentStep === 'approving') return 'pending';
    if (currentStep === 'error' && hasApprovalTx && !hasBridgeTx) return 'error';
    if (hasApprovalTx) return 'success';
    return 'idle';
  }
  if (currentStep === 'bridging') return 'pending';
  if (currentStep === 'success') return 'success';
  if (currentStep === 'error' && hasBridgeTx) return 'error';
  return 'idle';
};

const formatErrorMessage = (message?: string): string => {
  if (!message) return 'Something went wrong. Please try again.';
  const normalized = message.toLowerCase();
  if (normalized.includes('user rejected') || normalized.includes('rejected the request')) {
    return 'You rejected the request.';
  }
  return 'Something went wrong. Please try again.';
};

const resolveModalContent = (state: BridgeExecutionState, context: ModalContext): ModalContent => {
  const { tokenSymbol, amount, fromChainName, toChainName } = context;
  const { currentStep, isExecuting, approvalTxHash, bridgeTxHash, error } = state;

  const hasApprovalTx = Boolean(approvalTxHash);
  const hasBridgeTx = Boolean(bridgeTxHash);
  const hasSubmittedTx = hasApprovalTx || hasBridgeTx;

  const approveStepState = getStepState('approve', currentStep, hasApprovalTx, hasBridgeTx);
  const bridgeStepState = getStepState('bridge', currentStep, hasApprovalTx, hasBridgeTx);

  if (currentStep === 'success') {
    return {
      mode: 'success',
      headline: 'Transaction successful',
      subheadline: 'Your assets are on the way.',
      showLoader: false,
      shouldAlternateHeadline: false,
      approveStepState,
      bridgeStepState,
    };
  }

  if (currentStep === 'error') {
    return {
      mode: 'error',
      headline: 'Transaction failed',
      subheadline: formatErrorMessage(error?.message),
      showLoader: false,
      shouldAlternateHeadline: false,
      approveStepState,
      bridgeStepState,
    };
  }

  const bridgingDescription = `Bridging ${amount} ${tokenSymbol} from ${fromChainName} to ${toChainName}.`;
  const isAwaitingConfirmation = isExecuting && hasSubmittedTx;

  if (currentStep === 'approving') {
    return {
      mode: 'pending',
      headline: `Approve ${tokenSymbol}`,
      subheadline: bridgingDescription,
      showLoader: true,
      shouldAlternateHeadline: isAwaitingConfirmation,
      approveStepState,
      bridgeStepState,
    };
  }

  if (currentStep === 'bridging') {
    return {
      mode: 'pending',
      headline: 'Bridging assets',
      subheadline: bridgingDescription,
      showLoader: true,
      shouldAlternateHeadline: isAwaitingConfirmation,
      approveStepState,
      bridgeStepState,
    };
  }

  return {
    mode: 'pending',
    headline: 'Confirm in wallet',
    subheadline: bridgingDescription,
    showLoader: true,
    shouldAlternateHeadline: false,
    approveStepState,
    bridgeStepState,
  };
};

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
  explorerUrl,
}: BridgeTransactionModalProps) => {
  const content = resolveModalContent(state, {
    tokenSymbol: token.symbol,
    amount,
    fromChainName,
    toChainName,
    needsApproval,
  });

  const isPending = state.isExecuting;

  const handleClose = () => {
    if (isPending) return;
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bridge assets"
      showCloseButton={!isPending}
      dismissible={!isPending}
      contentClassName="space-y-6"
    >
      <div className="space-y-4 text-center">
        {content.mode === 'success' || content.mode === 'error' ? (
          <div
            className={`mx-auto flex size-14 items-center justify-center rounded-full ${
              content.mode === 'success' ? 'bg-green-light text-green' : 'bg-red-light text-red'
            }`}
          >
            {content.mode === 'success' ? <CheckCircle2 className="size-7" /> : <XCircle className="size-7" />}
          </div>
        ) : (
          <RouteVisual
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
            />
          )}
          <BridgeStep
            label="Bridge"
            state={content.bridgeStepState}
            txHash={state.bridgeTxHash}
            explorerUrl={explorerUrl}
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
        <div className="space-y-4 text-center">
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

import type { StepState } from '@/app/components/bridge/bridgeTransactionModal/bridgeStep';
import type { BridgeExecutionState, BridgeStep as BridgeStepType } from '@/app/types/bridge';

export type BridgeTransactionModalMode = 'pending' | 'success' | 'error';

export type BridgeTransactionModalContent = {
  mode: BridgeTransactionModalMode;
  headline: string;
  subheadline: string;
  showLoader: boolean;
  shouldAlternateHeadline: boolean;
  approveStepState: StepState;
  bridgeStepState: StepState;
};

export type BridgeTransactionModalContext = {
  tokenSymbol: string;
  amount: string;
  fromChainName: string;
  toChainName: string;
};

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

export const resolveBridgeTransactionModalContent = (
  state: BridgeExecutionState,
  context: BridgeTransactionModalContext,
): BridgeTransactionModalContent => {
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

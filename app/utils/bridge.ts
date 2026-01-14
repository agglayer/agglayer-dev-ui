import type { BridgeCtaState, BridgeValidationError } from '@/app/types/bridge';

const ERROR_LABELS: Record<BridgeValidationError, string> = {
  NOT_CONNECTED: 'Connect wallet',
  NO_TOKEN_SELECTED: 'Select a token',
  INVALID_AMOUNT: 'Enter an amount',
  INSUFFICIENT_BALANCE: 'Insufficient balance',
  SAME_CHAIN: 'Select different chains',
  INVALID_DESTINATION: 'Invalid destination',
};

export const getBridgeCtaState = (params: {
  isConnected: boolean;
  isLoading: boolean;
  validationError: BridgeValidationError | null;
}): BridgeCtaState => {
  const { isConnected, isLoading, validationError } = params;

  if (!isConnected) {
    return { disabled: false, label: 'Connect wallet', action: 'connect' };
  }

  if (isLoading) {
    return { disabled: true, label: 'Loading...', action: 'loading' };
  }

  if (validationError) {
    return { disabled: true, label: ERROR_LABELS[validationError], action: 'bridge' };
  }

  return { disabled: false, label: 'Bridge', action: 'bridge' };
};

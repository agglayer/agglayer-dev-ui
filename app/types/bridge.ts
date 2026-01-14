import type { Hex } from 'viem';

export const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';

export type BridgeValidationError =
  | 'NOT_CONNECTED'
  | 'NO_TOKEN_SELECTED'
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_BALANCE'
  | 'SAME_CHAIN'
  | 'INVALID_DESTINATION';

export type BridgeStep = 'idle' | 'approving' | 'bridging' | 'success' | 'error';

export interface BridgeExecutionState {
  isExecuting: boolean;
  currentStep: BridgeStep;
  approvalTxHash?: Hex;
  bridgeTxHash?: Hex;
  error?: { message: string; txHash?: Hex };
}

export interface BridgeCtaState {
  disabled: boolean;
  label: string;
  action: 'connect' | 'bridge' | 'loading';
}

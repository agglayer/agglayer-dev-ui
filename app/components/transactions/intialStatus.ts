import type { TransactionStatus } from '@/app/types/transaction';

let initialStatus: TransactionStatus | null = null;

export const setTransactionInitialStatus = (status: TransactionStatus | null) => {
  initialStatus = status;
};

export const getTransactionInitialStatus = (): TransactionStatus | null => {
  const current = initialStatus;
  initialStatus = null;
  return current;
};

import { type Hex, isHex } from 'viem';
import type { TransactionParams } from '@agglayer/sdk';
import { formatTokenAmount, toBigInt } from './format';
import { fromWei } from '@/app/utils/big-number';
import { isValidEthereumAddress } from '@/app/utils/address';
import { Transaction } from '@/app/types/transaction';

export const formatTransactionAmount = (amount: string, decimals: number): string => {
  try {
    const humanAmount = fromWei(amount, decimals);
    return formatTokenAmount(humanAmount);
  } catch {
    return amount;
  }
};

export const isNativeToken = (address: string) => {
  return address === '0x0000000000000000000000000000000000000000';
};

export const mapTransactionRequest = (params: TransactionParams, account: Hex) => {
  const to = isValidEthereumAddress(params.to) ? params.to : undefined;
  if (!to) throw new Error('Invalid transaction recipient');

  const data = isHex(params.data) ? params.data : undefined;
  if (!data) throw new Error('Invalid transaction data');

  return {
    account,
    to,
    data,
    value: toBigInt(params.value),
  };
};

export const resolveLeafIndex = (tx: Transaction): number =>
  tx.leafIndexForProof != null ? tx.leafIndexForProof : tx.leafIndex;

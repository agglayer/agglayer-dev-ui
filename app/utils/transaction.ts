import { type Hex, isHex } from 'viem';
import type { ClaimAssetParams, TransactionParams } from '@agglayer/sdk';
import { formatTokenAmount, toBigInt } from './format';
import { fromWei } from '@/app/utils/big-number';
import { isValidEthereumAddress } from '@/app/utils/address';
import { Transaction } from '@/app/types/transaction';
import type { ClaimProof } from '@/app/services/claim-proof';

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

const GLOBAL_INDEX_MAINNET_FLAG = BigInt(2) ** BigInt(64);
const GLOBAL_INDEX_NETWORK_OFFSET = BigInt(2) ** BigInt(32);
const ZERO_HEX: Hex = '0x';

// See https://github.com/agglayer/sdk/blob/main/src/native/bridge/util.ts
export const computeGlobalIndex = (depositCount: number, sourceNetworkId: number): bigint =>
  sourceNetworkId === 0
    ? BigInt(depositCount) + GLOBAL_INDEX_MAINNET_FLAG
    : BigInt(depositCount) + BigInt(sourceNetworkId - 1) * GLOBAL_INDEX_NETWORK_OFFSET;

export const buildClaimAssetParams = (params: {
  transaction: Transaction;
  proof: ClaimProof;
}): ClaimAssetParams => {
  const { transaction, proof } = params;
  const metadata = isHex(transaction.metadata) ? transaction.metadata : ZERO_HEX;

  return {
    smtProofLocalExitRoot: proof.proof_local_exit_root,
    smtProofRollupExitRoot: proof.proof_rollup_exit_root,
    globalIndex: computeGlobalIndex(transaction.depositCount, transaction.sourceNetwork),
    mainnetExitRoot: proof.l1_info_tree_leaf.mainnet_exit_root,
    rollupExitRoot: proof.l1_info_tree_leaf.rollup_exit_root,
    originNetwork: transaction.originTokenNetwork,
    originTokenAddress: transaction.originTokenAddress,
    destinationNetwork: transaction.destinationNetwork,
    destinationAddress: transaction.receiverAddress,
    amount: BigInt(transaction.amount),
    metadata,
  };
};

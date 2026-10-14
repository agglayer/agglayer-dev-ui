import type { ClaimProof } from '@/app/services/claimProof';
import type { Transaction } from '@/app/types/transaction';
import type { Hex } from 'viem';

import { isValidEthereumAddress } from '@/app/utils/address';
import { fromWei } from '@/app/utils/bigNumber';
import { isHex } from 'viem';

import type { ClaimAssetParams, TransactionParams } from '@agglayer/sdk';

import { formatTokenAmount, toBigInt } from './format';

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

export const mapTransactionRequest = (params: TransactionParams) => {
  const to = isValidEthereumAddress(params.to) ? params.to : undefined;
  if (!to) throw new Error('Invalid transaction recipient');

  const data = isHex(params.data) ? params.data : undefined;
  if (!data) throw new Error('Invalid transaction data');

  return {
    to,
    data,
    value: toBigInt(params.value)
  };
};

// For `Bridge.isClaimed` ONLY — the contract's leafIndex arg is the local
// deposit index (`deposit_count`), NOT the L1-info-tree index aggkit's
// claim-proof needs. `tx.leafIndex` already carries
// `deposit_count` (see AggkitBridgeAggregator.toTransaction); the L1-info-tree
// index is a *separate*, freshly-probed value from
// `AggkitBridgeAggregator.getClaimInputs`, never read off the row here.
export const resolveLeafIndex = (tx: Transaction): number => tx.leafIndex;

const ZERO_HEX: Hex = '0x';

export const buildClaimAssetParams = (params: {
  transaction: Transaction;
  proof: ClaimProof;
}): ClaimAssetParams => {
  const { transaction, proof } = params;
  const metadata = isHex(transaction.metadata) ? transaction.metadata : ZERO_HEX;

  // AggkitTransaction.globalIndex (see @agglayer/sdk) is the SDK's own,
  // authoritative value -- aggkit computes it and ships it on the wire, so
  // there's no need to re-derive it client-side from depositCount/
  // sourceNetwork (that re-derivation duplicated the SDK's own formula --
  // see https://github.com/agglayer/sdk/blob/main/src/native/bridge/util.ts
  // -- and risked drifting from it). `Transaction.globalIndex` is only
  // optional on the app's own type for older/synthetic rows; toTransaction
  // (activity.ts) always sets it from the wire's bridge.global_index, so a
  // real claim never reaches this without it.
  if (transaction.globalIndex === undefined) {
    throw new Error('Transaction is missing globalIndex');
  }

  return {
    smtProofLocalExitRoot: proof.proof_local_exit_root,
    smtProofRollupExitRoot: proof.proof_rollup_exit_root,
    globalIndex: BigInt(transaction.globalIndex),
    mainnetExitRoot: proof.l1_info_tree_leaf.mainnet_exit_root,
    rollupExitRoot: proof.l1_info_tree_leaf.rollup_exit_root,
    originNetwork: transaction.originTokenNetwork,
    originTokenAddress: transaction.originTokenAddress,
    destinationNetwork: transaction.destinationNetwork,
    destinationAddress: transaction.receiverAddress,
    amount: BigInt(transaction.amount),
    metadata
  };
};

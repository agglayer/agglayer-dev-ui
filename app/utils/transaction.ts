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

// Extra gas added on top of the SDK's eth_estimateGas for a claimAsset send.
// Load test 2026-10-16 (history/2026-10-16__bali-all__bridge-loadtest-ramp-82-85-saturation.md,
// finding A): 4 claims ran out of gas because the bufferless estimate for a
// first-mint wrapped-token claim (202,542) was taken before concurrent claims
// changed state; execution then needed ~228k, up to ~245.5k. Additive rather
// than a percentage because the shortfall is fixed storage/mint cost, not
// proportional to the estimate. +60,000 gives 262,542 for that case, ~17k
// above the worst gas seen. Gas limit is a cap and unused gas is refunded, so
// the only cost is that the wallet must hold gasLimit * maxFeePerGas up front.
export const CLAIM_GAS_BUFFER = BigInt(60_000);

// `options.gasBuffer` opts a call into forwarding the SDK's `gas` plus the
// buffer. Without it (approve, bridge) or when the SDK supplies no `gas`, no
// `gas` key is emitted and viem/the wallet estimates as before.
export const mapTransactionRequest = (
  params: TransactionParams,
  options?: { gasBuffer?: bigint }
) => {
  const to = isValidEthereumAddress(params.to) ? params.to : undefined;
  if (!to) throw new Error('Invalid transaction recipient');

  const data = isHex(params.data) ? params.data : undefined;
  if (!data) throw new Error('Invalid transaction data');

  return {
    to,
    data,
    value: toBigInt(params.value),
    ...(options?.gasBuffer !== undefined && params.gas
      ? { gas: BigInt(params.gas) + options.gasBuffer }
      : {})
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
    metadata
  };
};

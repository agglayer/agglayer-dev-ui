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

// Gas headroom added on top of the SDK's estimate for a **bridge send only**
// (finding C5, loadtest/DESIGN.md §9.4; measured in
// loadtest/CAPACITY-REPORT.md §5.3).
//
// The UI bridges with `forceUpdateGlobalExitRoot: true`, so `bridgeAsset` calls
// into GlobalExitRootV2. When the global exit root moves between the estimate
// and inclusion, that inner call costs more than the estimate saw and runs OUT
// OF GAS. EIP-150's 63/64 rule leaves the OUTER frame enough gas to return, so
// the receipt is a plain revert with `gasUsed` at only ~97% of the limit — it
// does **not** look like an out-of-gas failure from the receipt alone, and
// `eth_call` replayed against the parent block succeeds. The cause is only
// visible in a `callTracer` trace, whose innermost frame reads `out of gas`.
//
// Sized from measurement, not taste (compose devnet, browser-only, 20 users, an
// otherwise idle system): 46 of 1019 L1 `bridgeAsset` calls — 4.5% — reverted
// this way. Successful calls used up to 240,603 gas, while the bufferless
// estimates that reverted carried limits of 186,507 (median) / 231,281 (max).
// A conventional 10–25% multiplier does not cover that gap; this is the same
// +300,000 the headless load-test worker applies as `gas.bridgeGasOffset`,
// which saw zero such reverts across ~40,000 bridges in the same campaign.
//
// A gas limit is a cap, not a charge — unused gas is refunded — so the only
// cost is that the sender must hold `gasLimit * maxFeePerGas` at send time.
// (`BigInt(...)` rather than a `300_000n` literal: tsconfig targets < ES2020.)
export const BRIDGE_GAS_BUFFER = BigInt(300_000);

// `options.gasBuffer` is added to the SDK's `gas` when (and only when) the SDK
// supplied one. If it ever stops supplying `gas`, no `gas` key is emitted at
// all and viem re-estimates at send time — bufferless, so the C5 revert above
// would return on that path. That is asserted by a test rather than silently
// assumed.
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
    // Forward the SDK's own gas estimate to skip a redundant client-side
    // eth_estimateGas (finding C4, loadtest/DESIGN.md §9.3) -- the SDK's
    // estimator is a bare, bufferless pass-through (see
    // @agglayer/sdk src/native/bridge/build.ts's estimateGas), which is why a
    // call site that races the global exit root has to add its own headroom
    // via `options.gasBuffer`. Deliberately conditional so a
    // TransactionParams without `gas` produces no `gas` key at all, matching
    // today's behaviour exactly. `params.gas` is a string on the SDK type;
    // viem's request wants a bigint.
    //
    // `nonce` is deliberately NOT forwarded here: unlike gas, a nonce fixed at
    // build time can go stale while a human spends seconds-to-minutes signing
    // in their wallet, colliding with or gapping other transactions.
    //
    // Finding C5 (forwarding a bufferless estimate does not stop a
    // forceUpdateGlobalExitRoot bridge running OutOfGas) is closed by
    // `options.gasBuffer` — see BRIDGE_GAS_BUFFER above. It is opt-in per call
    // site, not applied here unconditionally: only the bridge send races the
    // global exit root. Approve is a plain ERC20 approve and claims do not
    // force-update the GER; neither showed a single out-of-gas revert in the
    // measurement above, so their estimates are left exactly as they were.
    ...(params.gas ? { gas: BigInt(params.gas) + (options?.gasBuffer ?? BigInt(0)) } : {})
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

import type { Hex } from 'viem';

import { isHex } from 'viem';

import type { AggkitClaimProof } from '@agglayer/sdk';

// Same shape `buildClaimAssetParams` (utils/transaction.ts) already expects —
// preserved so that function stays unchanged (design.md §7.2). The aggkit SDK
// returns these fields as plain `string`, not viem's `Hex` brand, so we
// narrow with `isHex` (a type guard, not a cast) at this one boundary rather
// than threading `as Hex` through call sites — see team standards on
// narrowing `unknown`/loosely-typed external data instead of casting it.
export type ClaimProof = {
  proof_local_exit_root: Hex[];
  proof_rollup_exit_root: Hex[];
  l1_info_tree_leaf: {
    block_num: number;
    block_pos: number;
    l1_info_tree_index: number;
    previous_block_hash: string;
    timestamp: number;
    mainnet_exit_root: Hex;
    rollup_exit_root: Hex;
    global_exit_root: Hex;
    hash: Hex;
  };
};

const toHex = (value: string, field: string): Hex => {
  if (!isHex(value)) {
    throw new Error(`CLAIM_PROOF_INVALID_HEX: ${field} is not a hex string`);
  }
  return value;
};

const toHexArray = (values: string[], field: string): Hex[] =>
  values.map((value, index) => toHex(value, `${field}[${index}]`));

export const toClaimProof = (proof: AggkitClaimProof): ClaimProof => ({
  proof_local_exit_root: toHexArray(proof.proof_local_exit_root, 'proof_local_exit_root'),
  proof_rollup_exit_root: toHexArray(proof.proof_rollup_exit_root, 'proof_rollup_exit_root'),
  l1_info_tree_leaf: {
    block_num: proof.l1_info_tree_leaf.block_num,
    block_pos: proof.l1_info_tree_leaf.block_pos,
    l1_info_tree_index: proof.l1_info_tree_leaf.l1_info_tree_index,
    previous_block_hash: proof.l1_info_tree_leaf.previous_block_hash,
    timestamp: proof.l1_info_tree_leaf.timestamp,
    mainnet_exit_root: toHex(proof.l1_info_tree_leaf.mainnet_exit_root, 'mainnet_exit_root'),
    rollup_exit_root: toHex(proof.l1_info_tree_leaf.rollup_exit_root, 'rollup_exit_root'),
    global_exit_root: toHex(proof.l1_info_tree_leaf.global_exit_root, 'global_exit_root'),
    hash: toHex(proof.l1_info_tree_leaf.hash, 'hash')
  }
});

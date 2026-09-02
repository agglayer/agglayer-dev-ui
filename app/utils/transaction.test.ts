import type { ClaimProof } from '@/app/services/claimProof';
import type { Transaction } from '@/app/types/transaction';

import { describe, expect, it } from 'vitest';

import { buildClaimAssetParams } from './transaction';

// The formula buildClaimAssetParams used to re-derive client-side before
// review comment 3862949281 (C13) -- see @agglayer/sdk's
// src/native/bridge/util.ts, which computes the same thing. Kept here ONLY
// to prove the SDK's own AggkitTransaction.globalIndex (now read straight
// off `Transaction.globalIndex`, no re-derivation) still lines up with it
// for representative LxLy fixtures -- the app no longer computes this
// itself.
const GLOBAL_INDEX_MAINNET_FLAG = BigInt(2) ** BigInt(64);
const GLOBAL_INDEX_NETWORK_OFFSET = BigInt(2) ** BigInt(32);
const oldComputeGlobalIndex = (depositCount: number, sourceNetworkId: number): bigint =>
  sourceNetworkId === 0
    ? BigInt(depositCount) + GLOBAL_INDEX_MAINNET_FLAG
    : BigInt(depositCount) + BigInt(sourceNetworkId - 1) * GLOBAL_INDEX_NETWORK_OFFSET;

const baseTransaction: Transaction = {
  hubUID: 'bridge-1',
  txSender: '0x1',
  fromAddress: '0x1',
  receiverAddress: '0x2',
  sourceNetwork: 0,
  destinationNetwork: 1,
  amount: '1000',
  status: 'READY_TO_CLAIM',
  lastUpdatedAt: 0,
  bridgeHash: '0xhash',
  metadata: '0x',
  leafType: 'asset',
  depositCount: 0,
  transactionIndex: 0,
  transactionHash: '0xdeposit',
  blockNumber: 0,
  originTokenAddress: '0x0000000000000000000000000000000000000000',
  originTokenNetwork: 0,
  timestamp: 0,
  leafIndex: 0
};

const claimProof: ClaimProof = {
  proof_local_exit_root: ['0x1'],
  proof_rollup_exit_root: ['0x2'],
  l1_info_tree_leaf: {
    block_num: 1,
    block_pos: 0,
    l1_info_tree_index: 1,
    previous_block_hash: '0x0',
    timestamp: 0,
    mainnet_exit_root: '0x3',
    rollup_exit_root: '0x4',
    global_exit_root: '0x5',
    hash: '0x6'
  }
};

describe('buildClaimAssetParams — globalIndex parity with the old client-side derivation', () => {
  it('matches the old mainnet-flag formula (L1->L2: sourceNetwork 0)', () => {
    const depositCount = 3;
    const sourceNetwork = 0;
    const expected = oldComputeGlobalIndex(depositCount, sourceNetwork);

    const transaction: Transaction = {
      ...baseTransaction,
      depositCount,
      sourceNetwork,
      globalIndex: expected.toString()
    };

    const params = buildClaimAssetParams({ transaction, proof: claimProof });

    expect(params.globalIndex).toBe(expected);
  });

  it('matches the old rollup-offset formula (L2->L1/L2->L2: sourceNetwork > 0)', () => {
    const depositCount = 7;
    const sourceNetwork = 2;
    const expected = oldComputeGlobalIndex(depositCount, sourceNetwork);

    const transaction: Transaction = {
      ...baseTransaction,
      depositCount,
      sourceNetwork,
      globalIndex: expected.toString()
    };

    const params = buildClaimAssetParams({ transaction, proof: claimProof });

    expect(params.globalIndex).toBe(expected);
  });

  it('throws instead of silently building a claim with no globalIndex', () => {
    const transaction: Transaction = { ...baseTransaction, globalIndex: undefined };

    expect(() => buildClaimAssetParams({ transaction, proof: claimProof })).toThrow(
      'Transaction is missing globalIndex'
    );
  });
});

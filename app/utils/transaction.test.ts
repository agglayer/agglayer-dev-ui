import type { ClaimProof } from '@/app/services/claimProof';
import type { Transaction } from '@/app/types/transaction';

import { fetchActivity } from '@/app/services/activity';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

// One trimmed row exactly as the aggkit rc8 devnet activity endpoint sends it
// for an L1-origin deposit: `global_index` is a bare JSON *number*, and its
// value is 2^64 + deposit_count. Written as raw text (not an object literal
// run through JSON.stringify) because the whole point is the digits on the
// wire -- a JS number literal here would already have lost them.
const L1_ORIGIN_WIRE_RESPONSE = `{
  "from_address": [],
  "bridges": [
    {
      "bridge": {
        "tx_hash": "0xdeposit",
        "amount": "1000",
        "block_num": 199,
        "block_pos": 0,
        "block_timestamp": 0,
        "bridge_hash": "0xhash",
        "deposit_count": 1,
        "destination_address": "0x2",
        "destination_network": 1,
        "global_index": 18446744073709551617,
        "leaf_type": 0,
        "metadata": "0x",
        "origin_address": "0x0000000000000000000000000000000000000000",
        "origin_network": 0,
        "to_address": "0x2",
        "txn_sender": "0x1"
      },
      "bridge_network_id": 0,
      "claimed": "false",
      "creation_timestamp": 0,
      "last_updated_timestamp": 0
    }
  ]
}`;

// The parity tests above hand buildClaimAssetParams an already-exact decimal
// string, so they cannot see the failure mode C13 actually shipped: the
// activity endpoint sends `global_index` as a bare JSON *number*, and an
// L1-origin deposit's value is 2^64 + deposit_count -- past IEEE-754 integer
// precision. Read with `response.json()` it rounded to a flat 2^64, so every
// manual claim of an L1-origin deposit with deposit_count > 0 was built with a
// globalIndex short by exactly deposit_count. This exercises the real path --
// wire text -> fetchActivity -> toTransaction -> buildClaimAssetParams -- and
// asserts the exact index survives all of it.
describe('buildClaimAssetParams — globalIndex precision from the wire (C13)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the claim with the exact 2^64 + deposit_count index, not the rounded double', async () => {
    const depositCount = 1;
    const exact = BigInt('18446744073709551617');
    const roundedByDouble = BigInt(2) ** BigInt(64); // 18446744073709551616
    // Same value the old client-side derivation would have produced, i.e.
    // this is still the parity check -- just carried over the real wire.
    expect(exact).toBe(oldComputeGlobalIndex(depositCount, 0));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(L1_ORIGIN_WIRE_RESPONSE),
        // Deliberately also stubbed: the pre-fix fetchActivity read the body
        // with response.json(), which rounds. Keeping json() here means this
        // test keeps FAILING (rather than erroring on a missing mock method)
        // if the parse ever regresses back to it -- it is part of the guard,
        // not an incidental stub detail.
        json: () => Promise.resolve(JSON.parse(L1_ORIGIN_WIRE_RESPONSE))
      })
    );

    const { transactions } = await fetchActivity({
      baseUrl: 'https://proxy.example',
      fromAddress: '0x1'
    });
    const [transaction] = transactions;

    expect(transaction.depositCount).toBe(depositCount);
    expect(transaction.sourceNetwork).toBe(0);
    expect(transaction.globalIndex).toBe('18446744073709551617');

    const params = buildClaimAssetParams({ transaction, proof: claimProof });

    expect(params.globalIndex).toBe(exact);
    expect(params.globalIndex).not.toBe(roundedByDouble);
  });
});

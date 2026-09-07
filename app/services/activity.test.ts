import { describe, expect, it, vi } from 'vitest';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

import { deriveStatus, fetchActivity, toTransaction } from './activity';

const baseBridge = {
  tx_hash: '0xabc',
  amount: '1000',
  block_num: 10,
  block_pos: 1,
  block_timestamp: 100,
  bridge_hash: '0xhash',
  deposit_count: 5,
  destination_address: '0xdest',
  destination_network: 1,
  global_index: '5',
  leaf_type: 0,
  metadata: '0x',
  origin_address: '0xorigin',
  origin_network: 0,
  to_address: '0xdest',
  txn_sender: '0xsender'
};

describe('deriveStatus', () => {
  it('maps claimed "true" to CLAIMED', () => {
    expect(deriveStatus({ claimed: 'true' })).toEqual({ status: 'CLAIMED' });
  });

  it('maps claimed "error" to ERROR, surfacing errors.claim', () => {
    expect(
      deriveStatus({ claimed: 'error', errors: { claim: 'no bridge contract configured' } })
    ).toEqual({
      status: 'ERROR',
      statusError: 'no bridge contract configured'
    });
  });

  it('maps unclaimed with no tracking yet to PENDING', () => {
    expect(deriveStatus({ claimed: 'false' })).toEqual({ status: 'PENDING' });
  });

  it('maps unclaimed + current step WaitingClaim/inProgress to READY_TO_CLAIM', () => {
    expect(
      deriveStatus({
        claimed: 'false',
        tracking: {
          tracking_status: 'running',
          network_id: 0,
          tx_hash: '0xabc',
          bridge_status: null,
          step_index: 0,
          all_steps: [{ step_index: 0, step_name: 'WaitingClaim', status: 'inProgress' }],
          error: null
        }
      })
    ).toEqual({ status: 'READY_TO_CLAIM' });
  });

  it('maps unclaimed + current step WaitingClaim/done to PENDING (claimed flag not caught up yet)', () => {
    expect(
      deriveStatus({
        claimed: 'false',
        tracking: {
          tracking_status: 'finished',
          network_id: 0,
          tx_hash: '0xabc',
          bridge_status: null,
          step_index: 1,
          all_steps: [
            { step_index: 0, step_name: 'WaitingClaim', status: 'done' },
            { step_index: 1, step_name: 'Claimed', status: 'done' }
          ],
          error: null
        }
      })
    ).toEqual({ status: 'PENDING' });
  });

  it('maps unclaimed + an earlier step in progress to PENDING', () => {
    expect(
      deriveStatus({
        claimed: 'false',
        tracking: {
          tracking_status: 'running',
          network_id: 0,
          tx_hash: '0xabc',
          bridge_status: null,
          step_index: 0,
          all_steps: [
            { step_index: 0, step_name: 'WaitingGERUpdate', status: 'inProgress' },
            { step_index: 1, step_name: 'WaitingClaim', status: 'pending' }
          ],
          error: null
        }
      })
    ).toEqual({ status: 'PENDING' });
  });
});

describe('toTransaction', () => {
  it('maps a claimed bridge, preferring bridge.destination_network over the raw origin/destination pair', () => {
    const tx = toTransaction({
      bridge: baseBridge,
      bridge_network_id: 0,
      claim: {
        tx_hash: '0xclaim',
        amount: '1000',
        block_num: 20,
        block_timestamp: 200,
        destination_address: '0xdest',
        destination_network: 1,
        from_address: '0xsender',
        global_exit_root: '0xger',
        global_index: '5',
        is_message: false,
        mainnet_exit_root: '0xmer',
        metadata: '0x',
        origin_address: '0xorigin',
        origin_network: 0,
        proof_local_exit_root: [],
        proof_rollup_exit_root: [],
        rollup_exit_root: '0xrer'
      },
      claim_network_id: 1,
      claimed: 'true',
      creation_timestamp: 50,
      last_updated_timestamp: 200
    });

    expect(tx.status).toBe('CLAIMED');
    // hubUID is tx_hash + deposit_count, NOT bridge_hash -- see toHubUID.
    expect(tx.hubUID).toBe('0xabc:5');
    expect(tx.bridgeHash).toBe('0xhash');
    // sourceNetwork is the RECORDING network (bridge_network_id), not the
    // token's origin_network -- see getRouteType/autoclaim consumers.
    expect(tx.sourceNetwork).toBe(0);
    expect(tx.destinationNetwork).toBe(1);
    expect(tx.originTokenAddress).toBe('0xorigin');
    expect(tx.originTokenNetwork).toBe(0);
    expect(tx.leafIndex).toBe(5);
    expect(tx.depositCount).toBe(5);
    expect(tx.claimTransactionHash).toBe('0xclaim');
    expect(tx.claimBlockNumber).toBe(20);
  });

  it('maps leaf_type 1 to "message" and 0 to "asset"', () => {
    const asset = toTransaction({
      bridge: baseBridge,
      bridge_network_id: 0,
      claimed: 'false',
      creation_timestamp: 50,
      last_updated_timestamp: 50
    });
    const message = toTransaction({
      bridge: { ...baseBridge, leaf_type: 1 },
      bridge_network_id: 0,
      claimed: 'false',
      creation_timestamp: 50,
      last_updated_timestamp: 50
    });

    expect(asset.leafType).toBe('asset');
    expect(message.leafType).toBe('message');
  });

  it('falls back fromAddress to txn_sender when bridge.from_address is absent', () => {
    const tx = toTransaction({
      bridge: baseBridge,
      bridge_network_id: 0,
      claimed: 'false',
      creation_timestamp: 50,
      last_updated_timestamp: 50
    });
    expect(tx.fromAddress).toBe('0xsender');
  });
});

// fetchActivity is now a thin wrapper over AggkitBridgeAggregator.getActivity
// (agglayer/sdk#30/#31) instead of calling fetch() directly -- the request/
// response parsing and error handling live in the SDK now, so this only
// needs to mock the aggregator's own return value / rejection.
const makeMockAggregator = (
  getActivity: AggkitBridgeAggregator['getActivity']
): AggkitBridgeAggregator => ({ getActivity }) as unknown as AggkitBridgeAggregator;

// fetchActivity no longer stubs the global fetch: it goes through the
// aggregator passed in, so these mocks just stub `getActivity`'s resolved
// value / rejection directly.
describe('fetchActivity', () => {
  it('requests includeTracking: true and maps the returned bridges', async () => {
    const getActivity = vi.fn().mockResolvedValue({
      bridges: [
        {
          bridge: baseBridge,
          bridge_network_id: 0,
          claimed: 'true',
          creation_timestamp: 0,
          last_updated_timestamp: 0
        }
      ],
      warnings: []
    });

    const result = await fetchActivity({
      aggregator: makeMockAggregator(getActivity),
      fromAddress: '0xabc'
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].status).toBe('CLAIMED');
    expect(result.warnings).toEqual([]);
    expect(getActivity).toHaveBeenCalledWith({
      fromAddress: '0xabc',
      includeTracking: true
    });
  });

  it('passes through the warnings array when present', async () => {
    const getActivity = vi.fn().mockResolvedValue({
      bridges: [],
      warnings: [
        {
          network_id: 84,
          message: 'fetching bridges from 0x43...: dial tcp 34.147.196.6:5577: no route to host'
        }
      ]
    });

    const result = await fetchActivity({
      aggregator: makeMockAggregator(getActivity),
      fromAddress: '0xabc'
    });

    expect(result.warnings).toEqual([
      {
        network_id: 84,
        message: 'fetching bridges from 0x43...: dial tcp 34.147.196.6:5577: no route to host'
      }
    ]);
  });

  it('keeps every distinct deposit that shares one bridge_hash, with a unique hubUID each', async () => {
    // Live shape from the aggkit rc8 devnet: bridge_hash is a CONTENT hash
    // (origin/destination network + address, amount, metadata), so five
    // separate native-ETH bridges of the identical amount to the identical
    // receiver all reported the same bridge_hash -- same bridge_network_id,
    // but genuinely different tx_hash / deposit_count / block_num. An
    // earlier bridge_hash dedupe here silently dropped four real
    // transactions; nothing may be dropped, and each row still needs its own
    // React key (transactionList.tsx keys on tx.hubUID).
    const sharedBridgeHash = '0xae7da905f5e09ee99f9e0c4b8f9b255ff42a1522dbe61f8066c53c8c49a5377f';
    const deposits = [
      { tx_hash: '0xtx3', deposit_count: 3, block_num: 309 },
      { tx_hash: '0xtx4', deposit_count: 4, block_num: 324 },
      { tx_hash: '0xtx5', deposit_count: 5, block_num: 593 },
      { tx_hash: '0xtx6', deposit_count: 6, block_num: 835 },
      { tx_hash: '0xtx7', deposit_count: 7, block_num: 883 }
    ];
    const getActivity = vi.fn().mockResolvedValue({
      bridges: deposits.map((deposit) => ({
        bridge: { ...baseBridge, ...deposit, bridge_hash: sharedBridgeHash },
        bridge_network_id: 0,
        claimed: 'false',
        creation_timestamp: 0,
        last_updated_timestamp: 0
      })),
      warnings: []
    });

    const result = await fetchActivity({
      aggregator: makeMockAggregator(getActivity),
      fromAddress: '0xabc'
    });

    expect(result.transactions).toHaveLength(5);
    expect(result.transactions.map((tx) => tx.transactionHash)).toEqual([
      '0xtx3',
      '0xtx4',
      '0xtx5',
      '0xtx6',
      '0xtx7'
    ]);
    expect(result.transactions.map((tx) => tx.hubUID)).toEqual([
      '0xtx3:3',
      '0xtx4:4',
      '0xtx5:5',
      '0xtx6:6',
      '0xtx7:7'
    ]);
    expect(new Set(result.transactions.map((tx) => tx.hubUID)).size).toBe(5);
  });

  it('gives distinct hubUIDs to two deposits batched into one transaction', async () => {
    const getActivity = vi.fn().mockResolvedValue({
      bridges: [0, 1].map((depositCount) => ({
        bridge: { ...baseBridge, tx_hash: '0xbatched', deposit_count: depositCount },
        bridge_network_id: 0,
        claimed: 'false',
        creation_timestamp: 0,
        last_updated_timestamp: 0
      })),
      warnings: []
    });

    const result = await fetchActivity({
      aggregator: makeMockAggregator(getActivity),
      fromAddress: '0xabc'
    });

    expect(result.transactions.map((tx) => tx.hubUID)).toEqual(['0xbatched:0', '0xbatched:1']);
  });

  it('propagates a genuine aggregator failure (e.g. AggkitApiError) rather than swallowing it', async () => {
    const getActivity = vi.fn().mockRejectedValue(new Error('invalid from_address'));

    await expect(
      fetchActivity({
        aggregator: makeMockAggregator(getActivity),
        fromAddress: 'not-an-address'
      })
    ).rejects.toThrow('invalid from_address');
  });
});

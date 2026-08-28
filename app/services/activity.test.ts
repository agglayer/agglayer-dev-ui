import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveStatus, fetchActivity, resolveAggkitProxyBaseUrl, toTransaction } from './activity';

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
    expect(tx.hubUID).toBe('0xhash');
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

describe('resolveAggkitProxyBaseUrl', () => {
  it('returns any one URL from the per-network map (they are all identical)', () => {
    expect(
      resolveAggkitProxyBaseUrl({ 1: 'https://proxy.example', 2: 'https://proxy.example' })
    ).toBe('https://proxy.example');
  });

  it('returns undefined when the mode has no configured networks', () => {
    expect(resolveAggkitProxyBaseUrl({})).toBeUndefined();
  });
});

describe('fetchActivity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests includeTracking=true and maps the returned bridges', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          from_address: [],
          bridges: [
            {
              bridge: baseBridge,
              bridge_network_id: 0,
              claimed: 'true',
              creation_timestamp: 0,
              last_updated_timestamp: 0
            }
          ]
        })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchActivity({ baseUrl: 'https://proxy.example', fromAddress: '0xabc' });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('CLAIMED');
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toBe('/tracker/v1/activity/from/0xabc');
    expect(requestedUrl.searchParams.get('includeTracking')).toBe('true');
  });

  it('throws with the server-provided message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ code: 400, message: 'invalid from_address' })
      })
    );

    await expect(
      fetchActivity({ baseUrl: 'https://proxy.example', fromAddress: 'not-an-address' })
    ).rejects.toThrow('invalid from_address');
  });
});

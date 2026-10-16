// S53 / heavy-load design F3: a tracker `activity` failure keeps its class when
// it leaves `performActivityFetch`, and a "not ready yet" 503 is not retried by
// the single-flight poller (the runner backs off to the UI cadence instead).
import type { Address } from 'viem';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCollector } from '../../metrics/collector';
import { ClassifiedFetchError } from '../../metrics/errors';
import { buildTestDevnetConfig } from '../../wallets/testHelpers';
import { HeadlessUser } from './headlessUser';

const USER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const build = async () => {
  const config = buildTestDevnetConfig({ usersTotal: 1 });
  const user = new HeadlessUser({
    userId: 'u1',
    account: { address: USER } as never,
    chains: config.chains,
    assets: config.assets,
    aggkitProxyUrl: 'http://127.0.0.1:1',
    bridgeGasOffset: 0,
    collector: createCollector()
  });
  await user.init();
  return user;
};

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

const stubFetch = (response: () => Response) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return response();
  }) as typeof fetch;
  return calls;
};

describe('HeadlessUser.observeActivity — tracker failures keep their class (F3)', () => {
  it('a 503 "not ready yet" throws a ClassifiedFetchError(tracker_not_ready, 503) with Retry-After in the message, and is NOT retried', async () => {
    const user = await build();
    const calls = stubFetch(
      () =>
        new Response('activity for this address is not ready yet, retry after 5s', {
          status: 503,
          headers: { 'Retry-After': '5' }
        })
    );

    const error = await user.observeActivity().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClassifiedFetchError);
    const classified = error as ClassifiedFetchError;
    expect(classified.errorClass).toBe('tracker_not_ready');
    expect(classified.status).toBe(503);
    expect(classified.message).toContain('not ready yet');
    expect(classified.message).toContain('Retry-After: 5');
    expect(calls).toHaveLength(1);
  });

  it('a 503 "registry is full" is a proxy_5xx (a real limit that SC4 must see) and keeps the poller retries', async () => {
    const user = await build();
    const calls = stubFetch(() => new Response('activity registry is full', { status: 503 }));

    const error = await user.observeActivity().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClassifiedFetchError);
    expect((error as ClassifiedFetchError).errorClass).toBe('proxy_5xx');
    // First try plus two poller retries (3 attempts, 300 ms apart).
    expect(calls).toHaveLength(3);
  });

  it('a 4xx keeps its class too (proxy_4xx), not internal', async () => {
    const user = await build();
    stubFetch(() => new Response('bad request', { status: 400 }));
    const error = await user.observeActivity().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClassifiedFetchError);
    expect((error as ClassifiedFetchError).errorClass).toBe('proxy_4xx');
  });
});

// Issue #53 (ring K, deposits 1345 / 1986): a tracker row reading `claimed`
// without a claim object, while the destination bridge's `isClaimed` is false,
// ended the hop as `hop_completed_auto` and stranded the deposit.
describe('HeadlessUser.observeActivity — unproven tracker `claimed` is not trusted (#53)', () => {
  const claimedBody = (withClaimObject: boolean) =>
    JSON.stringify({
      bridges: [
        {
          bridge: {
            tx_hash: '0xbbbb000000000000000000000000000000000000000000000000000000000001',
            amount: '10000000000000',
            block_num: 100,
            block_pos: 0,
            block_timestamp: 1_700_000_000,
            bridge_hash: '0xhash',
            deposit_count: 1345,
            destination_address: USER,
            destination_network: 1,
            from_address: USER,
            global_index: '5',
            leaf_type: 0,
            metadata: '0x',
            origin_address: '0x0000000000000000000000000000000000000000',
            origin_network: 0,
            to_address: USER,
            txn_sender: USER
          },
          bridge_network_id: 0,
          claim_status: 'claimed',
          ...(withClaimObject
            ? { claim: { tx_hash: '0xc1a1', block_num: 7, block_timestamp: 8, global_index: '5' } }
            : {}),
          creation_timestamp: 1,
          last_updated_timestamp: 2
        }
      ]
    });

  const stubChain = async (isClaimed: () => Promise<boolean>) => {
    const user = await build();
    const bridge = vi.fn(() => ({ isClaimed }));
    (user as unknown as { native: unknown }).native = { bridge };
    return { user, bridge };
  };

  it('demotes a CLAIMED row with no claim object to PENDING when isClaimed is false on the destination', async () => {
    const { user, bridge } = await stubChain(async () => false);
    stubFetch(() => new Response(claimedBody(false), { status: 200 }));

    const rows = await user.observeActivity();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PENDING');
    expect(bridge).toHaveBeenCalled();
  });

  it('demotes it when the on-chain read throws (an error is never "claimed")', async () => {
    const { user } = await stubChain(async () => {
      throw new Error('rpc down');
    });
    stubFetch(() => new Response(claimedBody(false), { status: 200 }));

    expect((await user.observeActivity())[0]?.status).toBe('PENDING');
  });

  it('keeps CLAIMED when the destination confirms isClaimed', async () => {
    const { user } = await stubChain(async () => true);
    stubFetch(() => new Response(claimedBody(false), { status: 200 }));

    expect((await user.observeActivity())[0]?.status).toBe('CLAIMED');
  });

  it('keeps CLAIMED, with no RPC read, when the tracker row carries a claim object', async () => {
    const { user, bridge } = await stubChain(async () => false);
    stubFetch(() => new Response(claimedBody(true), { status: 200 }));

    expect((await user.observeActivity())[0]?.status).toBe('CLAIMED');
    expect(bridge).not.toHaveBeenCalled();
  });
});

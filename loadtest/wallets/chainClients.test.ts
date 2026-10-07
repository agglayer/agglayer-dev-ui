import { describe, expect, it, vi } from 'vitest';

import { ChainNonceManager } from './chainClients';

interface FakePublicClient {
  getTransactionCount: (...args: unknown[]) => Promise<number>;
}

const buildManager = (publicClient: FakePublicClient): ChainNonceManager =>
  new ChainNonceManager(publicClient as never, '0x0000000000000000000000000000000000000001');

describe('ChainNonceManager — DESIGN §4.4', () => {
  it('seeds once from eth_getTransactionCount(pending) and hands out sequential nonces', async () => {
    const getTransactionCount = vi.fn(async () => 10);
    const manager = buildManager({ getTransactionCount });

    const nonces = await Promise.all([
      manager.nextNonce(),
      manager.nextNonce(),
      manager.nextNonce()
    ]);

    expect(nonces).toStrictEqual([10, 11, 12]);
    expect(getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent callers — no two callers ever observe the same nonce', async () => {
    const getTransactionCount = vi.fn(async () => 0);
    const manager = buildManager({ getTransactionCount });

    const nonces = await Promise.all(Array.from({ length: 20 }, () => manager.nextNonce()));
    const unique = new Set(nonces);
    expect(unique.size).toBe(20);
    expect([...nonces].sort((a, b) => a - b)).toStrictEqual(
      Array.from({ length: 20 }, (_, i) => i)
    );
  });

  it('re-seeds from the node after onSendError instead of trusting the stale in-memory counter', async () => {
    const getTransactionCount = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(5) // first seed
      .mockResolvedValueOnce(9); // re-seed after error, node has advanced past what the manager expected
    const manager = buildManager({ getTransactionCount });

    expect(await manager.nextNonce()).toBe(5);
    manager.onSendError();
    expect(await manager.nextNonce()).toBe(9);
    expect(getTransactionCount).toHaveBeenCalledTimes(2);
  });
});

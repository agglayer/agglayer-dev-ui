// S53: the harness samplers against fake clients — M1 wallet balances, M3 L1
// info tree leaves, and the periodic scheduler (vitest fake timers). Every
// address, hash and key below is a made-up placeholder.
import type { Address, Hex } from 'viem';

import { encodeAbiParameters, encodeEventTopics, toEventSelector } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { L1InfoTreeClient } from './samplers';

import { installTimingFetch, runWithFetchContext } from '../workers/headless/uiCallset';
import { createCollector, createMemoryActivitySink } from './collector';
import {
  createL1InfoTreePoller,
  createPeriodicTask,
  createWalletBalanceSampler,
  UPDATE_L1_INFO_TREE_V2
} from './samplers';

const wallet = (n: number) => ({
  userId: `u${n}`,
  address: `0x${n.toString(16).padStart(40, '0')}` as Address
});

const setup = () => {
  const sink = createMemoryActivitySink();
  const collector = createCollector({ clock: { now: () => Date.now() }, activitySink: sink });
  const records = (kind: string) =>
    sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.kind === kind);
  return { sink, collector, records };
};

describe('createWalletBalanceSampler (M1)', () => {
  it('writes one wallet_balance record per chain: n, min, true median, max and the three lowest wallets', async () => {
    const { collector, records } = setup();
    const balances: Record<string, bigint> = {};
    // 6 wallets: 5, 1, 9, 3, 7, 3 (wei)
    [5, 1, 9, 3, 7, 3].forEach((wei, i) => {
      balances[wallet(i).address] = BigInt(wei);
    });
    const sampler = createWalletBalanceSampler({
      chains: [{ key: 'BALI_82' }],
      wallets: [0, 1, 2, 3, 4, 5].map(wallet),
      readerFor: () => ({ getBalance: async ({ address }) => balances[address] }),
      collector
    });
    await sampler.sampleOnce();

    expect(records('wallet_balance')).toMatchObject([
      {
        chainKey: 'BALI_82',
        n: 6,
        minWei: '1',
        medianWei: '4', // sorted 1,3,3,5,7,9 -> (3 + 5) / 2
        maxWei: '9',
        lowest: [
          { userId: 'u1', wei: '1' },
          { userId: 'u3', wei: '3' },
          { userId: 'u5', wei: '3' }
        ]
      }
    ]);
    const samples = collector.snapshot().walletBalances;
    expect(samples).toHaveLength(1);
    expect(samples?.[0].chainKey).toBe('BALI_82');
  });

  it('samples every configured chain, each with its own reader', async () => {
    const { collector, records } = setup();
    const sampler = createWalletBalanceSampler({
      chains: [{ key: 'A' }, { key: 'B' }],
      wallets: [wallet(0), wallet(1)],
      readerFor: (chainKey) => ({ getBalance: async () => BigInt(chainKey === 'A' ? 10 : 20) }),
      collector
    });
    await sampler.sampleOnce();
    expect(records('wallet_balance').map((r) => [r.chainKey, r.minWei])).toStrictEqual([
      ['A', '10'],
      ['B', '20']
    ]);
  });

  it('reads at most `concurrency` wallets at once (default 5)', async () => {
    const { collector } = setup();
    let inFlight = 0;
    let peak = 0;
    const sampler = createWalletBalanceSampler({
      chains: [{ key: 'A' }],
      wallets: Array.from({ length: 23 }, (_, i) => wallet(i)),
      readerFor: () => ({
        getBalance: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return BigInt(1);
        }
      }),
      collector
    });
    await sampler.sampleOnce();
    expect(peak).toBe(5);
    expect(collector.snapshot().walletBalances?.[0].n).toBe(23);
  });

  it('a failed read drops that wallet from n instead of failing the sample; a chain with every read failing writes nothing', async () => {
    const { collector, records } = setup();
    const logs: string[] = [];
    const sampler = createWalletBalanceSampler({
      chains: [{ key: 'A' }, { key: 'DOWN' }],
      wallets: [wallet(0), wallet(1), wallet(2)],
      readerFor: (chainKey) => ({
        getBalance: async ({ address }) => {
          if (chainKey === 'DOWN')
            throw new Error(
              'HTTP request failed.\nURL: https://rpc.example.invalid/AbCdEf0123456789TokenXyz'
            );
          if (address === wallet(1).address) throw new Error('boom');
          return BigInt(7);
        }
      }),
      collector,
      logger: (line) => logs.push(line)
    });
    await expect(sampler.sampleOnce()).resolves.toBeUndefined();
    expect(records('wallet_balance')).toMatchObject([{ chainKey: 'A', n: 2, minWei: '7' }]);
    expect(logs.join('\n')).not.toContain('AbCdEf0123456789TokenXyz');
  });

  it('runs in a harness fetch context so its reads are never counted as UI traffic', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const { collector } = setup();
    const handle = installTimingFetch(collector, { now: () => Date.now() });
    try {
      const sampler = createWalletBalanceSampler({
        chains: [{ key: 'A' }],
        wallets: [wallet(0)],
        readerFor: () => ({
          getBalance: async () => {
            await fetch('http://rpc.example.invalid/', {
              method: 'POST',
              body: '{"method":"eth_getBalance"}'
            });
            return BigInt(1);
          }
        }),
        collector
      });
      await sampler.sampleOnce();
      await runWithFetchContext({ userId: 'u0', mode: 'headless' }, () =>
        fetch('http://rpc.example.invalid/', {
          method: 'POST',
          body: '{"method":"eth_getBalance"}'
        })
      );
    } finally {
      handle.uninstall();
      globalThis.fetch = original;
    }
    const entry = Object.values(collector.snapshot().http)[0];
    expect(entry.headless.harness?.n).toBe(1);
    expect(entry.headless.ui?.n).toBe(1);
    expect(collector.snapshot().uncontextedRequests).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M3
// ---------------------------------------------------------------------------

const BRIDGE: Address = '0x00000000000000000000000000000000000000a0';
const GER: Address = '0x00000000000000000000000000000000000000a1';

const leafLog = (
  blockNumber: number,
  leafCount: number,
  txHash: Hex,
  minTimestamp = 1_700_000_000
) => ({
  blockNumber: BigInt(blockNumber),
  transactionHash: txHash,
  topics: encodeEventTopics({
    abi: [UPDATE_L1_INFO_TREE_V2],
    eventName: 'UpdateL1InfoTreeV2',
    args: { leafCount }
  }) as readonly Hex[],
  data: encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
    [`0x${'11'.repeat(32)}`, BigInt(12345), BigInt(minTimestamp)]
  )
});

const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

interface FakeL1 {
  head: bigint;
  logs: ReturnType<typeof leafLog>[];
  leafCount: number;
  calls: {
    getUpdateLogs: { fromBlock: bigint; toBlock: bigint; address: Address }[];
    discovery: number;
  };
  failNextGetLogs: Error | null;
}

const fakeL1 = (over: Partial<FakeL1> = {}) => {
  const world: FakeL1 = {
    head: BigInt(1000),
    logs: [],
    leafCount: 500,
    calls: { getUpdateLogs: [], discovery: 0 },
    failNextGetLogs: null,
    ...over
  };
  const client: L1InfoTreeClient = {
    getBlockNumber: async () => world.head,
    getUpdateLogs: async ({ address, fromBlock, toBlock }) => {
      if (world.failNextGetLogs !== null) {
        const error = world.failNextGetLogs;
        world.failNextGetLogs = null;
        throw error;
      }
      world.calls.getUpdateLogs.push({ fromBlock, toBlock, address });
      return world.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readGlobalExitRootManager: async () => {
      world.calls.discovery += 1;
      return GER;
    },
    readLeafCount: async () => world.leafCount
  };
  return { world, client };
};

describe('UpdateL1InfoTreeV2 event definition (M3)', () => {
  it('has the topic0 the design recorded for the Sepolia GER manager (0xaf6c6cd7...0813a59)', () => {
    const topic = toEventSelector(UPDATE_L1_INFO_TREE_V2);
    expect(topic.startsWith('0xaf6c6cd7')).toBe(true);
    expect(topic.endsWith('0813a59')).toBe(true);
  });
});

describe('createL1InfoTreePoller (M3)', () => {
  it('first poll: discovers the GER manager through the bridge, reads the baseline leaf count and the head — no leaves yet', async () => {
    const { collector, records } = setup();
    const { world, client } = fakeL1();
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      client,
      collector,
      isPumpTx: () => false
    });
    await poller.pollOnce();

    expect(world.calls.discovery).toBe(1);
    expect(world.calls.getUpdateLogs).toHaveLength(0);
    expect(records('l1_info_leaf')).toHaveLength(0);
    expect(collector.snapshot().l1InfoTree).toStrictEqual({
      gerManagerAddress: GER,
      baselineLeafCount: 500,
      leaves: [],
      pollErrors: 0
    });
  });

  it('an explicit gerManagerAddress skips discovery and is what getLogs targets', async () => {
    const { collector } = setup();
    const { world, client } = fakeL1();
    const explicit: Address = '0x00000000000000000000000000000000000000c3';
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      gerManagerAddress: explicit,
      client,
      collector,
      isPumpTx: () => false
    });
    await poller.pollOnce();
    world.head = BigInt(1010);
    await poller.pollOnce();
    expect(world.calls.discovery).toBe(0);
    expect(world.calls.getUpdateLogs[0].address).toBe(explicit);
    expect(collector.snapshot().l1InfoTree?.gerManagerAddress).toBe(explicit);
  });

  it('reports each new leaf once, with block, leafCount, tx hash, minTimestamp and the fromPump flag', async () => {
    const { collector, records } = setup();
    const { world, client } = fakeL1();
    const pumpTxs = new Set([tx(2)]);
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      client,
      collector,
      isPumpTx: (hash) => pumpTxs.has(hash as Hex)
    });
    await poller.pollOnce(); // init at head 1000
    world.head = BigInt(1100);
    world.logs.push(
      leafLog(1010, 501, tx(1), 1_700_000_100),
      leafLog(1050, 502, tx(2), 1_700_000_200)
    );
    await poller.pollOnce();
    await poller.pollOnce(); // nothing new

    expect(records('l1_info_leaf')).toMatchObject([
      {
        blockNumber: '1010',
        leafCount: 501,
        txHash: tx(1),
        minTimestamp: 1_700_000_100,
        fromPump: false
      },
      {
        blockNumber: '1050',
        leafCount: 502,
        txHash: tx(2),
        minTimestamp: 1_700_000_200,
        fromPump: true
      }
    ]);
    expect(collector.snapshot().l1InfoTree?.leaves).toHaveLength(2);
  });

  it('chunks a long gap into requests of at most 1000 blocks, without gaps or overlap', async () => {
    const { collector, records } = setup();
    const { world, client } = fakeL1({ head: BigInt(0) });
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      client,
      collector,
      isPumpTx: () => false
    });
    await poller.pollOnce();
    world.head = BigInt(3500);
    world.logs.push(
      leafLog(999, 1, tx(1)),
      leafLog(1000, 2, tx(2)),
      leafLog(1001, 3, tx(3)),
      leafLog(3500, 4, tx(4))
    );
    await poller.pollOnce();

    expect(world.calls.getUpdateLogs.map((c) => [c.fromBlock, c.toBlock])).toStrictEqual([
      [BigInt(1), BigInt(1000)],
      [BigInt(1001), BigInt(2000)],
      [BigInt(2001), BigInt(3000)],
      [BigInt(3001), BigInt(3500)]
    ]);
    expect(records('l1_info_leaf').map((r) => r.leafCount)).toStrictEqual([1, 2, 3, 4]);
  });

  it('a failed poll is an l1_info_poll_error and the next tick retries the same range with no loss or duplicates', async () => {
    const { collector, records } = setup();
    const { world, client } = fakeL1();
    const logs: string[] = [];
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      client,
      collector,
      isPumpTx: () => false,
      logger: (line) => logs.push(line)
    });
    await poller.pollOnce();
    world.head = BigInt(1100);
    world.logs.push(leafLog(1010, 501, tx(1)));
    world.failNextGetLogs = new Error(
      'HTTP request failed.\nURL: https://rpc.example.invalid/AbCdEf0123456789TokenXyz'
    );
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    expect(records('l1_info_poll_error')).toHaveLength(1);
    expect(JSON.stringify(records('l1_info_poll_error')[0])).not.toContain(
      'AbCdEf0123456789TokenXyz'
    );
    expect(logs.join('\n')).not.toContain('AbCdEf0123456789TokenXyz');
    expect(records('l1_info_leaf')).toHaveLength(0);

    await poller.pollOnce();
    expect(records('l1_info_leaf').map((r) => r.leafCount)).toStrictEqual([501]);
    expect(collector.snapshot().l1InfoTree?.pollErrors).toBe(1);
    await poller.pollOnce();
    expect(records('l1_info_leaf')).toHaveLength(1);
  });

  it('a failed init (discovery or head read) is retried on the next poll and counted as an error', async () => {
    const { collector, records } = setup();
    const { world, client } = fakeL1();
    let failDiscovery = true;
    const flaky: L1InfoTreeClient = {
      ...client,
      readGlobalExitRootManager: async (bridge) => {
        if (failDiscovery) throw new Error('rpc down');
        return client.readGlobalExitRootManager(bridge);
      }
    };
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      client: flaky,
      collector,
      isPumpTx: () => false
    });
    await poller.pollOnce();
    expect(records('l1_info_poll_error')).toHaveLength(1);
    expect(collector.snapshot().l1InfoTree?.gerManagerAddress).toBeNull();
    failDiscovery = false;
    await poller.pollOnce();
    expect(collector.snapshot().l1InfoTree?.gerManagerAddress).toBe(GER);
    expect(world.calls.getUpdateLogs).toHaveLength(0);
  });

  it('an unreadable baseline leaf count is recorded as null and does not stop the polling', async () => {
    const { collector } = setup();
    const { world, client } = fakeL1();
    const noBaseline: L1InfoTreeClient = {
      ...client,
      readLeafCount: async () => {
        throw new Error('no depositCount()');
      }
    };
    const poller = createL1InfoTreePoller({
      bridgeAddress: BRIDGE,
      client: noBaseline,
      collector,
      isPumpTx: () => false
    });
    await poller.pollOnce();
    world.head = BigInt(1100);
    world.logs.push(leafLog(1010, 501, tx(1)));
    await poller.pollOnce();
    expect(collector.snapshot().l1InfoTree?.baselineLeafCount).toBeNull();
    expect(collector.snapshot().l1InfoTree?.leaves).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Periodic scheduler
// ---------------------------------------------------------------------------

describe('createPeriodicTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on every interval, and once immediately when asked', async () => {
    const run = vi.fn(async () => {});
    const task = createPeriodicTask({ intervalMs: 60_000, run, immediate: true, label: 't' });
    task.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(4);
    await task.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does not run before the first interval unless immediate', async () => {
    const run = vi.fn(async () => {});
    const task = createPeriodicTask({ intervalMs: 60_000, run, label: 't' });
    task.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await task.stop();
  });

  it('skips a tick while the previous run is still in flight', async () => {
    let release: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const task = createPeriodicTask({ intervalMs: 1000, run, label: 't' });
    task.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await task.stop();
  });

  it('logs (redacted) and survives a rejecting run; stop() waits for an in-flight run', async () => {
    const logs: string[] = [];
    let calls = 0;
    const run = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) throw new Error('boom https://rpc.example.invalid/AbCdEf0123456789TokenXyz');
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    const task = createPeriodicTask({
      intervalMs: 1000,
      run,
      label: 'balance sampler',
      logger: (l) => logs.push(l)
    });
    task.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('balance sampler: boom');
    expect(logs[0]).not.toContain('AbCdEf0123456789TokenXyz');
    await vi.advanceTimersByTimeAsync(1000); // second run starts, 500 ms long
    let stopped = false;
    const stopPromise = task.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await stopPromise;
    expect(stopped).toBe(true);
  });
});

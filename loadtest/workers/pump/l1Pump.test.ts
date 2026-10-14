// S53: the L1 deposit pump against fake viem clients and a fake clock (vitest
// fake timers drive both `setTimeout` and `Date.now`). Proves the pump fires on
// schedule, is accounted separately from user hops, never throws into the
// runner, never has two txs in flight, and cannot exceed its spend cap.
import type { Address, Hex } from 'viem';

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  parseAbiItem
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadtestChain } from '../../config/schema';
import type { L1PumpClients } from './l1Pump';

import { createCollector, createMemoryActivitySink } from '../../metrics/collector';
import { installTimingFetch, runWithFetchContext } from '../headless/uiCallset';
import { createL1Pump, pumpScheduleFromConfig } from './l1Pump';

const GWEI = BigInt(1_000_000_000);
const ETH = BigInt(10) ** BigInt(18);
const SENDER: Address = '0x00000000000000000000000000000000000000b1';
const BRIDGE: Address = '0x00000000000000000000000000000000000000a0';
const CHAIN = { key: 'SEPOLIA', bridgeAddress: BRIDGE } as unknown as LoadtestChain;

const BRIDGE_EVENT = parseAbiItem(
  'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)'
);
const bridgeEventLog = (depositCount: number) => ({
  address: BRIDGE,
  topics: encodeEventTopics({ abi: [BRIDGE_EVENT], eventName: 'BridgeEvent' }) as readonly Hex[],
  data: encodeAbiParameters(
    [
      { type: 'uint8' },
      { type: 'uint32' },
      { type: 'address' },
      { type: 'uint32' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'uint32' }
    ],
    [0, 0, '0x0000000000000000000000000000000000000000', 82, SENDER, BigInt(0), '0x', depositCount]
  )
});

interface FakeWorld {
  gasPrice: bigint;
  estimate: bigint;
  effectiveGasPrice: bigint;
  gasUsed: bigint;
  receiptStatus: 'success' | 'reverted';
  /** When true the receipt never arrives (the wait rejects as a timeout). */
  receiptNever: boolean;
  sendError: Error | null;
  /** S58a M3: the node accepts and propagates the tx (the nonce moves on), but the reply is lost and the send rejects. */
  broadcastThenError: Error | null;
  sends: Parameters<L1PumpClients['sendTransaction']>[0][];
  nonceReads: number;
  inFlightSends: number;
  maxInFlightSends: number;
  nextNonce: number;
  receiptWaits: number;
}

const fakeWorld = (over: Partial<FakeWorld> = {}): FakeWorld => ({
  gasPrice: GWEI / BigInt(1000),
  estimate: BigInt(440_000),
  effectiveGasPrice: GWEI / BigInt(1000),
  gasUsed: BigInt(437_125),
  receiptStatus: 'success',
  receiptNever: false,
  sendError: null,
  broadcastThenError: null,
  sends: [],
  nonceReads: 0,
  inFlightSends: 0,
  maxInFlightSends: 0,
  nextNonce: 7,
  receiptWaits: 0,
  ...over
});

const fakeClients = (world: FakeWorld): L1PumpClients => ({
  getGasPrice: async () => world.gasPrice,
  estimateGas: async () => world.estimate,
  estimateMaxPriorityFeePerGas: async () => BigInt(2) * GWEI,
  getTransactionCount: async () => {
    world.nonceReads += 1;
    return world.nextNonce;
  },
  sendTransaction: async (args) => {
    world.inFlightSends += 1;
    world.maxInFlightSends = Math.max(world.maxInFlightSends, world.inFlightSends);
    try {
      if (world.sendError !== null) throw world.sendError;
      world.sends.push(args);
      world.nextNonce += 1;
      if (world.broadcastThenError !== null) throw world.broadcastThenError;
      return `0x${world.sends.length.toString(16).padStart(64, '0')}` as Hex;
    } finally {
      world.inFlightSends -= 1;
    }
  },
  waitForTransactionReceipt: async ({ hash }) => {
    world.receiptWaits += 1;
    if (world.receiptNever) throw new Error(`Timed out while waiting for transaction ${hash}`);
    return {
      status: world.receiptStatus,
      blockNumber: BigInt(1000 + world.sends.length),
      gasUsed: world.gasUsed,
      effectiveGasPrice: world.effectiveGasPrice,
      logs: world.receiptStatus === 'success' ? [bridgeEventLog(world.sends.length - 1)] : []
    };
  }
});

const harness = (
  worldOver: Partial<FakeWorld> = {},
  pump: Partial<{
    amount: string;
    intervalSeconds: number;
    maxTotalSpend: string;
    maxGasPriceGwei: number;
  }> = {}
) => {
  const world = fakeWorld(worldOver);
  const sink = createMemoryActivitySink();
  const collector = createCollector({ clock: { now: () => Date.now() }, activitySink: sink });
  const logs: string[] = [];
  const pumpHandle = createL1Pump({
    chain: CHAIN,
    sender: SENDER,
    pump: {
      destinationNetworkId: 82,
      amount: '0',
      intervalSeconds: 600,
      maxTotalSpend: '0.07',
      maxGasPriceGwei: 5,
      ...pump
    },
    clients: fakeClients(world),
    collector,
    clock: { now: () => Date.now() },
    receiptTimeoutMs: 60_000,
    logger: (line) => logs.push(line)
  });
  const records = (kind: string) =>
    sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.kind === kind);
  return { world, sink, collector, pump: pumpHandle, records, logs };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('l1Pump: schedule', () => {
  it('fires at t = 0 and then every interval, on a fake clock', async () => {
    const h = harness();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.records('pump_deposit')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(599_999);
    expect(h.records('pump_deposit')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.records('pump_deposit')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(600_000 * 3);
    expect(h.records('pump_deposit')).toHaveLength(5);
    expect(h.world.sends).toHaveLength(5);
    await h.pump.stop();
  });

  it('sends exactly the designed deposit: bridgeAsset(dest, self, 0, 0x0, true, 0x), value = amount, gas = estimate + 20 %, maxFeePerGas = the cap', async () => {
    const h = harness();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    const [tx] = h.world.sends;
    expect(tx.to).toBe(BRIDGE);
    expect(tx.value).toBe(BigInt(0));
    expect(tx.gas).toBe(BigInt(528_000)); // 440 000 x 1.2
    expect(tx.maxFeePerGas).toBe(BigInt(5) * GWEI);
    expect(tx.maxPriorityFeePerGas).toBe(BigInt(2) * GWEI);
    expect(tx.nonce).toBe(7);
    const decoded = decodeFunctionData({
      abi: parseAbi([
        'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable'
      ]),
      data: tx.data
    });
    const args = decoded.args as readonly unknown[];
    expect(args[1]?.toString().toLowerCase()).toBe(SENDER.toLowerCase());
    expect([args[0], args[2], args[3], args[4], args[5]]).toStrictEqual([
      82,
      BigInt(0),
      '0x0000000000000000000000000000000000000000',
      true,
      '0x'
    ]);
    await h.pump.stop();
  });

  it('clamps the priority fee to the max fee cap', async () => {
    const h = harness({}, { maxGasPriceGwei: 1 });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.world.sends[0].maxPriorityFeePerGas).toBe(GWEI);
    await h.pump.stop();
  });

  it('an amount other than 0 is sent as the tx value', async () => {
    const h = harness({}, { amount: '0.000001' });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.world.sends[0].value).toBe(BigInt(1_000_000_000_000));
    await h.pump.stop();
  });
});

describe('l1Pump: accounting is separate from user hops', () => {
  it('writes pump_* records under userId harness:pump, mode null, and touches no hop, lap, tick or error counter', async () => {
    const h = harness();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(600_000);
    await h.pump.stop();

    const lines = h.sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(String(line.kind).startsWith('pump_')).toBe(true);
      expect(line.userId).toBe('harness:pump');
      expect(line.mode).toBeNull();
    }
    expect(lines.map((l) => l.kind)).toStrictEqual([
      'pump_state',
      'pump_deposit',
      'pump_deposit',
      'pump_state'
    ]);

    const snap = h.collector.snapshot();
    expect(snap.hopsByOutcome).toStrictEqual({});
    expect(snap.hopsByRoute).toStrictEqual({});
    expect(snap.lapsByOutcome).toStrictEqual({ LAP_DONE: 0, LAP_FAILED: 0, LAP_ABORTED: 0 });
    expect(snap.scheduler.lapStartsSubmitted).toBe(0);
    expect(snap.errors.byClass).toStrictEqual({});
    expect(snap.phases).toStrictEqual({});
    expect(snap.hopMeasurements).toStrictEqual([]);
  });

  it('snapshots the pump block: parameters, deposits (with the decoded depositCount), skip counters and total spend', async () => {
    const h = harness();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(600_000);
    await h.pump.stop();

    const pump = h.collector.snapshot().pump;
    expect(pump).toBeDefined();
    expect(pump).toMatchObject({
      enabled: true,
      sender: SENDER,
      destinationNetworkId: 82,
      amountWei: '0',
      intervalSeconds: 600,
      maxTotalSpendWei: ((ETH * BigInt(7)) / BigInt(100)).toString(),
      maxGasPriceWei: (BigInt(5) * GWEI).toString(),
      skipped: { gas_price: 0, cap_reached: 0, previous_pending: 0, send_error: 0 },
      pendingAtStop: false
    });
    expect(pump?.deposits).toHaveLength(2);
    expect(pump?.deposits[0]).toMatchObject({
      status: 'success',
      depositCount: 0,
      gasUsed: '437125',
      effectiveGasPrice: (GWEI / BigInt(1000)).toString(),
      costWei: (BigInt(437_125) * (GWEI / BigInt(1000))).toString()
    });
    expect(pump?.deposits[1].depositCount).toBe(1);
    expect(pump?.totalSpendWei).toBe(
      (BigInt(2) * BigInt(437_125) * (GWEI / BigInt(1000))).toString()
    );
  });

  it('adds the deposit amount to the cost of a successful deposit, and not to a reverted one', async () => {
    const ok = harness({}, { amount: '0.000001' });
    ok.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await ok.pump.stop();
    const price = GWEI / BigInt(1000);
    expect(ok.collector.snapshot().pump?.deposits[0].costWei).toBe(
      (BigInt(437_125) * price + BigInt(1_000_000_000_000)).toString()
    );

    const reverted = harness({ receiptStatus: 'reverted' }, { amount: '0.000001' });
    reverted.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await reverted.pump.stop();
    const dep = reverted.collector.snapshot().pump?.deposits[0];
    expect(dep).toMatchObject({ status: 'reverted', depositCount: null });
    expect(dep?.costWei).toBe((BigInt(437_125) * price).toString());
  });

  it('runs its RPC traffic in a harness fetch context: recorded as origin harness, never as UI load', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const world = fakeWorld();
    const collector = createCollector({ clock: { now: () => Date.now() } });
    const handle = installTimingFetch(collector, { now: () => Date.now() });
    const clients = fakeClients(world);
    const pump = createL1Pump({
      chain: CHAIN,
      sender: SENDER,
      pump: {
        destinationNetworkId: 82,
        amount: '0',
        intervalSeconds: 600,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 5
      },
      clients: {
        ...clients,
        getGasPrice: async () => {
          await fetch('http://l1.example.invalid/', {
            method: 'POST',
            body: JSON.stringify({ method: 'eth_gasPrice' })
          });
          return world.gasPrice;
        }
      },
      collector,
      clock: { now: () => Date.now() },
      receiptTimeoutMs: 60_000
    });
    try {
      pump.start();
      await vi.advanceTimersByTimeAsync(0);
      await pump.stop();
      // A request made on behalf of a simulated user stays `ui`.
      await runWithFetchContext({ userId: 'u0', mode: 'headless' }, () =>
        fetch('http://l1.example.invalid/', {
          method: 'POST',
          body: JSON.stringify({ method: 'eth_gasPrice' })
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

  it('isPumpTx recognises the deposits this pump sent, and nothing else', async () => {
    const h = harness();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    const hash = h.records('pump_deposit')[0].txHash as string;
    expect(h.pump.isPumpTx(hash)).toBe(true);
    expect(h.pump.isPumpTx(hash.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(h.pump.isPumpTx(`0x${'ff'.repeat(32)}`)).toBe(false);
    await h.pump.stop();
  });

  it('isPumpTx is true from the moment of sending, before any receipt', async () => {
    const h = harness({ receiptNever: true });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.records('pump_deposit')).toHaveLength(0);
    expect(h.pump.isPumpTx(`0x${(1).toString(16).padStart(64, '0')}`)).toBe(true);
    await h.pump.stop({ waitForReceipt: false });
  });
});

describe('l1Pump: gas price pause and resume', () => {
  it('skips with gas_price above the cap (recording the price) and resumes when it falls', async () => {
    const h = harness({ gasPrice: BigInt(6) * GWEI });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.world.sends).toHaveLength(0);
    expect(h.records('pump_skipped')).toMatchObject([
      { reason: 'gas_price', gasPriceWei: (BigInt(6) * GWEI).toString(), cumulativeSpendWei: '0' }
    ]);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.world.sends).toHaveLength(0);
    expect(h.records('pump_skipped')).toHaveLength(2);

    h.world.gasPrice = GWEI / BigInt(1000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.world.sends).toHaveLength(1);
    expect(h.collector.snapshot().pump?.skipped.gas_price).toBe(2);
    await h.pump.stop();
  });
});

describe('l1Pump: never throws into the runner', () => {
  it('a send error becomes pump_skipped{send_error} plus one rpc_error with no hopId, redacted', async () => {
    const h = harness({
      sendError: new Error(
        'HTTP request failed.\nURL: https://rpc.example.invalid/AbCdEf0123456789TokenXyz'
      )
    });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.records('pump_skipped')).toMatchObject([{ reason: 'send_error' }]);
    const errors = h.records('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ errorClass: 'rpc_error', userId: 'harness:pump' });
    expect(errors[0].hopId).toBeUndefined();
    expect(JSON.stringify(errors[0])).not.toContain('AbCdEf0123456789TokenXyz');
    expect(h.logs.join('\n')).not.toContain('AbCdEf0123456789TokenXyz');

    // The loop survives and keeps its schedule.
    h.world.sendError = null;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.world.sends).toHaveLength(1);
    await h.pump.stop();
  });

  it('a failing gas estimate is also a send_error skip, not an exception', async () => {
    const world = fakeWorld();
    const sink = createMemoryActivitySink();
    const collector = createCollector({ clock: { now: () => Date.now() }, activitySink: sink });
    const pump = createL1Pump({
      chain: CHAIN,
      sender: SENDER,
      pump: {
        destinationNetworkId: 82,
        amount: '0',
        intervalSeconds: 600,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 5
      },
      clients: {
        ...fakeClients(world),
        estimateGas: async () => {
          throw new Error('execution reverted');
        }
      },
      collector,
      clock: { now: () => Date.now() },
      receiptTimeoutMs: 60_000
    });
    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pump.stop()).resolves.toBeUndefined();
    expect(collector.snapshot().pump?.skipped.send_error).toBe(1);
    expect(world.sends).toHaveLength(0);
  });
});

describe('l1Pump: one tx in flight, nonce serial', () => {
  it('a deposit with no receipt blocks the next tick (previous_pending), with the nonce read once per send', async () => {
    const h = harness({ receiptNever: true });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.world.sends).toHaveLength(1);
    expect(h.records('pump_deposit')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.world.sends).toHaveLength(1);
    expect(h.records('pump_skipped').map((r) => r.reason)).toStrictEqual([
      'previous_pending',
      'previous_pending'
    ]);
    expect(h.world.nonceReads).toBe(1);
    expect(h.world.maxInFlightSends).toBe(1);

    // The receipt finally shows up: the pending tx settles and the pump moves on.
    h.world.receiptNever = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.records('pump_deposit')).toHaveLength(2); // the settled one + the new one
    expect(h.world.sends).toHaveLength(2);
    expect(h.world.nonceReads).toBe(2);
    expect(h.world.maxInFlightSends).toBe(1);
    await h.pump.stop();
  });
});

describe('l1Pump: spend cap', () => {
  it('stops for good once committed + the next worst case would exceed the cap, then sends nothing more', async () => {
    // Worst case per deposit at 440k estimate: 528 000 gas x 5 gwei = 0.00264 ETH.
    // A 0.006 ETH cap with realistic prices (0.001 gwei) never binds on ACTUAL
    // spend, so make the actual spend large instead: effective price 2.4 gwei.
    const h = harness(
      { effectiveGasPrice: (BigInt(24) * GWEI) / BigInt(10), gasUsed: BigInt(440_000) },
      { maxTotalSpend: '0.0055' }
    );
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0); // deposit 1: spends 0.001056 ETH
    await vi.advanceTimersByTimeAsync(600_000); // deposit 2: committed 0.001056 + 0.00264 fits -> 0.002112
    expect(h.world.sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600_000); // 0.002112 + 0.00264 = 0.004752 <= 0.0055 -> deposit 3
    expect(h.world.sends).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(600_000); // 0.003168 + 0.00264 = 0.005808 > 0.0055 -> stop
    expect(h.world.sends).toHaveLength(3);
    expect(h.records('pump_skipped').map((r) => r.reason)).toStrictEqual(['cap_reached']);

    await vi.advanceTimersByTimeAsync(600_000 * 10);
    expect(h.world.sends).toHaveLength(3);
    expect(h.records('pump_skipped')).toHaveLength(1);
    await h.pump.stop();
    expect(h.collector.snapshot().pump?.skipped.cap_reached).toBe(1);
  });

  it('a deposit that has not settled is counted at its worst case in the running total', async () => {
    const h = harness({ receiptNever: true });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000); // previous_pending, records the counted total
    const [skip] = h.records('pump_skipped');
    // 528 000 gas limit x 5 gwei + 0 amount.
    expect(skip.cumulativeSpendWei).toBe((BigInt(528_000) * BigInt(5) * GWEI).toString());
    await h.pump.stop({ waitForReceipt: false });
  });

  // S58a M3: a send that errors AFTER the node accepted the tx still costs gas. The next tick
  // reads the pending nonce (already moved on) and would send again, so the spend must count.
  it('a send that errors after the tx was broadcast is counted at its worst case, so the cap still binds', async () => {
    const h = harness({ broadcastThenError: new Error('HTTP request failed. Status: 504') });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    const worst = BigInt(528_000) * BigInt(5) * GWEI;
    expect(h.pump.progress().committedWei).toBe(worst);

    // Keep failing the same way for 10 hours of ticks: 0.07 ETH cap / 0.00264 worst case = 26 txs at most.
    for (let i = 0; i < 60; i += 1) await vi.advanceTimersByTimeAsync(600_000);
    expect(h.world.sends.length).toBeLessThanOrEqual(26);
    expect(h.pump.progress().committedWei).toBeLessThanOrEqual(BigInt(7) * ETH / BigInt(100));
    expect(h.records('pump_skipped').map((r) => r.reason)).toContain('cap_reached');
    await h.pump.stop({ waitForReceipt: false });
  });

  it('a send that is rejected before broadcast (the pending nonce did not move) counts nothing', async () => {
    const h = harness({ sendError: new Error('insufficient funds for gas * price + value') });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.world.sends).toHaveLength(0);
    expect(h.pump.progress().committedWei).toBe(BigInt(0));
    await h.pump.stop();
  });

  it('a cap too small for even one worst-case deposit sends nothing and stops at once', async () => {
    const h = harness({}, { maxTotalSpend: '0.001' });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.world.sends).toHaveLength(0);
    expect(h.records('pump_skipped').map((r) => r.reason)).toStrictEqual(['cap_reached']);
    await h.pump.stop();
  });
});

describe('l1Pump: stop', () => {
  it('writes started then stopped state records with the parameters, and is idempotent', async () => {
    const h = harness();
    h.pump.start();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.pump.stop();
    await h.pump.stop();
    const states = h.records('pump_state');
    expect(states.map((s) => s.state)).toStrictEqual(['started', 'stopped']);
    expect(states[0]).toMatchObject({
      sender: SENDER,
      intervalSeconds: 600,
      destinationNetworkId: 82,
      amountWei: '0',
      maxGasPriceWei: (BigInt(5) * GWEI).toString()
    });
    expect(states[1]).toMatchObject({ pendingAtStop: false });
  });

  it('sends nothing after stop, even as the clock advances', async () => {
    const h = harness();
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.pump.stop();
    await vi.advanceTimersByTimeAsync(600_000 * 5);
    expect(h.world.sends).toHaveLength(1);
  });

  it('a deposit whose receipt never arrives is reported pendingAtStop, counted at its worst case', async () => {
    const h = harness({ receiptNever: true });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.pump.stop();
    const pump = h.collector.snapshot().pump;
    expect(pump?.pendingAtStop).toBe(true);
    expect(pump?.totalSpendWei).toBe((BigInt(528_000) * BigInt(5) * GWEI).toString());
    expect(h.records('pump_state').at(-1)).toMatchObject({ state: 'stopped', pendingAtStop: true });
  });

  it('waits for a late receipt at stop and settles it (pendingAtStop false)', async () => {
    const h = harness({ receiptNever: true });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    h.world.receiptNever = false;
    await h.pump.stop();
    expect(h.collector.snapshot().pump?.pendingAtStop).toBe(false);
    expect(h.records('pump_deposit')).toHaveLength(1);
  });

  it('stop() before start() is a no-op that never emits a state record', async () => {
    const h = harness();
    await h.pump.stop();
    expect(h.sink.lines).toHaveLength(0);
  });
});

describe('l1Pump: re-entrancy', () => {
  it('a second tick() while one is mid-send is dropped, so two sends can never share a nonce', async () => {
    const world = fakeWorld();
    const base = fakeClients(world);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendCalls = 0;
    const pump = createL1Pump({
      chain: CHAIN,
      sender: SENDER,
      pump: {
        destinationNetworkId: 82,
        amount: '0',
        intervalSeconds: 60,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 5
      },
      clients: {
        ...base,
        sendTransaction: async (args) => {
          sendCalls += 1;
          await gate;
          return base.sendTransaction(args);
        }
      },
      collector: createCollector({ clock: { now: () => Date.now() } }),
      clock: { now: () => Date.now() },
      receiptTimeoutMs: 60_000
    });

    const first = pump.tick();
    await vi.advanceTimersByTimeAsync(0);
    // Even a minute later (due again), the first send is still in flight.
    await vi.advanceTimersByTimeAsync(60_000);
    await pump.tick();
    expect(sendCalls).toBe(1);
    release();
    await first;
    expect(world.sends).toHaveLength(1);
  });
});

describe('l1Pump: progress and configuration', () => {
  it('progress() reports settled deposits and the counted spend (a pending deposit at its worst case)', async () => {
    const h = harness();
    expect(h.pump.progress()).toStrictEqual({ settledDeposits: 0, committedWei: BigInt(0) });
    h.pump.start();
    await vi.advanceTimersByTimeAsync(600_000);
    const cost = BigInt(437_125) * (GWEI / BigInt(1000));
    expect(h.pump.progress()).toStrictEqual({ settledDeposits: 2, committedWei: cost * BigInt(2) });
    await h.pump.stop();

    const pending = harness({ receiptNever: true });
    pending.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.pump.progress()).toStrictEqual({
      settledDeposits: 0,
      committedWei: BigInt(528_000) * BigInt(5) * GWEI
    });
    await pending.pump.stop({ waitForReceipt: false });
  });

  it('pumpScheduleFromConfig converts ETH and gwei decimals to wei exactly', () => {
    expect(
      pumpScheduleFromConfig({
        amount: '0.000001',
        intervalSeconds: 600,
        maxTotalSpend: '0.07',
        maxGasPriceGwei: 0.001
      })
    ).toStrictEqual({
      intervalMs: 600_000,
      maxTotalSpendWei: BigInt(70_000_000_000_000_000),
      maxGasPriceWei: BigInt(1_000_000),
      amountWei: BigInt(1_000_000_000_000)
    });
    expect(
      pumpScheduleFromConfig({
        amount: '0',
        intervalSeconds: 60,
        maxTotalSpend: '1',
        maxGasPriceGwei: 5
      })
    ).toMatchObject({
      maxTotalSpendWei: ETH,
      maxGasPriceWei: BigInt(5) * GWEI,
      amountWei: BigInt(0)
    });
  });
});

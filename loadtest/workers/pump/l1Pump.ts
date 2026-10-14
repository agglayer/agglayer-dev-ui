// The L1 deposit pump (S53, heavy-load design §1.3): a harness-side loop that
// sends one `bridgeAsset(destination, self, amount, 0x0, true, 0x)` on the L1
// every `pump.intervalSeconds`, from a dedicated wallet, so the L1 info tree
// keeps gaining leaves while the users bridge. WHEN it fires, pauses or stops is
// `core/pumpSchedule.ts`; this file is the I/O around it (gas price, estimate,
// nonce, send, receipt, accounting) and the collector calls.
//
// Pump traffic is NOT user traffic. It never touches a hop, lap, tick or verdict
// input: its records are `pump_*` ndjson kinds, its RPC requests run in a
// `harness` fetch context (`userId: 'harness:pump'`), and it never throws into
// the runner. Only one pump tx is ever in flight (the next tick skips with
// `previous_pending` instead), so the nonce read from `pending` before each send
// cannot race another send from this wallet.
import type { Address, Hex, LocalAccount } from 'viem';

import { decodeEventLog, encodeFunctionData, formatEther, parseAbi, parseAbiItem } from 'viem';

import type { LoadtestChain, LoadtestPump } from '../../config/schema';
import type { PumpScheduleConfig } from '../../core/pumpSchedule';
import type { Collector } from '../../metrics/collector';
import type { ChainClientSet } from '../../wallets/chainClients';

import { decidePumpTick, pumpMsUntilDue } from '../../core/pumpSchedule';
import { redactError } from '../../wallets/redact';
import { runWithFetchContext } from '../headless/uiCallset';

const PUMP_USER_ID = 'harness:pump';
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const BRIDGE_ASSET_ABI = parseAbi([
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable'
]);
const BRIDGE_EVENT_ABI = [
  parseAbiItem(
    'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)'
  )
];

/** The narrow slice of viem the pump uses, so a test can hand it plain fakes. */
export interface L1PumpClients {
  getGasPrice(): Promise<bigint>;
  estimateGas(args: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  estimateMaxPriorityFeePerGas(): Promise<bigint>;
  getTransactionCount(args: { address: Address }): Promise<number>;
  sendTransaction(args: {
    to: Address;
    data: Hex;
    value: bigint;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    nonce: number;
  }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
  }>;
}

/** Wraps real viem clients for the L1 chain and the pump signer. */
export const pumpClientsFromViem = (set: ChainClientSet, account: LocalAccount): L1PumpClients => {
  const wallet = set.wallet(account);
  return {
    getGasPrice: () => set.public.getGasPrice(),
    estimateGas: (args) => set.public.estimateGas(args),
    estimateMaxPriorityFeePerGas: () => set.public.estimateMaxPriorityFeePerGas(),
    getTransactionCount: ({ address }) =>
      set.public.getTransactionCount({ address, blockTag: 'pending' }),
    sendTransaction: (args) => wallet.sendTransaction(args),
    waitForTransactionReceipt: (args) =>
      set.public.waitForTransactionReceipt(args) as ReturnType<
        L1PumpClients['waitForTransactionReceipt']
      >
  };
};

export interface L1PumpOptions {
  chain: LoadtestChain;
  sender: Address;
  pump: Pick<
    LoadtestPump,
    'destinationNetworkId' | 'amount' | 'intervalSeconds' | 'maxTotalSpend' | 'maxGasPriceGwei'
  >;
  clients: L1PumpClients;
  collector: Collector;
  clock: { now(): number };
  /** `timeouts.txReceiptMs`: how long one receipt wait (and the stop-time wait) may take. */
  receiptTimeoutMs: number;
  logger?: (line: string) => void;
}

export interface L1Pump {
  /** Starts the loop: a first tick immediately, then one per interval. Idempotent. */
  start(): void;
  /**
   * Stops the loop. Waits (bounded by `receiptTimeoutMs`) for a deposit that has
   * no receipt yet unless `waitForReceipt` is false, then writes the `stopped`
   * state record (`pendingAtStop` when a deposit never confirmed). Idempotent.
   */
  stop(options?: { waitForReceipt?: boolean }): Promise<void>;
  /** One schedule evaluation. The loop calls this when a tick is due; exported for tests. */
  tick(): Promise<void>;
  /** True when `txHash` is a deposit this pump has sent, settled or not (M3 `fromPump`). */
  isPumpTx(txHash: string): boolean;
  /** Settled deposit count and the counted spend so far (a pending deposit at its worst case), for the status line. */
  progress(): { settledDeposits: number; committedWei: bigint };
}

interface PendingTx {
  hash: Hex;
  sentAt: number;
  worstCaseWei: bigint;
}

const decimalToWei = (value: string): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt((fraction + '0'.repeat(18)).slice(0, 18))
  );
};

export const pumpScheduleFromConfig = (
  pump: Pick<LoadtestPump, 'amount' | 'intervalSeconds' | 'maxTotalSpend' | 'maxGasPriceGwei'>
): PumpScheduleConfig => ({
  intervalMs: pump.intervalSeconds * 1000,
  maxTotalSpendWei: decimalToWei(pump.maxTotalSpend),
  maxGasPriceWei: BigInt(Math.round(pump.maxGasPriceGwei * 1_000_000)) * BigInt(1000),
  amountWei: decimalToWei(pump.amount)
});

export const createL1Pump = (options: L1PumpOptions): L1Pump => {
  const { chain, sender, clients, collector, clock, receiptTimeoutMs } = options;
  const logger = options.logger ?? (() => {});
  const schedule = pumpScheduleFromConfig(options.pump);
  const bridge = chain.bridgeAddress as Address;
  const destination = options.pump.destinationNetworkId;
  const ctx = { userId: PUMP_USER_ID, mode: 'headless' as const, origin: 'harness' as const };

  let started = false;
  let stopped = false;
  // Re-entrancy guard: a second `tick()` while one is mid-send would read the
  // same nonce, so it is dropped (the loop is sequential; this protects direct callers).
  let ticking = false;
  let capReached = false;
  let lastTickAt: number | null = null;
  let spentWei = BigInt(0);
  let settledDeposits = 0;
  let pendingTx: PendingTx | null = null;
  // S58a M3: worst-case cost of sends that errored AFTER the node may have accepted the tx
  // (reply lost: timeout, 502, reset). The hash is unknown, so they can never be settled;
  // they stay counted at their worst case for the rest of the run.
  let uncertainSendWei = BigInt(0);
  let loopDone: Promise<void> = Promise.resolve();
  let wake: (() => void) | null = null;
  const pumpTxHashes = new Set<string>();

  const committedWei = (): bigint =>
    spentWei + (pendingTx?.worstCaseWei ?? BigInt(0)) + uncertainSendWei;

  /**
   * A send that rejected may still have been broadcast. The pending nonce tells: if it moved
   * past the nonce this send used, the node has the tx; if the check itself fails, assume it did.
   */
  const countUncertainSend = async (nonce: number, worstCaseWei: bigint): Promise<void> => {
    let broadcast = true;
    try {
      broadcast = (await clients.getTransactionCount({ address: sender })) > nonce;
    } catch {
      // unknown: stay conservative
    }
    if (broadcast) {
      uncertainSendWei += worstCaseWei;
      logger(
        `pump: send errored but the pending nonce moved on; counting ${formatEther(worstCaseWei)} ETH at its worst case (${formatEther(uncertainSendWei)} ETH uncertain so far)`
      );
    }
  };

  const stateRecord = (state: 'started' | 'stopped') => ({
    kind: 'state' as const,
    state,
    sender,
    intervalSeconds: options.pump.intervalSeconds,
    maxTotalSpendWei: schedule.maxTotalSpendWei.toString(),
    maxGasPriceWei: schedule.maxGasPriceWei.toString(),
    destinationNetworkId: destination,
    amountWei: schedule.amountWei.toString()
  });

  const recordSkip = (
    reason: 'gas_price' | 'cap_reached' | 'previous_pending' | 'send_error',
    gasPriceWei?: bigint
  ): void => {
    collector.pumpEvent({
      kind: 'skipped',
      reason,
      ...(gasPriceWei !== undefined ? { gasPriceWei: gasPriceWei.toString() } : {}),
      cumulativeSpendWei: committedWei().toString()
    });
  };

  // The only error record the pump writes: an `rpc_error` with no `hopId`, so it
  // can never be attributed to (or fail) a user hop.
  const recordSendError = (error: unknown): void => {
    const message = redactError(error);
    logger(`pump: ${message}`);
    recordSkip('send_error');
    collector.error({
      userId: PUMP_USER_ID,
      mode: 'headless',
      errorClass: 'rpc_error',
      message
    });
  };

  const decodeDepositCount = (
    logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]
  ): number | null => {
    for (const log of logs) {
      if (log.address.toLowerCase() !== bridge.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: BRIDGE_EVENT_ABI,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]]
        });
        if (decoded.eventName === 'BridgeEvent') return Number(decoded.args.depositCount);
      } catch {
        // Not the BridgeEvent log — keep scanning.
      }
    }
    return null;
  };

  /** Waits (bounded) for the pending deposit's receipt; settles it into the accounting when it arrives. */
  const trySettle = async (): Promise<void> => {
    const tx = pendingTx;
    if (tx === null) return;
    try {
      const receipt = await clients.waitForTransactionReceipt({
        hash: tx.hash,
        timeout: receiptTimeoutMs
      });
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
      // A reverted deposit still pays gas, but the value it carried comes back.
      const cost = gasCost + (receipt.status === 'success' ? schedule.amountWei : BigInt(0));
      spentWei += cost;
      settledDeposits += 1;
      pendingTx = null;
      collector.pumpEvent({
        kind: 'deposit',
        txHash: tx.hash,
        blockNumber: receipt.blockNumber.toString(),
        depositCount: receipt.status === 'success' ? decodeDepositCount(receipt.logs) : null,
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        costWei: cost.toString(),
        cumulativeSpendWei: committedWei().toString(),
        sentAt: tx.sentAt,
        minedObservedAt: clock.now()
      });
    } catch (error) {
      // No receipt in time (or a receipt RPC failure): the deposit stays pending,
      // counted at its worst case, and the next tick re-checks it.
      logger(`pump: receipt for ${tx.hash} not available yet: ${redactError(error)}`);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || capReached || ticking) return;
    const now = clock.now();
    if (pumpMsUntilDue(schedule, lastTickAt, now) > 0) return;
    ticking = true;
    lastTickAt = now;
    try {
      if (pendingTx !== null) await trySettle();

      let gasPriceWei = BigInt(0);
      let gasEstimate = BigInt(0);
      // While a deposit is still pending the decision is `previous_pending`
      // regardless of price or estimate, so neither RPC call is spent on it.
      if (pendingTx === null) {
        const data = encodeFunctionData({
          abi: BRIDGE_ASSET_ABI,
          functionName: 'bridgeAsset',
          args: [destination, sender, schedule.amountWei, ZERO_ADDRESS, true, '0x']
        });
        gasPriceWei = await clients.getGasPrice();
        gasEstimate = await clients.estimateGas({
          account: sender,
          to: bridge,
          data,
          value: schedule.amountWei
        });
      }

      const decision = decidePumpTick(schedule, {
        now,
        lastTickAt: null,
        pending: pendingTx !== null,
        committedWei: committedWei(),
        gasPriceWei,
        gasEstimate
      });
      if (decision.kind === 'wait') return;
      if (decision.kind === 'skip') {
        recordSkip(decision.reason, decision.reason === 'gas_price' ? gasPriceWei : undefined);
        return;
      }
      if (decision.kind === 'stop') {
        capReached = true;
        recordSkip('cap_reached');
        logger(
          `pump: spend cap reached (${formatEther(committedWei())} ETH counted); pump stopped`
        );
        return;
      }

      const data = encodeFunctionData({
        abi: BRIDGE_ASSET_ABI,
        functionName: 'bridgeAsset',
        args: [destination, sender, schedule.amountWei, ZERO_ADDRESS, true, '0x']
      });
      const nonce = await clients.getTransactionCount({ address: sender });
      const priority = await clients.estimateMaxPriorityFeePerGas();
      const sentAt = clock.now();
      // `maxFeePerGas` is the pause threshold itself, so a sent tx can never pay more.
      let hash: Hex;
      try {
        hash = await clients.sendTransaction({
          to: bridge,
          data,
          value: schedule.amountWei,
          gas: decision.gasLimit,
          maxFeePerGas: schedule.maxGasPriceWei,
          maxPriorityFeePerGas:
            priority < schedule.maxGasPriceWei ? priority : schedule.maxGasPriceWei,
          nonce
        });
      } catch (error) {
        await countUncertainSend(nonce, decision.worstCaseWei);
        throw error;
      }
      // Registered at send time, not at settlement, so a poller that sees the
      // leaf before the receipt wait returns still attributes it to the pump.
      pumpTxHashes.add(hash.toLowerCase());
      pendingTx = { hash, sentAt, worstCaseWei: decision.worstCaseWei };
      await trySettle();
    } catch (error) {
      recordSendError(error);
    } finally {
      ticking = false;
    }
  };

  const sleepUntilWoken = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = async (): Promise<void> => {
    while (!stopped && !capReached) {
      const waitMs = pumpMsUntilDue(schedule, lastTickAt, clock.now());
      if (waitMs > 0) {
        await sleepUntilWoken(waitMs);
        wake = null;
        continue;
      }
      await tick();
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      collector.pumpEvent(stateRecord('started'));
      loopDone = runWithFetchContext(ctx, loop).catch((error: unknown) => {
        // Defensive: `tick` never throws, so this is only a programming error.
        logger(`pump: loop crashed: ${redactError(error)}`);
      });
    },

    async stop(stopOptions = {}) {
      if (stopped) return;
      stopped = true;
      wake?.();
      if (!started) return;
      // Let a tick that is mid-send finish (its receipt wait is bounded).
      await loopDone;
      if (stopOptions.waitForReceipt !== false && pendingTx !== null) {
        await runWithFetchContext(ctx, trySettle);
      }
      collector.pumpEvent({
        ...stateRecord('stopped'),
        pendingAtStop: pendingTx !== null,
        totalSpendWei: committedWei().toString()
      });
    },

    tick: () => runWithFetchContext(ctx, tick),

    isPumpTx: (txHash) => pumpTxHashes.has(txHash.toLowerCase()),

    progress: () => ({ settledDeposits, committedWei: committedWei() })
  };
};

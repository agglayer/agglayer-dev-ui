// Periodic harness-side samplers (S53, heavy-load design §1.4): M1 wallet
// balances, M3 L1 info tree leaves, and the scheduler shared with M4's HTTP
// windows. Everything here is optional (a `measurement` field switches it on),
// reads only, and runs in a `harness` fetch context so its traffic never lands
// in the `ui` latency headline and is never an uncontexted request (R11).
//
// The sampling logic is pure of timers: each sampler exposes a `sampleOnce()` /
// `pollOnce()` that a test drives directly; `createPeriodicTask` is the only
// timer in the file.
import type { Address, Hex, PublicClient } from 'viem';

import { decodeEventLog, parseAbi, parseAbiItem } from 'viem';

import type { Collector } from './collector';

import { redactError } from '../wallets/redact';
import { runWithFetchContext } from '../workers/headless/uiCallset';

// ---------------------------------------------------------------------------
// Periodic scheduling
// ---------------------------------------------------------------------------

export interface PeriodicTask {
  /** Starts the interval (and one immediate run when `immediate`). Idempotent. */
  start(): void;
  /** Stops the interval and waits for a run that is already in flight. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Runs `run` every `intervalMs`. A tick is skipped while the previous run is
 * still going (a slow RPC must not stack samples), and a rejection is logged,
 * never thrown. The interval does not keep the process alive on its own.
 */
export const createPeriodicTask = (options: {
  intervalMs: number;
  run: () => Promise<void>;
  immediate?: boolean;
  label: string;
  logger?: (line: string) => void;
}): PeriodicTask => {
  const logger = options.logger ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const tick = (): void => {
    if (stopped || inFlight !== null) return;
    inFlight = options
      .run()
      .catch((error: unknown) => {
        logger(`${options.label}: ${redactError(error)}`);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    start() {
      if (timer !== null || stopped) return;
      timer = setInterval(tick, options.intervalMs);
      timer.unref?.();
      if (options.immediate === true) tick();
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await inFlight;
    }
  };
};

// ---------------------------------------------------------------------------
// M1 — wallet balances
// ---------------------------------------------------------------------------

export interface BalanceReader {
  getBalance(args: { address: Address }): Promise<bigint>;
}

export interface WalletBalanceSamplerOptions {
  /** Chains to sample: every ring chain except the L1 (the users hold no gas there to watch). */
  chains: readonly { key: string }[];
  wallets: readonly { userId: string; address: Address }[];
  readerFor: (chainKey: string) => BalanceReader;
  collector: Collector;
  /** Concurrent `eth_getBalance` reads per chain. Design: 5. */
  concurrency?: number;
  logger?: (line: string) => void;
}

const bigintSort = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** True median; the floor of the mean of the two middle values for an even count. */
const medianOf = (sorted: readonly bigint[]): bigint => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / BigInt(2);
};

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

export const createWalletBalanceSampler = (options: WalletBalanceSamplerOptions) => {
  const concurrency = options.concurrency ?? 5;
  const logger = options.logger ?? (() => {});

  const sampleOnce = (): Promise<void> =>
    runWithFetchContext(
      { userId: 'harness:balance', mode: 'headless', origin: 'harness' },
      async () => {
        for (const chain of options.chains) {
          const reader = options.readerFor(chain.key);
          const reads = await mapWithConcurrency(options.wallets, concurrency, async (wallet) => {
            try {
              return {
                userId: wallet.userId,
                wei: await reader.getBalance({ address: wallet.address })
              };
            } catch (error) {
              logger(`balance sampler: ${chain.key} ${wallet.userId}: ${redactError(error)}`);
              return null;
            }
          });
          const ok = reads.filter((r): r is { userId: string; wei: bigint } => r !== null);
          // A chain whose every read failed has nothing honest to report.
          if (ok.length === 0) continue;
          const sorted = [...ok].sort((a, b) => bigintSort(a.wei, b.wei));
          const weis = sorted.map((r) => r.wei);
          options.collector.walletBalance({
            chainKey: chain.key,
            n: ok.length,
            minWei: weis[0].toString(),
            medianWei: medianOf(weis).toString(),
            maxWei: weis[weis.length - 1].toString(),
            lowest: sorted.slice(0, 3).map((r) => ({ userId: r.userId, wei: r.wei.toString() }))
          });
        }
      }
    );

  return { sampleOnce };
};

// ---------------------------------------------------------------------------
// M3 — L1 info tree leaves
// ---------------------------------------------------------------------------

/** Emitted by the L1 global exit root manager each time a leaf is added to the L1 info tree. */
export const UPDATE_L1_INFO_TREE_V2 = parseAbiItem(
  'event UpdateL1InfoTreeV2(bytes32 currentL1InfoRoot, uint32 indexed leafCount, uint256 blockhash, uint64 minTimestamp)'
);

export interface L1InfoTreeClient {
  getBlockNumber(): Promise<bigint>;
  /** Logs of `UpdateL1InfoTreeV2` emitted by `address` in `[fromBlock, toBlock]`. */
  getUpdateLogs(args: {
    address: Address;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    readonly { blockNumber: bigint; transactionHash: Hex; topics: readonly Hex[]; data: Hex }[]
  >;
  /** `bridge.globalExitRootManager()`. */
  readGlobalExitRootManager(bridge: Address): Promise<Address>;
  /** `gerManager.depositCount()` — the L1 info tree leaf count. */
  readLeafCount(gerManager: Address): Promise<number>;
}

const GER_MANAGER_ABI = parseAbi(['function globalExitRootManager() view returns (address)']);
const LEAF_COUNT_ABI = parseAbi(['function depositCount() view returns (uint32)']);

/** Adapts a real viem public client to the narrow interface the poller uses. */
export const l1InfoTreeClientFromViem = (client: PublicClient): L1InfoTreeClient => ({
  getBlockNumber: () => client.getBlockNumber(),
  getUpdateLogs: async ({ address, fromBlock, toBlock }) =>
    (await client.getLogs({
      address,
      event: UPDATE_L1_INFO_TREE_V2,
      fromBlock,
      toBlock
    })) as unknown as Awaited<ReturnType<L1InfoTreeClient['getUpdateLogs']>>,
  readGlobalExitRootManager: (bridge) =>
    client.readContract({
      address: bridge,
      abi: GER_MANAGER_ABI,
      functionName: 'globalExitRootManager'
    }),
  readLeafCount: async (gerManager) =>
    Number(
      await client.readContract({
        address: gerManager,
        abi: LEAF_COUNT_ABI,
        functionName: 'depositCount'
      })
    )
});

export interface L1InfoTreePollerOptions {
  bridgeAddress: Address;
  /** Skips the one-time discovery through the bridge when given. */
  gerManagerAddress?: Address;
  client: L1InfoTreeClient;
  collector: Collector;
  /** True when `txHash` is a deposit sent by the pump. */
  isPumpTx: (txHash: string) => boolean;
  /** Largest `eth_getLogs` block range per request. Design: 1000. */
  chunkBlocks?: number;
  logger?: (line: string) => void;
}

export const createL1InfoTreePoller = (options: L1InfoTreePollerOptions) => {
  const chunkBlocks = BigInt(options.chunkBlocks ?? 1000);
  const logger = options.logger ?? (() => {});
  let gerManager: Address | null = options.gerManagerAddress ?? null;
  let lastBlock: bigint | null = null;
  let started = false;

  // One-time setup: discover the GER manager, read the baseline leaf count, and
  // remember the head so only leaves added during the run are reported.
  const init = async (): Promise<void> => {
    if (gerManager === null)
      gerManager = await options.client.readGlobalExitRootManager(options.bridgeAddress);
    let baseline: number | null = null;
    try {
      baseline = await options.client.readLeafCount(gerManager);
    } catch (error) {
      // The baseline is informational; its absence must not stop the polling.
      logger(`l1 info tree: baseline leaf count unavailable: ${redactError(error)}`);
    }
    lastBlock = await options.client.getBlockNumber();
    options.collector.l1InfoTreeStart({
      gerManagerAddress: gerManager,
      baselineLeafCount: baseline
    });
    started = true;
  };

  const reportError = (error: unknown): void => {
    const message = redactError(error);
    logger(`l1 info tree: ${message}`);
    options.collector.l1InfoPollError(message);
  };

  const pollOnce = (): Promise<void> =>
    runWithFetchContext(
      { userId: 'harness:l1info', mode: 'headless', origin: 'harness' },
      async () => {
        try {
          if (!started) {
            await init();
            return;
          }
          const head = await options.client.getBlockNumber();
          let from = (lastBlock as bigint) + BigInt(1);
          while (from <= head) {
            const to =
              from + chunkBlocks - BigInt(1) < head ? from + chunkBlocks - BigInt(1) : head;
            const logs = await options.client.getUpdateLogs({
              address: gerManager as Address,
              fromBlock: from,
              toBlock: to
            });
            for (const log of logs) {
              const decoded = decodeEventLog({
                abi: [UPDATE_L1_INFO_TREE_V2],
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]]
              });
              options.collector.l1InfoLeaf({
                blockNumber: log.blockNumber.toString(),
                leafCount: Number(decoded.args.leafCount),
                txHash: log.transactionHash,
                minTimestamp: Number(decoded.args.minTimestamp),
                fromPump: options.isPumpTx(log.transactionHash)
              });
            }
            // Only a fully processed chunk moves the cursor, so a failure retries it.
            lastBlock = to;
            from = to + BigInt(1);
          }
        } catch (error) {
          reportError(error);
        }
      }
    );

  return { pollOnce };
};

// Streaming reader for `activity.ndjson` (S54, heavy-load design §4.4).
//
// One pass, line by line, keeping only reductions: a compact row per hop (state
// transition times, outcome), per-minute error counters, the resource series, the
// pump / wallet-balance / L1-leaf / HTTP-window records and per-wallet counters.
// `hop_state` lines themselves are not kept. A truncated last line (a killed
// run) and malformed lines are tolerated and counted. Free text (error
// messages) is NOT kept: the HTML shows `results.json`'s already-redacted
// `errors.top` samples, so no raw ndjson message can reach the page.
import fs from 'node:fs';
import readline from 'node:readline';

import { isSuccessOutcome } from '../../core/types';

export interface DigestHop {
  hopId: string;
  lapId: string;
  userId: string;
  /** Index of the hop in its lap (`:h<i>` suffix of the hopId), `null` when the id has no such suffix. */
  hopIndex: number | null;
  startTs: number;
  /** `[ts, stateEnteredName]` for every transition, in file order. */
  states: [number, string][];
  endTs: number | null;
  outcome: string | null;
  /** The route the `hop_end` line carried (`A->B`), when it has ended. */
  route: string | null;
}

export interface DigestLap {
  lapId: string;
  userId: string;
  startTs: number;
  endTs: number | null;
  outcome: string | null;
}

export interface DigestResource {
  ts: number;
  rssMb: number;
  cpuPct: number;
  eventLoopP99Ms: number | null;
  browserRssMb: number;
}

export interface DigestWalletCounters {
  userId: string;
  ticks: number;
  ticksSkipped: number;
  lapsDone: number;
  lapsFailed: number;
  lapsAborted: number;
  hopsOk: number;
  hopsFailed: number;
}

export interface DigestPumpDeposit {
  ts: number;
  txHash: string;
  blockNumber: string;
  depositCount: number | null;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  costWei: string;
  cumulativeSpendWei: string;
}

export interface DigestPumpSkip {
  ts: number;
  reason: string;
  gasPriceWei: string | null;
  cumulativeSpendWei: string;
}

export interface DigestWalletBalance {
  ts: number;
  chainKey: string;
  n: number;
  minWei: string;
  medianWei: string;
  maxWei: string;
  lowest: { userId: string; wei: string }[];
}

export interface DigestLeaf {
  ts: number;
  blockNumber: string;
  leafCount: number;
  fromPump: boolean;
}

export interface DigestHttpWindow {
  ts: number;
  windowMs: number;
  classes: Record<
    string,
    Record<string, { n: number; byStatus: Record<string, number>; p90: number }>
  >;
}

export interface Digest {
  /** `false` when `activity.ndjson` was not found. */
  present: boolean;
  lines: number;
  malformed: number;
  truncatedTail: boolean;
  firstTs: number | null;
  lastTs: number | null;
  runStartTs: number | null;
  runEnd: {
    ts: number;
    aborted: boolean;
    abortCause: string | null;
    durationMs: number | null;
  } | null;
  hops: Map<string, DigestHop>;
  laps: Map<string, DigestLap>;
  /** `errorClass` counts per absolute minute (`floor(ts / 60000)`). */
  errorMinutes: Map<number, Record<string, number>>;
  errorTotals: Record<string, number>;
  resources: DigestResource[];
  pump: {
    started: boolean;
    deposits: DigestPumpDeposit[];
    skipped: DigestPumpSkip[];
  };
  walletBalances: DigestWalletBalance[];
  leaves: DigestLeaf[];
  leafPollErrors: number;
  httpWindows: DigestHttpWindow[];
  ticks: number;
  ticksSkipped: number;
  txSent: number;
  wallets: Map<string, DigestWalletCounters>;
}

export const emptyDigest = (present = false): Digest => ({
  present,
  lines: 0,
  malformed: 0,
  truncatedTail: false,
  firstTs: null,
  lastTs: null,
  runStartTs: null,
  runEnd: null,
  hops: new Map(),
  laps: new Map(),
  errorMinutes: new Map(),
  errorTotals: {},
  resources: [],
  pump: { started: false, deposits: [], skipped: [] },
  walletBalances: [],
  leaves: [],
  leafPollErrors: 0,
  httpWindows: [],
  ticks: 0,
  ticksSkipped: 0,
  txSent: 0,
  wallets: new Map()
});

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const hopIndexOf = (hopId: string): number | null => {
  const match = /:h(\d+)$/.exec(hopId);
  return match === null ? null : Number.parseInt(match[1], 10);
};

const isHarnessUser = (userId: string | null): boolean =>
  userId === null || userId.startsWith('harness:');

/** Folds one parsed record into the digest. Exported for tests and for in-memory use. */
export const ingestRecord = (digest: Digest, record: Record<string, unknown>): void => {
  const kind = asString(record.kind);
  const tsIso = asString(record.ts);
  const ts = tsIso === null ? Number.NaN : Date.parse(tsIso);
  if (kind === null || Number.isNaN(ts)) {
    digest.malformed += 1;
    return;
  }
  digest.lines += 1;
  if (digest.firstTs === null || ts < digest.firstTs) digest.firstTs = ts;
  if (digest.lastTs === null || ts > digest.lastTs) digest.lastTs = ts;

  const userId = asString(record.userId);
  const wallet = (): DigestWalletCounters | null => {
    if (userId === null || isHarnessUser(userId)) return null;
    let entry = digest.wallets.get(userId);
    if (entry === undefined) {
      entry = {
        userId,
        ticks: 0,
        ticksSkipped: 0,
        lapsDone: 0,
        lapsFailed: 0,
        lapsAborted: 0,
        hopsOk: 0,
        hopsFailed: 0
      };
      digest.wallets.set(userId, entry);
    }
    return entry;
  };

  switch (kind) {
    case 'run_start':
      digest.runStartTs = ts;
      return;
    case 'run_end':
      digest.runEnd = {
        ts,
        aborted: record.aborted === true,
        abortCause: asString(record.abortCause),
        durationMs: asNumber(record.durationMs)
      };
      return;
    case 'tick': {
      digest.ticks += 1;
      const w = wallet();
      if (w !== null) w.ticks += 1;
      return;
    }
    case 'tick_skipped': {
      digest.ticksSkipped += 1;
      const w = wallet();
      if (w !== null) w.ticksSkipped += 1;
      return;
    }
    case 'hop_state': {
      const hopId = asString(record.hopId);
      const to = asString(record.to);
      if (hopId === null || to === null) return;
      let hop = digest.hops.get(hopId);
      if (hop === undefined) {
        const lapId = asString(record.lapId) ?? hopId.replace(/:h\d+$/, '');
        hop = {
          hopId,
          lapId,
          userId: userId ?? '',
          hopIndex: hopIndexOf(hopId),
          startTs: ts,
          states: [],
          endTs: null,
          outcome: null,
          route: null
        };
        digest.hops.set(hopId, hop);
        const lap = digest.laps.get(lapId);
        if (lap === undefined) {
          digest.laps.set(lapId, {
            lapId,
            userId: userId ?? '',
            startTs: ts,
            endTs: null,
            outcome: null
          });
        } else if (ts < lap.startTs) {
          lap.startTs = ts;
        }
      }
      hop.states.push([ts, to]);
      return;
    }
    case 'hop_end': {
      const hopId = asString(record.hopId);
      if (hopId === null) return;
      const outcome = asString(record.outcome);
      let hop = digest.hops.get(hopId);
      if (hop === undefined) {
        // A hop_end without hop_state lines (a truncated head): keep it so counts agree.
        hop = {
          hopId,
          lapId: asString(record.lapId) ?? hopId.replace(/:h\d+$/, ''),
          userId: userId ?? '',
          hopIndex: hopIndexOf(hopId),
          startTs: ts,
          states: [],
          endTs: null,
          outcome: null,
          route: null
        };
        digest.hops.set(hopId, hop);
      }
      hop.endTs = ts;
      hop.outcome = outcome;
      hop.route = asString(record.hopRoute);
      const w = wallet();
      if (w !== null && outcome !== null) {
        if (isSuccessOutcome(outcome as Parameters<typeof isSuccessOutcome>[0])) w.hopsOk += 1;
        else w.hopsFailed += 1;
      }
      return;
    }
    case 'lap_end': {
      const lapId = asString(record.lapId);
      if (lapId === null) return;
      const outcome = asString(record.outcome);
      let lap = digest.laps.get(lapId);
      if (lap === undefined) {
        lap = { lapId, userId: userId ?? '', startTs: ts, endTs: null, outcome: null };
        digest.laps.set(lapId, lap);
      }
      lap.endTs = ts;
      lap.outcome = outcome;
      const w = wallet();
      if (w !== null) {
        if (outcome === 'LAP_DONE') w.lapsDone += 1;
        else if (outcome === 'LAP_FAILED') w.lapsFailed += 1;
        else if (outcome === 'LAP_ABORTED') w.lapsAborted += 1;
      }
      return;
    }
    case 'error': {
      const errorClass = asString(record.errorClass) ?? 'unknown';
      const minute = Math.floor(ts / 60_000);
      const bucket = digest.errorMinutes.get(minute) ?? {};
      bucket[errorClass] = (bucket[errorClass] ?? 0) + 1;
      digest.errorMinutes.set(minute, bucket);
      digest.errorTotals[errorClass] = (digest.errorTotals[errorClass] ?? 0) + 1;
      return;
    }
    case 'resource_sample': {
      const browserProcesses = Array.isArray(record.browserProcesses)
        ? record.browserProcesses
        : [];
      digest.resources.push({
        ts,
        rssMb: asNumber(record.toolRssMb) ?? 0,
        cpuPct: asNumber(record.toolCpuPct) ?? 0,
        eventLoopP99Ms: asNumber(record.eventLoopDelayP99Ms),
        browserRssMb: browserProcesses.reduce(
          (sum: number, p) => sum + (asNumber((p as Record<string, unknown>)?.rssMb) ?? 0),
          0
        )
      });
      return;
    }
    case 'tx_sent':
      digest.txSent += 1;
      return;
    case 'pump_state':
      if (record.state === 'started') digest.pump.started = true;
      return;
    case 'pump_deposit':
      digest.pump.deposits.push({
        ts,
        txHash: asString(record.txHash) ?? '',
        blockNumber: asString(record.blockNumber) ?? '',
        depositCount: asNumber(record.depositCount),
        status: asString(record.status) ?? '',
        gasUsed: asString(record.gasUsed) ?? '0',
        effectiveGasPrice: asString(record.effectiveGasPrice) ?? '0',
        costWei: asString(record.costWei) ?? '0',
        cumulativeSpendWei: asString(record.cumulativeSpendWei) ?? '0'
      });
      return;
    case 'pump_skipped':
      digest.pump.skipped.push({
        ts,
        reason: asString(record.reason) ?? 'unknown',
        gasPriceWei: asString(record.gasPriceWei),
        cumulativeSpendWei: asString(record.cumulativeSpendWei) ?? '0'
      });
      return;
    case 'wallet_balance':
      digest.walletBalances.push({
        ts,
        chainKey: asString(record.chainKey) ?? '',
        n: asNumber(record.n) ?? 0,
        minWei: asString(record.minWei) ?? '0',
        medianWei: asString(record.medianWei) ?? '0',
        maxWei: asString(record.maxWei) ?? '0',
        lowest: Array.isArray(record.lowest)
          ? (record.lowest as Record<string, unknown>[]).map((entry) => ({
              userId: asString(entry.userId) ?? '',
              wei: asString(entry.wei) ?? '0'
            }))
          : []
      });
      return;
    case 'l1_info_leaf':
      digest.leaves.push({
        ts,
        blockNumber: asString(record.blockNumber) ?? '',
        leafCount: asNumber(record.leafCount) ?? 0,
        fromPump: record.fromPump === true
      });
      return;
    case 'l1_info_poll_error':
      digest.leafPollErrors += 1;
      return;
    case 'http_window':
      digest.httpWindows.push({
        ts,
        windowMs: asNumber(record.windowMs) ?? 0,
        classes:
          typeof record.classes === 'object' && record.classes !== null
            ? (record.classes as DigestHttpWindow['classes'])
            : {}
      });
      return;
    default:
      // user_ready, hop_measurement, tx_receipt, ...: not needed for the report.
      return;
  }
};

/** Builds a digest from NDJSON text (tests, small inputs). */
export const digestFromText = (text: string): Digest => {
  const digest = emptyDigest(true);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      ingestRecord(digest, JSON.parse(line) as Record<string, unknown>);
    } catch {
      digest.malformed += 1;
      if (
        index === lines.length - 1 ||
        (index === lines.length - 2 && lines[lines.length - 1] === '')
      ) {
        digest.truncatedTail = true;
      }
    }
  });
  return digest;
};

/**
 * Streams `activity.ndjson` into a digest. A missing file gives `present: false`.
 * The final line is judged "truncated" when it fails to parse and the file does
 * not end in a newline.
 */
export const digestFromFile = async (filePath: string): Promise<Digest> => {
  if (!fs.existsSync(filePath)) return emptyDigest(false);
  const digest = emptyDigest(true);
  const endsWithNewline = (() => {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return true;
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      return buf[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  })();

  const reader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  let pendingBad = false;
  for await (const line of reader) {
    if (line.trim() === '') continue;
    pendingBad = false;
    try {
      ingestRecord(digest, JSON.parse(line) as Record<string, unknown>);
    } catch {
      digest.malformed += 1;
      pendingBad = true;
    }
  }
  digest.truncatedTail = pendingBad && !endsWithNewline;
  return digest;
};

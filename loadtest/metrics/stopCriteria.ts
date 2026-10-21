// Read-only evaluation of the heavy-load stop criteria SC1-SC13 (S54, heavy-load
// design §3; thresholds copied from `tmp/loadtest-heavy/campaign.md` §6).
//
// Pure: it reads a `Digest` of `activity.ndjson` (plus optional inputs taken from
// `results.json`) and returns one row per criterion. It never sends a signal and
// never stops a run; the operator decides. Used by `pnpm loadtest check-stop` and
// by section 13 of the HTML report.
import { formatEther, parseEther } from 'viem';

import type { Digest } from './html/ndjsonDigest';

import { isSuccessOutcome } from '../core/types';

/** Thresholds, exported with their ids so the report and the CLI print the same numbers. */
export const SC = {
  SC1_MIN_HARD_FAILURES: 5,
  SC1_RATE: 0.02,
  SC1_RATE_MIN_HOPS: 50,
  /** S58a M1: the rate branch also needs this many hard failures, so one early failure is never a rate. */
  SC1_RATE_MIN_FAILURES: 2,
  SC2_STALL_MIN: 30,
  SC3_STALL_MIN: 120,
  SC4_WINDOW_MIN: 10,
  SC4_ERRORS: 30,
  SC5_NONCE_CONFLICTS: 20,
  SC6_RSS_MB: 4096,
  SC6_SAMPLES: 3,
  SC7_ELP99_MS: 500,
  SC7_SAMPLES: 12,
  SC8_CPU_PCT: 90,
  SC8_SAMPLES: 60,
  SC9_FLOOR_FRACTION: 0.2,
  SC13_SKIPPED_RATIO: 0.25,
  GATE_READY_P90_MS: 20 * 60_000
} as const;

/** SC1 outcome set (mirrors `HARD_HOP_FAILURE_OUTCOMES` in `report.ts`; kept literal so this module stays free of that import cycle). */
const SC1_OUTCOMES: ReadonlySet<string> = new Set([
  'revert_approve',
  'revert_bridge',
  'revert_claim',
  'tx_revert',
  'lbt_underflow',
  'bridge_event_missing',
  'activity_status_error',
  'rpc_error',
  'proxy_4xx',
  'proxy_5xx',
  'internal'
]);

export type CriterionKind = 'stop' | 'gate' | 'outside';

export interface CriterionResult {
  id: string;
  title: string;
  kind: CriterionKind;
  /** Rule in words with the threshold. */
  threshold: string;
  /** Observed value in words; `n/a` when not evaluable. */
  value: string;
  /** `null` when not evaluable or outside the tool. */
  fired: boolean | null;
  /** First time (ms epoch) the condition held, when fired and derivable. */
  firstFiredAt: number | null;
  /** Reason shown when `fired` is null, or an extra remark. */
  note: string;
}

export interface StopCriteriaInput {
  digest: Digest;
  /** `config.ring`: chain keys in order. */
  ring: readonly string[];
  /** `config.chains[]` for key to networkId; when absent the trailing digits of a chain key are used. */
  chains?: readonly { key: string; networkId: number }[];
  /** `config.users.funder.gasPerChain` (decimal ETH strings). */
  gasPerChain?: Record<string, string>;
  /** `results.pump`, when the pump ran. */
  pump?: { maxTotalSpendWei: string; totalSpendWei: string } | null;
  /** Successful-hop ready waits (ms) per route, from `results.measurements`. Gate only. */
  readyWaitByRoute?: Record<string, number[]>;
}

const fmtMin = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

const networkOf = (
  key: string,
  chains: readonly { key: string; networkId: number }[] | undefined
): number | null => {
  const found = chains?.find((c) => c.key === key);
  if (found !== undefined) return found.networkId;
  const match = /(\d+)$/.exec(key);
  return match === null ? null : Number.parseInt(match[1], 10);
};

/** The route (`A->B`) of a hop, from its `hop_end` line or else its `:h<i>` suffix and the ring. */
export const routeOfHop = (
  hop: { route: string | null; hopIndex: number | null },
  ring: readonly string[]
): string | null => {
  if (hop.route !== null) return hop.route;
  if (hop.hopIndex === null || hop.hopIndex + 1 >= ring.length) return null;
  return `${ring[hop.hopIndex]}->${ring[hop.hopIndex + 1]}`;
};

const longestStreak = (
  samples: readonly { ts: number }[],
  over: (index: number) => boolean,
  needed: number
): { longest: number; firstFiredAt: number | null } => {
  let run = 0;
  let longest = 0;
  let firstFiredAt: number | null = null;
  samples.forEach((sample, index) => {
    if (over(index)) {
      run += 1;
      longest = Math.max(longest, run);
      if (run === needed && firstFiredAt === null) firstFiredAt = sample.ts;
    } else {
      run = 0;
    }
  });
  return { longest, firstFiredAt };
};

/** Largest sum over any `windowMin` consecutive minutes of the given classes, and when it first reached `limit`. */
const slidingMinuteWindow = (
  digest: Digest,
  classes: readonly string[],
  windowMin: number,
  limit: number
): { max: number; firstAt: number | null } => {
  const minutes = [...digest.errorMinutes.keys()].sort((a, b) => a - b);
  if (minutes.length === 0) return { max: 0, firstAt: null };
  const countAt = (minute: number): number => {
    const bucket = digest.errorMinutes.get(minute);
    return bucket === undefined ? 0 : classes.reduce((sum, c) => sum + (bucket[c] ?? 0), 0);
  };
  let max = 0;
  let firstAt: number | null = null;
  for (let end = minutes[0]; end <= minutes[minutes.length - 1]; end += 1) {
    let sum = 0;
    for (let m = end - windowMin + 1; m <= end; m += 1) sum += countAt(m);
    if (sum > max) max = sum;
    if (sum >= limit && firstAt === null) firstAt = (end + 1) * 60_000;
  }
  return { max, firstAt };
};

interface StallResult {
  inFlight: number;
  stalledMs: number;
  firstFiredAt: number | null;
  lastSuccessAt: number | null;
}

/** SC2/SC3: in-flight hops on a route and no successful `hop_end` on it for `limitMs`. */
const evaluateStall = (
  digest: Digest,
  ring: readonly string[],
  route: string,
  limitMs: number
): StallResult => {
  const now = digest.lastTs ?? 0;
  const events: { ts: number; delta: number; success: boolean }[] = [];
  let firstStart: number | null = null;
  for (const hop of digest.hops.values()) {
    if (routeOfHop(hop, ring) !== route) continue;
    events.push({ ts: hop.startTs, delta: 1, success: false });
    firstStart = firstStart === null ? hop.startTs : Math.min(firstStart, hop.startTs);
    if (hop.endTs !== null) {
      const success = hop.outcome !== null && isSuccessOutcome(hop.outcome as never);
      events.push({ ts: hop.endTs, delta: -1, success });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.delta - b.delta);
  let inFlight = 0;
  let lastSuccess: number | null = null;
  let firstFiredAt: number | null = null;
  // S58a H2: the window runs from the later of the last success and the moment the
  // CURRENT in-flight period began (the count rose from 0). Without the second term a
  // route that sits idle for a while (ring J's 82>85 hop, which only starts after an
  // 85>82 hop completes) fires the instant its next hop starts.
  let periodStart: number | null = null;
  const windowBase = (): number => Math.max(lastSuccess ?? periodStart ?? 0, periodStart ?? 0);
  const check = (from: number, to: number): void => {
    if (inFlight <= 0 || firstStart === null || firstFiredAt !== null) return;
    const fireAt = Math.max(from, windowBase() + limitMs);
    if (fireAt < to || (to === now && fireAt <= now)) firstFiredAt = fireAt;
  };
  let cursor = events.length > 0 ? events[0].ts : now;
  for (const event of events) {
    check(cursor, event.ts);
    if (event.delta > 0 && inFlight <= 0) periodStart = event.ts;
    inFlight += event.delta;
    if (event.success) lastSuccess = event.ts;
    cursor = event.ts;
  }
  check(cursor, now);
  const base = firstStart === null ? now : windowBase();
  return {
    inFlight,
    stalledMs: inFlight > 0 ? Math.max(0, now - base) : 0,
    firstFiredAt,
    lastSuccessAt: lastSuccess
  };
};

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];

export const evaluateStopCriteria = (input: StopCriteriaInput): CriterionResult[] => {
  const { digest, ring } = input;
  const results: CriterionResult[] = [];
  const noData = digest.present ? null : 'activity.ndjson not found';
  const notEvaluable = (
    id: string,
    title: string,
    kind: CriterionKind,
    threshold: string,
    note: string
  ): CriterionResult => ({
    id,
    title,
    kind,
    threshold,
    value: 'n/a',
    fired: null,
    firstFiredAt: null,
    note
  });
  const push = (r: CriterionResult): void => {
    results.push(r);
  };

  // SC1
  {
    const title = 'Hard hop failures';
    const threshold = `>= ${SC.SC1_MIN_HARD_FAILURES} hard failures, or >= ${SC.SC1_RATE * 100}% (and >= ${SC.SC1_RATE_MIN_FAILURES} failures) once ${SC.SC1_RATE_MIN_HOPS} hops have ended`;
    if (noData !== null) push(notEvaluable('SC1', title, 'stop', threshold, noData));
    else {
      const ended = [...digest.hops.values()]
        .filter((h) => h.endTs !== null && h.outcome !== null)
        .sort((a, b) => (a.endTs as number) - (b.endTs as number));
      let hard = 0;
      let firstFiredAt: number | null = null;
      // S58a M1: the condition is judged over the whole run so far, not latched at the first
      // moment it held. The absolute branch is cumulative and never recovers; the rate branch
      // can (one early failure among 50 hops is 2%, but 0.5% by the end of the run), so a
      // breach that has since cleared is reported as not fired. The rate branch also needs
      // at least SC1_RATE_MIN_FAILURES hard failures.
      const holds = (failures: number, count: number): boolean =>
        failures >= SC.SC1_MIN_HARD_FAILURES ||
        (count >= SC.SC1_RATE_MIN_HOPS &&
          failures >= SC.SC1_RATE_MIN_FAILURES &&
          failures / count >= SC.SC1_RATE);
      ended.forEach((hop, index) => {
        if (SC1_OUTCOMES.has(hop.outcome as string)) hard += 1;
        if (firstFiredAt === null && holds(hard, index + 1)) firstFiredAt = hop.endTs;
      });
      if (!holds(hard, ended.length)) firstFiredAt = null;
      const rate = ended.length > 0 ? hard / ended.length : null;
      push({
        id: 'SC1',
        title,
        kind: 'stop',
        threshold,
        value: `${hard} of ${ended.length} ended hops${rate === null ? '' : ` (${(rate * 100).toFixed(2)}%)`}`,
        fired: firstFiredAt !== null,
        firstFiredAt,
        note: ''
      });
    }
  }

  // SC2 / SC3
  for (const [id, from, to, limitMin] of [
    ['SC2', 82, 85, SC.SC2_STALL_MIN],
    ['SC3', 85, 82, SC.SC3_STALL_MIN]
  ] as const) {
    const title = `Stalled ${from}>${to}`;
    const threshold = `in-flight > 0 and no successful ${from}>${to} hop for >= ${limitMin} min`;
    const route = ring
      .slice(0, -1)
      .map((key, i) => ({
        route: `${key}->${ring[i + 1]}`,
        from: networkOf(key, input.chains),
        to: networkOf(ring[i + 1], input.chains)
      }))
      .find((r) => r.from === from && r.to === to);
    if (noData !== null) push(notEvaluable(id, title, 'stop', threshold, noData));
    else if (route === undefined) {
      push(notEvaluable(id, title, 'stop', threshold, `route ${from}>${to} is not in this ring`));
    } else {
      const stall = evaluateStall(digest, ring, route.route, limitMin * 60_000);
      push({
        id,
        title,
        kind: 'stop',
        threshold,
        value:
          stall.inFlight > 0
            ? `${stall.inFlight} in flight, ${fmtMin(stall.stalledMs)} since last success`
            : 'none in flight',
        fired: stall.firstFiredAt !== null,
        firstFiredAt: stall.firstFiredAt,
        note: ''
      });
    }
  }

  // SC4
  {
    const title = 'Proxy 4xx/5xx burst';
    const threshold = `>= ${SC.SC4_ERRORS} proxy_5xx + proxy_4xx within ${SC.SC4_WINDOW_MIN} min`;
    if (noData !== null) push(notEvaluable('SC4', title, 'stop', threshold, noData));
    else {
      const w = slidingMinuteWindow(
        digest,
        ['proxy_5xx', 'proxy_4xx'],
        SC.SC4_WINDOW_MIN,
        SC.SC4_ERRORS
      );
      push({
        id: 'SC4',
        title,
        kind: 'stop',
        threshold,
        value: `max ${w.max} in any ${SC.SC4_WINDOW_MIN} min window`,
        fired: w.max >= SC.SC4_ERRORS,
        firstFiredAt: w.firstAt,
        note: 'tracker_not_ready, not_ready and activity_warning are excluded'
      });
    }
  }

  // SC5
  {
    const title = 'Nonce conflicts';
    const threshold = `>= ${SC.SC5_NONCE_CONFLICTS} nonce_conflict errors`;
    if (noData !== null) push(notEvaluable('SC5', title, 'stop', threshold, noData));
    else {
      const total = digest.errorTotals.nonce_conflict ?? 0;
      let cumulative = 0;
      let firstFiredAt: number | null = null;
      for (const minute of [...digest.errorMinutes.keys()].sort((a, b) => a - b)) {
        cumulative += digest.errorMinutes.get(minute)?.nonce_conflict ?? 0;
        if (cumulative >= SC.SC5_NONCE_CONFLICTS && firstFiredAt === null) {
          firstFiredAt = (minute + 1) * 60_000;
        }
      }
      push({
        id: 'SC5',
        title,
        kind: 'stop',
        threshold,
        value:
          digest.txSent > 0
            ? `${total} (${((total / digest.txSent) * 100).toFixed(2)}% of ${digest.txSent} sent txs)`
            : `${total}`,
        fired: total >= SC.SC5_NONCE_CONFLICTS,
        firstFiredAt,
        note: digest.txSent > 0 ? '' : 'rate needs tx_sent records (measurement block)'
      });
    }
  }

  // SC6-SC8
  const resourceRows: [string, string, string, number, (i: number) => boolean, string][] = [
    [
      'SC6',
      'Tool memory',
      `RSS > ${SC.SC6_RSS_MB} MB for ${SC.SC6_SAMPLES} consecutive samples`,
      SC.SC6_SAMPLES,
      (i) => digest.resources[i].rssMb > SC.SC6_RSS_MB,
      'MB'
    ],
    [
      'SC7',
      'Event loop lag',
      `event-loop p99 > ${SC.SC7_ELP99_MS} ms for ${SC.SC7_SAMPLES} consecutive samples`,
      SC.SC7_SAMPLES,
      (i) => (digest.resources[i].eventLoopP99Ms ?? 0) > SC.SC7_ELP99_MS,
      'ms'
    ],
    [
      'SC8',
      'Tool CPU',
      `CPU > ${SC.SC8_CPU_PCT}% for ${SC.SC8_SAMPLES} consecutive samples`,
      SC.SC8_SAMPLES,
      (i) => digest.resources[i].cpuPct > SC.SC8_CPU_PCT,
      '%'
    ]
  ];
  for (const [id, title, threshold, needed, over, unit] of resourceRows) {
    if (noData !== null) push(notEvaluable(id, title, 'stop', threshold, noData));
    else if (digest.resources.length === 0) {
      push(notEvaluable(id, title, 'stop', threshold, 'no resource samples'));
    } else {
      const streak = longestStreak(digest.resources, over, needed);
      const peak =
        id === 'SC6'
          ? Math.max(...digest.resources.map((r) => r.rssMb))
          : id === 'SC7'
            ? Math.max(...digest.resources.map((r) => r.eventLoopP99Ms ?? 0))
            : Math.max(...digest.resources.map((r) => r.cpuPct));
      push({
        id,
        title,
        kind: 'stop',
        threshold,
        value: `peak ${peak.toFixed(unit === '%' ? 0 : 1)} ${unit}, longest streak ${streak.longest} sample(s)`,
        fired: streak.longest >= needed,
        firstFiredAt: streak.firstFiredAt,
        note:
          id === 'SC7'
            ? 'when fired, tool-side latencies after that moment are not trustworthy'
            : ''
      });
    }
  }

  // SC9
  {
    const title = 'Wallet balance floor';
    const threshold = `any chain min balance < ${SC.SC9_FLOOR_FRACTION} x gasPerChain`;
    if (noData !== null) push(notEvaluable('SC9', title, 'stop', threshold, noData));
    else if (digest.walletBalances.length === 0) {
      push(
        notEvaluable(
          'SC9',
          title,
          'stop',
          threshold,
          'not evaluable (missing M1: wallet balances not sampled)'
        )
      );
    } else if (input.gasPerChain === undefined) {
      push(
        notEvaluable(
          'SC9',
          title,
          'stop',
          threshold,
          'config.users.funder.gasPerChain not available'
        )
      );
    } else {
      let worstRatio: number | null = null;
      let worstChain = '';
      let firstFiredAt: number | null = null;
      for (const sample of digest.walletBalances) {
        const gas = input.gasPerChain[sample.chainKey];
        if (gas === undefined) continue;
        const floor = parseEther(gas);
        if (floor === BigInt(0)) continue;
        const ratio = Number((BigInt(sample.minWei) * BigInt(1_000_000)) / floor) / 1_000_000;
        if (worstRatio === null || ratio < worstRatio) {
          worstRatio = ratio;
          worstChain = sample.chainKey;
        }
        if (ratio < SC.SC9_FLOOR_FRACTION && firstFiredAt === null) firstFiredAt = sample.ts;
      }
      push({
        id: 'SC9',
        title,
        kind: 'stop',
        threshold,
        value:
          worstRatio === null
            ? 'n/a'
            : `lowest ${worstRatio.toFixed(2)} x gasPerChain on ${worstChain}`,
        fired: worstRatio === null ? null : worstRatio < SC.SC9_FLOOR_FRACTION,
        firstFiredAt,
        note: worstRatio === null ? 'no sampled chain has a gasPerChain entry' : ''
      });
    }
  }

  // SC10
  push({
    id: 'SC10',
    title: 'Funding and funder floor',
    kind: 'outside',
    threshold: 'checked before the run (fund cap, PUMP_UNDERFUNDED, funder balance)',
    value: 'outside the tool',
    fired: null,
    firstFiredAt: null,
    note: 'outside the tool: check with cast balance per the runbook'
  });

  // SC11
  {
    const title = 'Pump spend cap and gas pause';
    const threshold =
      'enforced inside the tool: cumulative spend < maxTotalSpend; fires when the pump reaches the cap (cap_reached skip or spend >= cap); pauses above maxGasPriceGwei';
    const deposits = digest.pump.deposits;
    const gasSkips = digest.pump.skipped.filter((s) => s.reason === 'gas_price').length;
    if (!digest.pump.started && input.pump == null && deposits.length === 0) {
      push(
        notEvaluable(
          'SC11',
          title,
          'stop',
          threshold,
          'not evaluable (pump off or no pump records)'
        )
      );
    } else {
      const spent =
        input.pump?.totalSpendWei ??
        (deposits.length > 0 ? deposits[deposits.length - 1].cumulativeSpendWei : '0');
      const cap = input.pump?.maxTotalSpendWei;
      // S58a L4: the pump stops BEFORE a deposit would take it over the cap, so `spent > cap`
      // can never hold. "Reaches the cap" is spend >= cap or the pump's own `cap_reached` skip.
      const capSkips = digest.pump.skipped.filter((s) => s.reason === 'cap_reached').length;
      const over =
        capSkips > 0 ? true : cap !== undefined ? BigInt(spent) >= BigInt(cap) : null;
      push({
        id: 'SC11',
        title,
        kind: 'stop',
        threshold,
        value: `${deposits.length} deposit(s), spend ${formatEther(BigInt(spent))} ETH${cap === undefined ? '' : ` of cap ${formatEther(BigInt(cap))} ETH`}, ${gasSkips} gas_price skip(s)`,
        fired: over,
        firstFiredAt: null,
        note: cap === undefined ? 'cap not available without results.json' : ''
      });
    }
  }

  // SC12
  push({
    id: 'SC12',
    title: 'Grafana alerts',
    kind: 'outside',
    threshold: 'campaign section 6 queries',
    value: 'outside the tool',
    fired: null,
    firstFiredAt: null,
    note: 'check Grafana (campaign section 6 queries)'
  });

  // SC13
  {
    const title = 'Backpressure share';
    const threshold = `tick_skipped / (tick + tick_skipped) >= ${SC.SC13_SKIPPED_RATIO * 100}% (stage gate, not a stop)`;
    if (noData !== null) push(notEvaluable('SC13', title, 'gate', threshold, noData));
    else {
      const total = digest.ticks + digest.ticksSkipped;
      push({
        id: 'SC13',
        title,
        kind: 'gate',
        threshold,
        value:
          total === 0
            ? 'no ticks'
            : `${((digest.ticksSkipped / total) * 100).toFixed(1)}% (${digest.ticksSkipped} of ${total})`,
        fired: total === 0 ? null : digest.ticksSkipped / total >= SC.SC13_SKIPPED_RATIO,
        firstFiredAt: null,
        note: total === 0 ? 'no tick records' : ''
      });
    }
  }

  // Gate
  {
    const title = 'Stage gate: 82>85 ready-wait p90';
    const threshold = `p90 of (ready observed - bridge mined) <= ${SC.GATE_READY_P90_MS / 60_000} min`;
    const route = ring
      .slice(0, -1)
      .map((key, i) => ({
        route: `${key}->${ring[i + 1]}`,
        from: networkOf(key, input.chains),
        to: networkOf(ring[i + 1], input.chains)
      }))
      .find((r) => r.from === 82 && r.to === 85);
    const waits = route === undefined ? undefined : input.readyWaitByRoute?.[route.route];
    if (route === undefined)
      push(notEvaluable('Gate', title, 'gate', threshold, 'route 82>85 is not in this ring'));
    else if (waits === undefined || waits.length === 0) {
      push(
        notEvaluable(
          'Gate',
          title,
          'gate',
          threshold,
          'after the run only (needs results.json measurements)'
        )
      );
    } else {
      const p90 = percentile(
        [...waits].sort((a, b) => a - b),
        0.9
      );
      push({
        id: 'Gate',
        title,
        kind: 'gate',
        threshold,
        value: `${fmtMin(p90)} over ${waits.length} hop(s)`,
        fired: p90 > SC.GATE_READY_P90_MS,
        firstFiredAt: null,
        note: ''
      });
    }
  }

  return results;
};

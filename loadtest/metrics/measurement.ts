// Measurement support (S45, trails-pilot measurement design C3/C4): the
// per-hop `hop_measurement` record shape, min / true-median / max stats, the
// `results.json` `measurements` block builder and the `summary.md` section
// renderer. Pure — no I/O. `report.ts` wires it into `buildResultsJson` /
// `renderSummaryMd`; `collector.ts` stores the records and writes the ndjson
// line. The existing global `Stats` shape (nearest-rank p50, no min) is
// deliberately untouched.
import type { AssetKind, Outcome } from '../core/types';
import type { ClaimPreState, ClaimStageProbeResult, ReceiptGas } from '../core/userDriver';

export type { ClaimPreState };

import { isSuccessOutcome } from '../core/types';

export type ClaimKind =
  | 'eth'
  | 'erc20_wrapper_deploy'
  | 'erc20_wrapped_mint'
  | 'erc20_origin_unlock'
  | 'raced'
  | 'none';

export interface HopMeasurementRecord {
  hopId: string;
  lapId: string;
  userId: string;
  mode: 'browser' | 'headless';
  hopRoute: string;
  fromNetworkId: number;
  toNetworkId: number;
  assetKind: AssetKind;
  assetIndex: number;
  tokenOriginNetworkId?: number;
  outcome: Outcome;
  depositCount: number | null;
  bridge: {
    txHash: string | null;
    blockNumber: string | null;
    /** Client time (ms epoch) the bridge receipt was observed — T0. */
    minedObservedAt: number | null;
    gas: ReceiptGas | null;
  };
  /**
   * S53 M8: the ERC-20 approve of this hop, when it sent one. Present only when
   * `measurement` is configured, so a config without it keeps identical records.
   */
  approve?: { txHash: string | null; gas: ReceiptGas | null };
  /** Stage probe result; `null` when the probe was off or never started. */
  stages: ClaimStageProbeResult | null;
  /** First-observed READY_TO_CLAIM (ms epoch) — the tracker's view, T3b. */
  readyObservedAt: number | null;
  claim: {
    txHash: string | null;
    blockNumber: string | null;
    /** Client time the claim tx was accepted by the node (ms epoch). */
    sentAt: number | null;
    /** Client time the claim receipt was observed (ms epoch). */
    minedObservedAt: number | null;
    gas: ReceiptGas | null;
    claimKind: ClaimKind;
    /** S53 M9: present only when `measurement.claimPreState` was on and the read succeeded. */
    preState?: ClaimPreState;
  };
}

// ---------------------------------------------------------------------------
// Claim kind
// ---------------------------------------------------------------------------

export const deriveClaimKind = (input: {
  assetKind: AssetKind;
  toNetworkId: number;
  tokenOriginNetworkId?: number;
  /** A claim tx that reached a receipt, and whether that receipt succeeded. */
  claimStatus: 'success' | 'reverted' | null;
  wrapperDeployed?: boolean;
  /** `isClaimedBefore` or the post-failure `isClaimedRecheck` was true: someone else claimed it. */
  alreadyClaimed: boolean;
}): ClaimKind => {
  if (input.claimStatus !== 'success') return input.alreadyClaimed ? 'raced' : 'none';
  if (input.assetKind === 'eth') return 'eth';
  if (input.wrapperDeployed === true) return 'erc20_wrapper_deploy';
  if (input.tokenOriginNetworkId !== undefined && input.toNetworkId === input.tokenOriginNetworkId) {
    return 'erc20_origin_unlock';
  }
  return 'erc20_wrapped_mint';
};

// ---------------------------------------------------------------------------
// min / true median / max
// ---------------------------------------------------------------------------

export interface MinMedMax {
  n: number;
  min: number;
  /** True median: the mean of the two middle values for even n. */
  median: number;
  max: number;
}

export const minMedMax = (samples: readonly number[]): MinMedMax | null => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, min: sorted[0], median, max: sorted[sorted.length - 1] };
};

/** Same, for wei-sized values, serialised as decimal strings. Even-n median is the floor of the mean. */
export interface MinMedMaxWei {
  n: number;
  min: string;
  median: string;
  max: string;
}

export const minMedMaxWei = (samples: readonly bigint[]): MinMedMaxWei | null => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / BigInt(2);
  return {
    n: sorted.length,
    min: sorted[0].toString(),
    median: median.toString(),
    max: sorted[sorted.length - 1].toString()
  };
};

// ---------------------------------------------------------------------------
// `results.json` `measurements` block
// ---------------------------------------------------------------------------

export interface ClaimGasRow {
  toNetworkId: number;
  claimKind: ClaimKind;
  n: number;
  gasUsed: MinMedMaxWei;
  effectiveGasPrice: MinMedMaxWei;
  /** OP L1 data fee; `null` when no sample carried `l1Fee`. */
  l1Fee: MinMedMaxWei | null;
  /** `gasUsed * effectiveGasPrice + (l1Fee ?? 0)` per claim. */
  totalFeeWei: MinMedMaxWei;
}

export const STAGE_DELTAS = [
  'l1InfoTreeIndex',
  'injectedLeaf',
  'claimProof',
  'trackerLag',
  'claimTx',
  'endToEnd'
] as const;
export type StageDelta = (typeof STAGE_DELTAS)[number];

/** S53 M8: approve receipt gas per source network (hops that sent an approve). */
export interface ApproveGasRow {
  networkId: number;
  n: number;
  gasUsed: MinMedMaxWei;
  /** `gasUsed * effectiveGasPrice + (l1Fee ?? 0)` per approve. */
  totalFeeWei: MinMedMaxWei;
}

export interface StageLatencyRow {
  route: string;
  /** DONE hops on this route that entered the table. */
  hops: number;
  /** Per delta (ms). `null` when no hop had both timestamps. */
  deltas: Record<StageDelta, MinMedMax | null>;
}

export interface MeasurementsBlock {
  /** `measurement.stageProbeIntervalMs`, or `null` when the probe was off. */
  probeIntervalMs: number | null;
  hops: HopMeasurementRecord[];
  claimGas: ClaimGasRow[];
  stageLatency: StageLatencyRow[];
  /** Hops not counted in the tables above (failed / censored / not a success outcome). */
  excludedHops: number;
  /** S53 M8: only present when at least one counted hop carried approve gas. */
  approveGas?: ApproveGasRow[];
}

const big = (value: string | undefined): bigint | null => {
  if (value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const diff = (later: number | null | undefined, earlier: number | null | undefined): number | null =>
  later === null || later === undefined || earlier === null || earlier === undefined
    ? null
    : later - earlier;

/** Per-hop deltas (ms), `null` where a timestamp is missing. T0 = bridge mined (client). */
export const stageDeltas = (hop: HopMeasurementRecord): Record<StageDelta, number | null> => {
  const t0 = hop.bridge.minedObservedAt;
  return {
    l1InfoTreeIndex: diff(hop.stages?.l1InfoTreeIndexAt, t0),
    injectedLeaf: diff(hop.stages?.injectedLeafAt, t0),
    claimProof: diff(hop.stages?.claimProofAt, t0),
    trackerLag: diff(hop.readyObservedAt, hop.stages?.claimProofAt),
    claimTx: diff(hop.claim.minedObservedAt, hop.claim.sentAt),
    endToEnd: diff(hop.claim.minedObservedAt, t0)
  };
};

const buildApproveGas = (counted: readonly HopMeasurementRecord[]): ApproveGasRow[] => {
  const byNetwork = new Map<number, ReceiptGas[]>();
  for (const hop of counted) {
    const gas = hop.approve?.gas;
    if (gas === null || gas === undefined) continue;
    byNetwork.set(hop.fromNetworkId, [...(byNetwork.get(hop.fromNetworkId) ?? []), gas]);
  }
  const rows: ApproveGasRow[] = [];
  for (const [networkId, samples] of [...byNetwork.entries()].sort(([a], [b]) => a - b)) {
    const gasUsed = samples.map((g) => big(g.gasUsed));
    const price = samples.map((g) => big(g.effectiveGasPrice));
    if (gasUsed.includes(null) || price.includes(null)) continue;
    const totals = samples.map(
      (g) =>
        (big(g.gasUsed) as bigint) * (big(g.effectiveGasPrice) as bigint) +
        (big(g.l1Fee) ?? BigInt(0))
    );
    rows.push({
      networkId,
      n: samples.length,
      gasUsed: minMedMaxWei(gasUsed as bigint[]) as MinMedMaxWei,
      totalFeeWei: minMedMaxWei(totals) as MinMedMaxWei
    });
  }
  return rows;
};

export const buildMeasurements = (
  hops: readonly HopMeasurementRecord[],
  probeIntervalMs: number | null
): MeasurementsBlock => {
  const counted = hops.filter((h) => isSuccessOutcome(h.outcome));

  const gasGroups = new Map<string, { toNetworkId: number; claimKind: ClaimKind; gas: ReceiptGas[] }>();
  for (const hop of counted) {
    const gas = hop.claim.gas;
    if (gas === null || hop.claim.claimKind === 'raced' || hop.claim.claimKind === 'none') continue;
    const key = `${hop.toNetworkId}|${hop.claim.claimKind}`;
    const group = gasGroups.get(key) ?? {
      toNetworkId: hop.toNetworkId,
      claimKind: hop.claim.claimKind,
      gas: []
    };
    group.gas.push(gas);
    gasGroups.set(key, group);
  }
  const claimGas: ClaimGasRow[] = [];
  for (const group of [...gasGroups.values()].sort(
    (a, b) => a.toNetworkId - b.toNetworkId || a.claimKind.localeCompare(b.claimKind)
  )) {
    const gasUsed = group.gas.map((g) => big(g.gasUsed));
    const price = group.gas.map((g) => big(g.effectiveGasPrice));
    if (gasUsed.includes(null) || price.includes(null)) continue;
    const l1Fees = group.gas.map((g) => big(g.l1Fee)).filter((v): v is bigint => v !== null);
    const totals = group.gas.map(
      (g) => (big(g.gasUsed) as bigint) * (big(g.effectiveGasPrice) as bigint) + (big(g.l1Fee) ?? BigInt(0))
    );
    claimGas.push({
      toNetworkId: group.toNetworkId,
      claimKind: group.claimKind,
      n: group.gas.length,
      gasUsed: minMedMaxWei(gasUsed as bigint[]) as MinMedMaxWei,
      effectiveGasPrice: minMedMaxWei(price as bigint[]) as MinMedMaxWei,
      l1Fee: minMedMaxWei(l1Fees),
      totalFeeWei: minMedMaxWei(totals) as MinMedMaxWei
    });
  }

  const byRoute = new Map<string, HopMeasurementRecord[]>();
  for (const hop of counted) {
    const list = byRoute.get(hop.hopRoute) ?? [];
    list.push(hop);
    byRoute.set(hop.hopRoute, list);
  }
  const stageLatency: StageLatencyRow[] = [...byRoute.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, routeHops]) => {
      const perHop = routeHops.map(stageDeltas);
      const deltas = {} as Record<StageDelta, MinMedMax | null>;
      for (const name of STAGE_DELTAS) {
        deltas[name] = minMedMax(perHop.map((d) => d[name]).filter((v): v is number => v !== null));
      }
      return { route, hops: routeHops.length, deltas };
    });

  const approveGas = buildApproveGas(counted);

  return {
    probeIntervalMs,
    hops: [...hops],
    claimGas,
    stageLatency,
    excludedHops: hops.length - counted.length,
    ...(approveGas.length > 0 ? { approveGas } : {})
  };
};

// ---------------------------------------------------------------------------
// `summary.md` section
// ---------------------------------------------------------------------------

const mdTable = (headers: string[], rows: string[][]): string =>
  [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');

const fmtMmm = (stats: MinMedMax | null): string =>
  stats === null ? 'n/a' : `${stats.n} / ${stats.min} / ${stats.median} / ${stats.max}`;
const fmtWei = (stats: MinMedMaxWei | null): string =>
  stats === null ? 'n/a' : `${stats.min} / ${stats.median} / ${stats.max}`;

const DELTA_LABELS: Record<StageDelta, string> = {
  l1InfoTreeIndex: 'T1-T0 l1-info-tree-index available',
  injectedLeaf: 'T2-T0 injected-l1-info-leaf available',
  claimProof: 'T3-T0 claim-proof available',
  trackerLag: 'T3b-T3 tracker READY lag after claim-proof',
  claimTx: 'T5-T4 claim tx sent to mined',
  endToEnd: 'T5-T0 end to end (includes tracker lag)'
};

export const renderMeasurementsSection = (block: MeasurementsBlock | undefined): string => {
  if (block === undefined || block.hops.length === 0) return 'No measurements recorded.';

  const resolution =
    block.probeIntervalMs === null
      ? 'Stage probe was off: only the claim tx delta and end to end are available; stage columns are n/a.'
      : `Stage probe interval ${block.probeIntervalMs} ms: each stage time is an upper bound (true availability lies within one interval before it) plus one request latency. Stages ready inside the same interval collapse to the same timestamp.`;

  const gasTable =
    block.claimGas.length === 0
      ? 'No claim gas samples (no completed claim carried a receipt with gas fields).'
      : mdTable(
          [
            'toNetworkId',
            'claimKind',
            'n',
            'gasUsed min / median / max',
            'median effectiveGasPrice (wei)',
            'l1Fee min / median / max (wei)',
            'total fee min / median / max (wei)'
          ],
          block.claimGas.map((row) => [
            String(row.toNetworkId),
            row.claimKind,
            String(row.n),
            fmtWei(row.gasUsed),
            row.effectiveGasPrice.median,
            fmtWei(row.l1Fee),
            fmtWei(row.totalFeeWei)
          ])
        );

  const latencyTable =
    block.stageLatency.length === 0
      ? 'No completed hops.'
      : mdTable(
          ['route', 'completed hops', 'delta', 'n / min / median / max (ms)'],
          block.stageLatency.flatMap((row) =>
            STAGE_DELTAS.map((name) => [
              row.route,
              String(row.hops),
              DELTA_LABELS[name],
              fmtMmm(row.deltas[name])
            ])
          )
        );

  // S53 M8: only when the run measured approve gas, so older output is unchanged.
  const approveGasTable =
    block.approveGas === undefined || block.approveGas.length === 0
      ? []
      : [
          '',
          '**Approve gas**',
          '',
          mdTable(
            [
              'fromNetworkId',
              'n',
              'gasUsed min / median / max',
              'total fee min / median / max (wei)'
            ],
            block.approveGas.map((row) => [
              String(row.networkId),
              String(row.n),
              fmtWei(row.gasUsed),
              fmtWei(row.totalFeeWei)
            ])
          )
        ];

  return [
    `Only completed hops are counted in the tables; ${block.excludedHops} hop(s) with a failed, timed-out or aborted outcome are excluded. Median is the true median (mean of the two middle values for even n). T0 is the client-observed bridge receipt (viem polls every 4 s by default, so up to 4 s late).`,
    '',
    '**Claim gas**',
    '',
    gasTable,
    '',
    '**Stage latency**',
    '',
    resolution,
    '',
    latencyTable,
    ...approveGasTable
  ].join('\n');
};

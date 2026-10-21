// Downsampling rules for the HTML report (S54, heavy-load design §4.4).
//
// A time series is cut to a fixed number of time buckets that each keep the
// minimum, maximum and mean, so a one-sample spike (an event-loop stall, a 5xx
// burst) survives. Per-hop point sets are thinned deterministically, always
// keeping the points the reader cares about (failed hops).
export const MAX_SERIES_POINTS = 720;
export const MAX_HOP_POINTS = 5000;

export interface Point {
  t: number;
  v: number;
}

export interface Bucket {
  t: number;
  min: number;
  max: number;
  mean: number;
  /** Number of source points in the bucket. */
  n: number;
}

/**
 * Cuts `points` (any order) into at most `maxPoints` equal time buckets between
 * the first and last timestamp. Fewer points than buckets come back one to one.
 */
export const bucketSeries = (
  points: readonly Point[],
  maxPoints: number = MAX_SERIES_POINTS
): Bucket[] => {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (sorted.length <= maxPoints) {
    return sorted.map((p) => ({ t: p.t, min: p.v, max: p.v, mean: p.v, n: 1 }));
  }
  const t0 = sorted[0].t;
  const t1 = sorted[sorted.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const buckets = new Map<
    number,
    { sumT: number; min: number; max: number; sum: number; n: number }
  >();
  for (const p of sorted) {
    const idx = Math.min(maxPoints - 1, Math.floor(((p.t - t0) / span) * maxPoints));
    const b = buckets.get(idx);
    if (b === undefined) buckets.set(idx, { sumT: p.t, min: p.v, max: p.v, sum: p.v, n: 1 });
    else {
      b.sumT += p.t;
      b.min = Math.min(b.min, p.v);
      b.max = Math.max(b.max, p.v);
      b.sum += p.v;
      b.n += 1;
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({ t: b.sumT / b.n, min: b.min, max: b.max, mean: b.sum / b.n, n: b.n }));
};

/**
 * Adds `value` counts per time bucket (for stacked columns). Returns bucket start
 * times and one count array per series key, at most `maxBuckets` long.
 */
export const bucketCounts = (
  events: readonly { t: number; key: string; count: number }[],
  t0: number,
  t1: number,
  maxBuckets: number
): { starts: number[]; widthMs: number; byKey: Record<string, number[]> } => {
  const span = Math.max(1, t1 - t0);
  const widthMs = Math.max(60_000, Math.ceil(span / maxBuckets / 60_000) * 60_000);
  const count = Math.max(1, Math.ceil(span / widthMs));
  const byKey: Record<string, number[]> = {};
  for (const e of events) {
    const idx = Math.min(count - 1, Math.max(0, Math.floor((e.t - t0) / widthMs)));
    byKey[e.key] ??= new Array<number>(count).fill(0);
    byKey[e.key][idx] += e.count;
  }
  return { starts: Array.from({ length: count }, (_, i) => t0 + i * widthMs), widthMs, byKey };
};

export interface Sampled<T> {
  items: T[];
  /** `true` when items were dropped. */
  sampled: boolean;
  /** Keep every `step`-th of the rest. */
  step: number;
  total: number;
}

/** Keeps every item for which `keep` is true, and every k-th of the rest so the total stays near `max`. Deterministic. */
export const thin = <T>(
  items: readonly T[],
  max: number,
  keep: (item: T) => boolean = () => false
): Sampled<T> => {
  if (items.length <= max)
    return { items: [...items], sampled: false, step: 1, total: items.length };
  const kept = items.filter(keep).length;
  const budget = Math.max(1, max - kept);
  const rest = items.length - kept;
  const step = Math.max(1, Math.ceil(rest / budget));
  let seen = 0;
  const out: T[] = [];
  for (const item of items) {
    if (keep(item)) out.push(item);
    else {
      if (seen % step === 0) out.push(item);
      seen += 1;
    }
  }
  return { items: out, sampled: true, step, total: items.length };
};

import { describe, expect, it } from 'vitest';

import { bucketCounts, bucketSeries, thin } from './downsample';

describe('bucketSeries', () => {
  it('returns short series one to one, sorted', () => {
    const out = bucketSeries(
      [
        { t: 2, v: 5 },
        { t: 1, v: 3 }
      ],
      10
    );
    expect(out.map((b) => [b.t, b.mean])).toStrictEqual([
      [1, 3],
      [2, 5]
    ]);
  });

  it('cuts a long series to at most maxPoints buckets and keeps a one-sample spike', () => {
    const points = Array.from({ length: 10_000 }, (_, i) => ({
      t: i * 1000,
      v: i === 7_777 ? 999 : 10
    }));
    const out = bucketSeries(points, 720);
    expect(out.length).toBeLessThanOrEqual(720);
    expect(Math.max(...out.map((b) => b.max))).toBe(999);
    expect(Math.min(...out.map((b) => b.min))).toBe(10);
    expect(out.reduce((s, b) => s + b.n, 0)).toBe(10_000);
  });

  it('handles an empty series', () => {
    expect(bucketSeries([])).toStrictEqual([]);
  });
});

describe('bucketCounts', () => {
  it('sums counts per key into equal time buckets', () => {
    const out = bucketCounts(
      [
        { t: 0, key: 'a', count: 2 },
        { t: 30_000, key: 'a', count: 1 },
        { t: 120_000, key: 'b', count: 5 }
      ],
      0,
      180_000,
      10
    );
    expect(out.widthMs).toBe(60_000);
    expect(out.byKey.a).toStrictEqual([3, 0, 0]);
    expect(out.byKey.b).toStrictEqual([0, 0, 5]);
  });

  it('widens the bucket so a long run stays under the bucket cap', () => {
    const out = bucketCounts([{ t: 0, key: 'a', count: 1 }], 0, 5 * 3_600_000, 240);
    expect(out.starts.length).toBeLessThanOrEqual(240);
  });
});

describe('thin', () => {
  it('keeps everything under the cap', () => {
    const out = thin([1, 2, 3], 10);
    expect(out.sampled).toBe(false);
    expect(out.items).toStrictEqual([1, 2, 3]);
  });

  it('is deterministic, near the cap and always keeps the flagged items', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const keep = (n: number): boolean => n % 97 === 0;
    const a = thin(items, 100, keep);
    const b = thin(items, 100, keep);
    expect(a.items).toStrictEqual(b.items);
    expect(a.sampled).toBe(true);
    expect(a.items.length).toBeLessThanOrEqual(110);
    for (const n of items.filter(keep)) expect(a.items).toContain(n);
  });
});

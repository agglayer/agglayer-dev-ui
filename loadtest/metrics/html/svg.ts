// Hand-built inline SVG for the HTML report (S54, heavy-load design §4.1, dataviz
// mark specs): string builders, no dependency, no script. Colours come from CSS
// classes (`f1..f8` fill, `k1..k8` stroke, `fcrit`/`kcrit` status red) defined in
// `styles.ts`, so a chart follows the light/dark/print theme. Every dynamic string
// goes through `esc()`. Native hover text is a `<title>` child.
import type { Bucket } from './downsample';

import { esc } from './escape';

type Attrs = Record<string, string | number | undefined | null>;

const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

const attrString = (attrs: Attrs): string =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? num(v) : v, Number.MAX_SAFE_INTEGER)}"`)
    .join('');

const el = (name: string, attrs: Attrs, inner = ''): string =>
  inner === '' && ['rect', 'line', 'circle', 'path', 'polygon'].includes(name)
    ? `<${name}${attrString(attrs)}/>`
    : `<${name}${attrString(attrs)}>${inner}</${name}>`;

const title = (text: string): string => `<title>${esc(text, 400)}</title>`;

export const fillClass = (index: number): string => `f${(index % 8) + 1}`;
export const strokeClass = (index: number): string => `k${(index % 8) + 1}`;

// ---------------------------------------------------------------------------
// Scales and ticks
// ---------------------------------------------------------------------------

/** Round tick values covering [lo, hi]. */
export const niceTicks = (lo: number, hi: number, target = 5): number[] => {
  if (!(hi > lo)) return [lo];
  const rough = (hi - lo) / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
};

const TIME_STEPS_MS = [
  60_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000
];

export const timeTicks = (spanMs: number, target = 6): number[] => {
  const step =
    TIME_STEPS_MS.find((s) => spanMs / s <= target) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t <= spanMs + 1; t += step) ticks.push(t);
  return ticks;
};

export const fmtElapsed = (ms: number): string => {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
};

export const fmtCompact = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${trimZero(v / 1e6)}M`;
  if (abs >= 1e3) return `${trimZero(v / 1e3)}K`;
  return trimZero(v);
};
const trimZero = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');

const NICE_DURATIONS_MS = [
  1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000
];

export const fmtDurationShort = (ms: number): string => {
  if (ms === 0) return '0';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${trimZero(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`;
};

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

interface Frame {
  w: number;
  h: number;
  l: number;
  r: number;
  t: number;
  b: number;
}

const svgOpen = (f: Frame, label: string, extraClass = ''): string =>
  `<svg class="chart${extraClass === '' ? '' : ` ${extraClass}`}" viewBox="0 0 ${f.w} ${f.h}" role="img" aria-label="${esc(label, 300)}" preserveAspectRatio="xMidYMid meet">`;

const wrap = (svg: string): string => `<div class="chart-wrap">${svg}</div>`;

// ---------------------------------------------------------------------------
// Line chart over time (resources, balances, in-flight, p90 windows)
// ---------------------------------------------------------------------------

export interface LineSeries {
  name: string;
  /** Colour slot 0..7, or `crit` for the status red. */
  slot: number | 'crit';
  buckets: Bucket[];
  /** Draw the min..max band behind the mean line. */
  band?: boolean;
  /** Plot `max` instead of `mean` (peaks matter: event-loop lag). */
  usePeak?: boolean;
}

export interface Threshold {
  value: number;
  label: string;
}

export interface LineChartOptions {
  aria: string;
  series: LineSeries[];
  /** Elapsed-ms domain. */
  xMax: number;
  yFmt?: (v: number) => string;
  /** Hover text value format. */
  valueFmt?: (v: number) => string;
  thresholds?: Threshold[];
  yMin?: number;
  /** Vertical marker lines (elapsed ms), e.g. planned stop. */
  vlines?: { at: number; label: string }[];
  /** Tick marks along the x axis (elapsed ms), e.g. L1 leaves; pump deposits as diamonds. */
  ticksTop?: { at: number; kind: 'leaf' | 'pump' }[];
  h?: number;
  /** Smallest y span (default 1); small for ETH-scale values. */
  minSpan?: number;
}

export const lineChart = (o: LineChartOptions): string => {
  const f: Frame = { w: 960, h: o.h ?? 210, l: 58, r: 20, t: 22, b: 30 };
  const yFmt = o.yFmt ?? fmtCompact;
  const vFmt = o.valueFmt ?? yFmt;
  const plotted = o.series.map((s) => s.buckets.map((b) => (s.usePeak === true ? b.max : b.mean)));
  const dataMax = Math.max(0, ...o.series.flatMap((s) => s.buckets.map((b) => b.max)));
  const span = o.minSpan ?? 1;
  const thresholds = (o.thresholds ?? []).filter((th) => th.value <= Math.max(span, dataMax) * 3);
  const offScale = (o.thresholds ?? []).filter((th) => th.value > Math.max(span, dataMax) * 3);
  const yMin = o.yMin ?? 0;
  const yMaxRaw = Math.max(yMin + span, dataMax, ...thresholds.map((th) => th.value));
  const ticks = niceTicks(yMin, yMaxRaw * 1.05, 4);
  const yMax = Math.max(ticks[ticks.length - 1], yMaxRaw);
  const xMax = Math.max(1, o.xMax);
  const px = (t: number): number =>
    f.l + (Math.min(Math.max(t, 0), xMax) / xMax) * (f.w - f.l - f.r);
  const py = (v: number): number => f.h - f.b - ((v - yMin) / (yMax - yMin)) * (f.h - f.t - f.b);

  const parts: string[] = [svgOpen(f, o.aria)];
  // grid + y ticks
  for (const tv of ticks) {
    parts.push(el('line', { class: 'grid', x1: f.l, x2: f.w - f.r, y1: py(tv), y2: py(tv) }));
    parts.push(
      el('text', { class: 'ax', x: f.l - 6, y: py(tv) + 4, 'text-anchor': 'end' }, esc(yFmt(tv)))
    );
  }
  // x ticks
  for (const tv of timeTicks(xMax)) {
    parts.push(
      el('line', { class: 'tick', x1: px(tv), x2: px(tv), y1: f.h - f.b, y2: f.h - f.b + 4 })
    );
    parts.push(
      el(
        'text',
        { class: 'ax', x: px(tv), y: f.h - f.b + 17, 'text-anchor': 'middle' },
        esc(fmtElapsed(tv))
      )
    );
  }
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.w - f.r, y1: f.h - f.b, y2: f.h - f.b }));

  for (const v of o.vlines ?? []) {
    parts.push(
      el(
        'line',
        { class: 'vline', x1: px(v.at), x2: px(v.at), y1: f.t, y2: f.h - f.b },
        title(v.label)
      )
    );
  }
  for (const th of thresholds) {
    parts.push(
      el(
        'line',
        { class: 'thresh', x1: f.l, x2: f.w - f.r, y1: py(th.value), y2: py(th.value) },
        title(th.label)
      )
    );
    parts.push(
      el(
        'text',
        { class: 'ax thr', x: f.w - f.r - 2, y: py(th.value) - 4, 'text-anchor': 'end' },
        esc(th.label)
      )
    );
  }

  o.series.forEach((s, si) => {
    const cls = s.slot === 'crit' ? 'crit' : String((s.slot as number) + 1);
    const pts = s.buckets.map((b, i) => ({ x: px(b.t), y: py(plotted[si][i]), b }));
    if (s.band === true && pts.length > 1) {
      const top = s.buckets.map((b) => `${num(px(b.t))},${num(py(b.max))}`);
      const bottom = [...s.buckets].reverse().map((b) => `${num(px(b.t))},${num(py(b.min))}`);
      parts.push(el('polygon', { class: `band f${cls}`, points: [...top, ...bottom].join(' ') }));
    }
    if (pts.length > 1) {
      parts.push(
        el('path', {
          class: `line k${cls}`,
          d: `M${pts.map((p) => `${num(p.x)},${num(p.y)}`).join(' L')}`
        })
      );
    }
    const last = pts[pts.length - 1];
    if (last !== undefined) {
      parts.push(el('circle', { class: `dot f${cls}`, cx: last.x, cy: last.y, r: 4 }));
    }
  });

  // top ticks (leaves / pump deposits)
  for (const tk of o.ticksTop ?? []) {
    if (tk.kind === 'leaf')
      parts.push(
        el('line', { class: 'leaf-tick', x1: px(tk.at), x2: px(tk.at), y1: f.t - 14, y2: f.t - 6 })
      );
    else
      parts.push(
        el('polygon', {
          class: 'pump-mark',
          points: `${num(px(tk.at))},${f.t - 16} ${num(px(tk.at) + 4)},${f.t - 10} ${num(px(tk.at))},${f.t - 4} ${num(px(tk.at) - 4)},${f.t - 10}`
        })
      );
  }

  // hover hit-areas (<= 120 evenly spaced columns, each titled with every series value)
  const refSeries = o.series.reduce(
    (a, s) => (s.buckets.length > a.buckets.length ? s : a),
    o.series[0]
  );
  if (refSeries !== undefined && refSeries.buckets.length > 0) {
    const stride = Math.max(1, Math.ceil(refSeries.buckets.length / 120));
    refSeries.buckets.forEach((b, i) => {
      if (i % stride !== 0) return;
      const lines = o.series.map((s) => {
        const near = s.buckets.reduce(
          (best, c) => (Math.abs(c.t - b.t) < Math.abs(best.t - b.t) ? c : best),
          s.buckets[0]
        );
        return `${s.name}: ${vFmt(near.mean)} (min ${vFmt(near.min)}, max ${vFmt(near.max)})`;
      });
      const w = Math.max(4, ((f.w - f.l - f.r) / refSeries.buckets.length) * stride);
      parts.push(
        el(
          'rect',
          { class: 'hit', x: px(b.t) - w / 2, y: f.t, width: w, height: f.h - f.t - f.b },
          title(`+${fmtElapsed(b.t)}\n${lines.join('\n')}`)
        )
      );
    });
  }
  if (offScale.length > 0) {
    parts.push(
      el(
        'text',
        { class: 'ax', x: f.l + 4, y: f.t - 6 },
        esc(`${offScale.map((t) => t.label).join('; ')} (above the plotted range)`)
      )
    );
  }
  parts.push('</svg>');
  return wrap(parts.join(''));
};

// ---------------------------------------------------------------------------
// Horizontal stacked bars (outcomes per route, stage medians per route)
// ---------------------------------------------------------------------------

export interface BarSegment {
  name: string;
  slot: number | 'crit' | 'muted';
  value: number;
}

export interface BarRow {
  label: string;
  segments: BarSegment[];
}

export const hbarStack = (o: {
  aria: string;
  rows: BarRow[];
  valueFmt: (v: number) => string;
  /** Values are milliseconds: ticks fall on round durations. */
  timeAxis?: boolean;
  /** Show totals at the bar end. */
  showTotal?: boolean;
  /** Counts: ticks fall on whole numbers only. */
  integer?: boolean;
}): string => {
  const rowH = 30;
  const f: Frame = { w: 960, h: 22 + o.rows.length * rowH + 28, l: 190, r: 90, t: 14, b: 28 };
  const total = (row: BarRow): number => row.segments.reduce((s, x) => s + x.value, 0);
  const max = Math.max(1, ...o.rows.map(total));
  let ticks: number[];
  if (o.timeAxis === true) {
    const step =
      NICE_DURATIONS_MS.find((d) => max / d <= 5) ??
      NICE_DURATIONS_MS[NICE_DURATIONS_MS.length - 1];
    ticks = [];
    for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v);
  } else {
    ticks = niceTicks(0, max, 5);
    if (o.integer === true) {
      ticks = ticks.filter((v) => Number.isInteger(v));
      if (ticks.length < 2) ticks = Array.from({ length: Math.ceil(max) + 1 }, (_, i) => i);
    }
  }
  const xMax = Math.max(max, ticks[ticks.length - 1]);
  const px = (v: number): number => f.l + (v / xMax) * (f.w - f.l - f.r);
  const parts: string[] = [svgOpen(f, o.aria)];
  for (const tv of ticks) {
    parts.push(el('line', { class: 'grid', x1: px(tv), x2: px(tv), y1: f.t, y2: f.h - f.b }));
    parts.push(
      el(
        'text',
        { class: 'ax', x: px(tv), y: f.h - f.b + 17, 'text-anchor': 'middle' },
        esc(o.valueFmt(tv))
      )
    );
  }
  o.rows.forEach((row, ri) => {
    const y = f.t + 8 + ri * rowH;
    parts.push(
      el('text', { class: 'lbl', x: f.l - 10, y: y + 15, 'text-anchor': 'end' }, esc(row.label, 60))
    );
    let x = f.l;
    for (const seg of row.segments) {
      if (seg.value <= 0) continue;
      const w = Math.max(1, px(seg.value) - f.l - 2);
      const cls =
        seg.slot === 'crit' ? 'fcrit' : seg.slot === 'muted' ? 'fmuted' : fillClass(seg.slot);
      parts.push(
        el(
          'rect',
          { class: cls, x, y, width: w, height: 20, rx: 3 },
          title(`${row.label}: ${seg.name} ${o.valueFmt(seg.value)}`)
        )
      );
      x += w + 2;
    }
    if (o.showTotal !== false) {
      parts.push(el('text', { class: 'val', x: x + 6, y: y + 15 }, esc(o.valueFmt(total(row)))));
    }
  });
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.l, y1: f.t, y2: f.h - f.b }));
  parts.push('</svg>');
  return wrap(parts.join(''));
};

export const legend = (items: { name: string; slot: number | 'crit' | 'muted' }[]): string =>
  `<ul class="legend">${items
    .map((i) => {
      const cls = i.slot === 'crit' ? 'fcrit' : i.slot === 'muted' ? 'fmuted' : fillClass(i.slot);
      return `<li><svg class="sw" viewBox="0 0 12 12" aria-hidden="true">${el('rect', { class: cls, x: 0, y: 0, width: 12, height: 12, rx: 2 })}</svg>${esc(i.name, 80)}</li>`;
    })
    .join('')}</ul>`;

// ---------------------------------------------------------------------------
// Stacked columns over time (errors per minute)
// ---------------------------------------------------------------------------

export const stackedColumns = (o: {
  aria: string;
  starts: number[];
  widthMs: number;
  stacks: { name: string; slot: number | 'crit' | 'muted'; values: number[] }[];
  xMax: number;
  h?: number;
}): string => {
  const f: Frame = { w: 960, h: o.h ?? 190, l: 52, r: 20, t: 14, b: 30 };
  const totals = o.starts.map((_, i) => o.stacks.reduce((s, st) => s + st.values[i], 0));
  const ticks = niceTicks(0, Math.max(1, ...totals) * 1.05, 4);
  const yMax = Math.max(1, ticks[ticks.length - 1]);
  const xMax = Math.max(1, o.xMax);
  const px = (t: number): number =>
    f.l + (Math.min(Math.max(t, 0), xMax) / xMax) * (f.w - f.l - f.r);
  const py = (v: number): number => f.h - f.b - (v / yMax) * (f.h - f.t - f.b);
  const colW = Math.max(2, px(o.widthMs) - px(0) - 1);
  const parts: string[] = [svgOpen(f, o.aria)];
  for (const tv of ticks) {
    parts.push(el('line', { class: 'grid', x1: f.l, x2: f.w - f.r, y1: py(tv), y2: py(tv) }));
    parts.push(
      el(
        'text',
        { class: 'ax', x: f.l - 6, y: py(tv) + 4, 'text-anchor': 'end' },
        esc(fmtCompact(tv))
      )
    );
  }
  for (const tv of timeTicks(xMax)) {
    parts.push(
      el(
        'text',
        { class: 'ax', x: px(tv), y: f.h - f.b + 17, 'text-anchor': 'middle' },
        esc(fmtElapsed(tv))
      )
    );
  }
  o.starts.forEach((start, i) => {
    let acc = 0;
    const lines: string[] = [];
    for (const st of o.stacks) {
      const v = st.values[i];
      if (v <= 0) continue;
      const y1 = py(acc + v);
      const y0 = py(acc);
      const cls =
        st.slot === 'crit' ? 'fcrit' : st.slot === 'muted' ? 'fmuted' : fillClass(st.slot);
      parts.push(
        el('rect', {
          class: cls,
          x: px(start),
          y: y1,
          width: colW,
          height: Math.max(1, y0 - y1 - 1),
          rx: 1
        })
      );
      lines.push(`${st.name}: ${v}`);
      acc += v;
    }
    if (acc > 0) {
      parts.push(
        el(
          'rect',
          { class: 'hit', x: px(start), y: f.t, width: colW, height: f.h - f.t - f.b },
          title(`+${fmtElapsed(start - 0)} (${fmtElapsed(o.widthMs)} bucket)\n${lines.join('\n')}`)
        )
      );
    }
  });
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.w - f.r, y1: f.h - f.b, y2: f.h - f.b }));
  parts.push('</svg>');
  return wrap(parts.join(''));
};

// ---------------------------------------------------------------------------
// Strip plot with min / median / p90 / max per row (latency, claim gas)
// ---------------------------------------------------------------------------

export interface StripRow {
  label: string;
  slot: number;
  points: number[];
  /** Points that belong to failed hops (drawn in status red), already counted in `points`' domain. */
  failedPoints?: number[];
  stats: { min: number; median: number; p90: number; max: number } | null;
}

export interface StripOptions {
  aria: string;
  rows: StripRow[];
  valueFmt: (v: number) => string;
  log?: boolean;
  refLines?: { value: number; label: string }[];
  /** `false` drops the individual points (size tier 1). */
  withPoints?: boolean;
  xLabel?: string;
  /** Values are milliseconds: ticks fall on round durations (30 s, 5 min, 1 h) instead of round numbers. */
  timeAxis?: boolean;
}

const hash01 = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export const stripPlot = (o: StripOptions): string => {
  const rowH = 48;
  // Reference-line labels get their own band above the rows so they never sit on a marker.
  const refBand = (o.refLines ?? []).length * 14;
  const f: Frame = {
    w: 960,
    h: 16 + refBand + o.rows.length * rowH + (o.xLabel === undefined ? 34 : 54),
    l: 190,
    r: 30,
    t: 14 + refBand,
    b: o.xLabel === undefined ? 30 : 50
  };
  const all = o.rows.flatMap((r) => [
    ...r.points,
    ...(r.stats === null ? [] : [r.stats.min, r.stats.max])
  ]);
  const refs = (o.refLines ?? []).map((r) => r.value);
  const positive = [...all, ...refs].filter((v) => v > 0);
  const lo = positive.length === 0 ? 1 : Math.min(...positive);
  const hi = positive.length === 0 ? 10 : Math.max(...positive);
  let tickValues: number[];
  let sx: (v: number) => number;
  const plotW = f.w - f.l - f.r;
  if (o.log === true) {
    let lMin = lo * 0.9;
    let lMax = hi * 1.1;
    let decadeTicks: number[] = [];
    if (o.timeAxis === true) {
      decadeTicks = NICE_DURATIONS_MS.filter((d) => d >= lMin && d <= lMax);
      if (decadeTicks.length >= 2) {
        lMin = Math.min(lMin, decadeTicks[0]);
        lMax = Math.max(lMax, decadeTicks[decadeTicks.length - 1]);
      }
    }
    if (decadeTicks.length < 2) {
      const lmin = Math.floor(Math.log10(lMin));
      const lmax = Math.ceil(Math.log10(lMax));
      decadeTicks = [];
      for (let e = lmin; e <= lmax; e += 1) decadeTicks.push(10 ** e);
      lMin = 10 ** lmin;
      lMax = 10 ** lmax;
    }
    tickValues = decadeTicks;
    const a = Math.log10(lMin);
    const b = Math.log10(Math.max(lMax, lMin * 1.0001));
    sx = (v) => f.l + ((Math.log10(Math.max(v, lMin)) - a) / Math.max(1e-9, b - a)) * plotW;
  } else {
    const dLo = Math.min(lo, ...(refs.length > 0 ? refs : [lo]));
    const base =
      o.refLines !== undefined && o.refLines.length > 0 ? Math.max(0, dLo - (hi - dLo) * 0.25) : 0;
    let ticks: number[];
    if (o.timeAxis === true) {
      const step =
        NICE_DURATIONS_MS.find((d) => (hi * 1.04 - base) / d <= 6) ??
        NICE_DURATIONS_MS[NICE_DURATIONS_MS.length - 1];
      ticks = [];
      for (let v = Math.ceil(base / step) * step; v <= hi * 1.04 + step * 0.5; v += step)
        ticks.push(v);
    } else {
      ticks = niceTicks(base, hi * 1.04, 6);
    }
    tickValues = ticks;
    const dMin = Math.min(base, ticks[0]);
    const dMax = Math.max(ticks[ticks.length - 1], hi);
    sx = (v) => f.l + ((v - dMin) / Math.max(1e-9, dMax - dMin)) * plotW;
  }
  const parts: string[] = [svgOpen(f, o.aria)];
  for (const tv of tickValues) {
    parts.push(el('line', { class: 'grid', x1: sx(tv), x2: sx(tv), y1: f.t, y2: f.h - f.b }));
    parts.push(
      el(
        'text',
        { class: 'ax', x: sx(tv), y: f.h - f.b + 17, 'text-anchor': 'middle' },
        esc(o.valueFmt(tv))
      )
    );
  }
  (o.refLines ?? []).forEach((ref, i) => {
    parts.push(
      el(
        'line',
        { class: 'vline', x1: sx(ref.value), x2: sx(ref.value), y1: f.t, y2: f.h - f.b },
        title(`${ref.label}: ${o.valueFmt(ref.value)}`)
      )
    );
    const rightSide = sx(ref.value) > f.l + plotW * 0.55;
    parts.push(
      el(
        'text',
        {
          class: 'ax thr',
          x: sx(ref.value) + (rightSide ? -5 : 5),
          y: f.t - refBand + 11 + i * 14,
          'text-anchor': rightSide ? 'end' : 'start'
        },
        esc(ref.label)
      )
    );
  });
  o.rows.forEach((row, ri) => {
    const cy = f.t + 12 + ri * rowH + 14;
    parts.push(
      el('text', { class: 'lbl', x: f.l - 10, y: cy + 4, 'text-anchor': 'end' }, esc(row.label, 60))
    );
    if (o.withPoints !== false) {
      row.points.forEach((v, i) => {
        parts.push(
          el(
            'circle',
            {
              class: `pt ${fillClass(row.slot)}`,
              cx: sx(v),
              cy: cy + (hash01(i) - 0.5) * 20,
              r: 3.2
            },
            title(o.valueFmt(v))
          )
        );
      });
      (row.failedPoints ?? []).forEach((v, i) => {
        parts.push(
          el(
            'circle',
            { class: 'pt fcrit', cx: sx(v), cy: cy + (hash01(i + 7919) - 0.5) * 20, r: 3.6 },
            title(`failed hop: ${o.valueFmt(v)}`)
          )
        );
      });
    }
    if (row.stats !== null) {
      const s = row.stats;
      parts.push(
        el(
          'line',
          { class: 'range', x1: sx(s.min), x2: sx(s.max), y1: cy, y2: cy },
          title(`min ${o.valueFmt(s.min)} to max ${o.valueFmt(s.max)}`)
        )
      );
      parts.push(
        el(
          'line',
          { class: 'cap', x1: sx(s.min), x2: sx(s.min), y1: cy - 7, y2: cy + 7 },
          title(`min ${o.valueFmt(s.min)}`)
        )
      );
      parts.push(
        el(
          'line',
          { class: 'cap', x1: sx(s.max), x2: sx(s.max), y1: cy - 7, y2: cy + 7 },
          title(`max ${o.valueFmt(s.max)}`)
        )
      );
      parts.push(
        el(
          'polygon',
          {
            class: 'p90',
            points: `${num(sx(s.p90))},${cy - 9} ${num(sx(s.p90) + 6)},${cy} ${num(sx(s.p90))},${cy + 9} ${num(sx(s.p90) - 6)},${cy}`
          },
          title(`p90 ${o.valueFmt(s.p90)}`)
        )
      );
      parts.push(
        el(
          'line',
          { class: 'median', x1: sx(s.median), x2: sx(s.median), y1: cy - 12, y2: cy + 12 },
          title(`median ${o.valueFmt(s.median)}`)
        )
      );
      parts.push(
        el(
          'text',
          { class: 'val', x: sx(s.median), y: cy - 15, 'text-anchor': 'middle' },
          esc(o.valueFmt(s.median))
        )
      );
    }
  });
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.w - f.r, y1: f.h - f.b, y2: f.h - f.b }));
  if (o.xLabel !== undefined)
    parts.push(
      el('text', { class: 'ax', x: f.w - f.r, y: f.h - 8, 'text-anchor': 'end' }, esc(o.xLabel))
    );
  parts.push('</svg>');
  return wrap(parts.join(''));
};

// ---------------------------------------------------------------------------
// Lap / hop timeline
// ---------------------------------------------------------------------------

export interface TimelineSegment {
  from: number;
  to: number;
  /** Colour slot 0..4 for the five stages, or `crit` for the failed tail. */
  slot: number | 'crit';
  /** The hop is still running at the end of the data (drawn lighter). */
  open?: boolean;
}

export interface TimelineRow {
  label: string;
  tip: string;
  segments: TimelineSegment[];
  failed: boolean;
}

export const timelineChart = (o: {
  aria: string;
  rows: TimelineRow[];
  xMax: number;
  vlines?: { at: number; label: string }[];
  leaves?: number[];
  pumps?: number[];
}): string => {
  const rowH = o.rows.length > 150 ? 5 : o.rows.length > 60 ? 8 : 12;
  const f: Frame = { w: 960, h: 40 + o.rows.length * rowH + 34, l: 56, r: 20, t: 34, b: 30 };
  const xMax = Math.max(1, o.xMax);
  const px = (t: number): number =>
    f.l + (Math.min(Math.max(t, 0), xMax) / xMax) * (f.w - f.l - f.r);
  const parts: string[] = [svgOpen(f, o.aria, 'tall')];
  const plotBottom = f.h - f.b;
  for (const tv of timeTicks(xMax)) {
    parts.push(el('line', { class: 'grid', x1: px(tv), x2: px(tv), y1: f.t, y2: plotBottom }));
    parts.push(
      el(
        'text',
        { class: 'ax', x: px(tv), y: plotBottom + 17, 'text-anchor': 'middle' },
        esc(fmtElapsed(tv))
      )
    );
  }
  for (const v of o.vlines ?? []) {
    parts.push(
      el(
        'line',
        { class: 'vline', x1: px(v.at), x2: px(v.at), y1: f.t - 8, y2: plotBottom },
        title(v.label)
      )
    );
    parts.push(el('text', { class: 'ax thr', x: px(v.at) + 4, y: f.t - 12 }, esc(v.label)));
  }
  for (const at of o.leaves ?? []) {
    parts.push(
      el('line', { class: 'leaf-tick', x1: px(at), x2: px(at), y1: f.t - 6, y2: f.t - 1 })
    );
  }
  for (const at of o.pumps ?? []) {
    parts.push(
      el('polygon', {
        class: 'pump-mark',
        points: `${num(px(at))},${f.t - 8} ${num(px(at) + 4)},${f.t - 3} ${num(px(at))},${f.t + 2} ${num(px(at) - 4)},${f.t - 3}`
      })
    );
  }
  o.rows.forEach((row, ri) => {
    const y = f.t + 4 + ri * rowH;
    const segs = row.segments.map((s) => {
      const cls = s.slot === 'crit' ? 'fcrit' : fillClass(s.slot);
      return el('rect', {
        class: `${cls}${s.open === true ? ' open' : ''}`,
        x: px(s.from),
        y,
        width: Math.max(1, px(s.to) - px(s.from)),
        height: rowH - 1
      });
    });
    parts.push(`<g>${title(row.tip)}${segs.join('')}</g>`);
  });
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.w - f.r, y1: plotBottom, y2: plotBottom }));
  parts.push('</svg>');
  return wrap(parts.join(''));
};

// ---------------------------------------------------------------------------
// Charts for the campaign roll-up
// ---------------------------------------------------------------------------

/** One line per series over named categories (one point per stage). `null` leaves a gap. */
export const categoryLineChart = (o: {
  aria: string;
  categories: string[];
  series: { name: string; slot: number; dashed?: boolean; values: (number | null)[] }[];
  valueFmt: (v: number) => string;
  timeAxis?: boolean;
  xLabel?: string;
}): string => {
  const f: Frame = { w: 960, h: 250, l: 64, r: 24, t: 18, b: o.xLabel === undefined ? 40 : 58 };
  const all = o.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = Math.max(1, ...all);
  let ticks: number[];
  if (o.timeAxis === true) {
    const step =
      NICE_DURATIONS_MS.find((d) => max / d <= 5) ??
      NICE_DURATIONS_MS[NICE_DURATIONS_MS.length - 1];
    ticks = [];
    for (let v = 0; v <= max * 1.05 + step * 0.5; v += step) ticks.push(v);
  } else {
    ticks = niceTicks(0, max * 1.05, 4);
  }
  const yMax = Math.max(ticks[ticks.length - 1], max);
  const px = (i: number): number =>
    f.l +
    (o.categories.length <= 1
      ? (f.w - f.l - f.r) / 2
      : (i / (o.categories.length - 1)) * (f.w - f.l - f.r));
  const py = (v: number): number => f.h - f.b - (v / yMax) * (f.h - f.t - f.b);
  const parts: string[] = [svgOpen(f, o.aria)];
  for (const tv of ticks) {
    parts.push(el('line', { class: 'grid', x1: f.l, x2: f.w - f.r, y1: py(tv), y2: py(tv) }));
    parts.push(
      el(
        'text',
        { class: 'ax', x: f.l - 6, y: py(tv) + 4, 'text-anchor': 'end' },
        esc(o.valueFmt(tv))
      )
    );
  }
  o.categories.forEach((c, i) => {
    parts.push(
      el('text', { class: 'ax', x: px(i), y: f.h - f.b + 17, 'text-anchor': 'middle' }, esc(c, 40))
    );
  });
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.w - f.r, y1: f.h - f.b, y2: f.h - f.b }));
  for (const s of o.series) {
    const cls = String(s.slot + 1);
    const pts = s.values.map((v, i) => (v === null ? null : { x: px(i), y: py(v), v, i }));
    let d = '';
    pts.forEach((p) => {
      if (p === null) return;
      d += `${d === '' ? 'M' : ' L'}${num(p.x)},${num(p.y)}`;
    });
    if (d.includes('L'))
      parts.push(el('path', { class: `line k${cls}${s.dashed === true ? ' dashed' : ''}`, d }));
    for (const p of pts) {
      if (p === null) continue;
      parts.push(
        el(
          'circle',
          { class: `dot f${cls}`, cx: p.x, cy: p.y, r: 5 },
          title(`${s.name} at ${o.categories[p.i]}: ${o.valueFmt(p.v)}`)
        )
      );
    }
  }
  if (o.xLabel !== undefined)
    parts.push(
      el('text', { class: 'ax', x: f.w - f.r, y: f.h - 8, 'text-anchor': 'end' }, esc(o.xLabel))
    );
  parts.push('</svg>');
  return wrap(parts.join(''));
};

/** Empirical cumulative distribution curves (share of hops at or below a value). */
export const ecdfChart = (o: {
  aria: string;
  curves: { name: string; slot: number; values: number[] }[];
  valueFmt: (v: number) => string;
}): string => {
  const f: Frame = { w: 960, h: 260, l: 52, r: 24, t: 16, b: 44 };
  const all = o.curves.flatMap((c) => c.values);
  const max = Math.max(1, ...all);
  const step =
    NICE_DURATIONS_MS.find((d) => max / d <= 6) ?? NICE_DURATIONS_MS[NICE_DURATIONS_MS.length - 1];
  const xTicks: number[] = [];
  for (let v = 0; v <= max * 1.04 + step * 0.5; v += step) xTicks.push(v);
  const xMax = Math.max(xTicks[xTicks.length - 1], max);
  const px = (v: number): number => f.l + (v / xMax) * (f.w - f.l - f.r);
  const py = (share: number): number => f.h - f.b - share * (f.h - f.t - f.b);
  const parts: string[] = [svgOpen(f, o.aria)];
  for (const tv of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
    parts.push(el('line', { class: 'grid', x1: f.l, x2: f.w - f.r, y1: py(tv), y2: py(tv) }));
    parts.push(
      el(
        'text',
        { class: 'ax', x: f.l - 6, y: py(tv) + 4, 'text-anchor': 'end' },
        `${Math.round(tv * 100)}%`
      )
    );
  }
  for (const tv of xTicks)
    parts.push(
      el(
        'text',
        { class: 'ax', x: px(tv), y: f.h - f.b + 17, 'text-anchor': 'middle' },
        esc(o.valueFmt(tv))
      )
    );
  parts.push(el('line', { class: 'axis', x1: f.l, x2: f.w - f.r, y1: f.h - f.b, y2: f.h - f.b }));
  for (const c of o.curves) {
    if (c.values.length === 0) continue;
    const sorted = [...c.values].sort((a, b) => a - b);
    const cls = String(c.slot + 1);
    let d = `M${num(px(sorted[0]))},${num(py(0))}`;
    sorted.forEach((v, i) => {
      d += ` L${num(px(v))},${num(py(i / sorted.length))} L${num(px(v))},${num(py((i + 1) / sorted.length))}`;
    });
    parts.push(el('path', { class: `line k${cls}`, d }, title(`${c.name}: ${sorted.length} hops`)));
  }
  parts.push(
    el(
      'text',
      { class: 'ax', x: f.w - f.r, y: f.h - 8, 'text-anchor': 'end' },
      'ready wait (share of hops at or below)'
    )
  );
  parts.push('</svg>');
  return wrap(parts.join(''));
};

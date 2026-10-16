// `renderReportHtml(model)`: the single-file report (S54, heavy-load design §4).
//
// Everything is rendered here, on the generator side, into static HTML tables and
// inline SVG, so the page is complete with JavaScript off and when printed. Every
// section always renders its heading; missing data shows a one-line empty state
// that names the reason. All dynamic text goes through `esc()`.
import { formatEther } from 'viem';

import type { ReportModel } from './model';

import { REPORT_CLIENT_JS } from './client';
import { cspHash, esc, safeJsonForScript } from './escape';
import {
  REPEAT_CLAIM_GAS_NONZERO,
  REPEAT_CLAIM_GAS_ZERO,
  SEGMENT_NAMES,
  TIMELINE_STAGES,
  fmtMsShort
} from './model';
import { REPORT_CSS } from './styles';
import {
  fmtDurationShort,
  fmtCompact,
  hbarStack,
  legend,
  lineChart,
  stackedColumns,
  stripPlot,
  timelineChart
} from './svg';

export const SIZE_TIER_NOTES = [
  'Strip-plot points were dropped (statistics are unchanged).',
  'Individual timeline rows were dropped (only failed rows remain).',
  'The per-hop columns and timeline rows were removed from the embedded JSON.'
];

export interface RenderOptions {
  /** 0 = everything; 1 drops strip-plot points; 2 also drops timeline rows; 3 also trims the embedded JSON. */
  tier?: number;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const fmtInt = (n: number | string): string => {
  const s = String(n);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${group(int)}${frac === undefined ? '' : `.${frac}`}`;
};
export const fmtTs = (iso: string | null): string => {
  if (iso === null) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n/a' : `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`;
};
export const pct = (rate: number | null, digits = 1): string =>
  rate === null ? 'n/a' : `${(rate * 100).toFixed(digits)}%`;
export const ms = (v: number | null): string => (v === null ? 'n/a' : fmtMsShort(v));
const eth = (wei: string | null, digits = 6): string => {
  if (wei === null) return 'n/a';
  try {
    return Number(formatEther(BigInt(wei))).toFixed(digits);
  } catch {
    return 'n/a';
  }
};
const gwei = (wei: string): string => {
  try {
    return (Number(BigInt(wei)) / 1e9).toFixed(4);
  } catch {
    return 'n/a';
  }
};
const gweiAmount = (wei: string): string => {
  try {
    return fmtInt((Number(BigInt(wei)) / 1e9).toFixed(2));
  } catch {
    return 'n/a';
  }
};

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------

export interface CellOpts {
  num?: boolean;
  v?: number | string;
  cls?: string;
  title?: string;
  k?: string;
  wrap?: boolean;
}

export const td = (text: unknown, o: CellOpts = {}): string => {
  const cls = [o.num === true ? 'num' : '', o.cls ?? '', o.wrap === true ? 'wrapcell' : '']
    .filter(Boolean)
    .join(' ');
  return `<td${cls === '' ? '' : ` class="${esc(cls)}"`}${o.v !== undefined ? ` data-v="${esc(o.v)}"` : ''}${o.k !== undefined ? ` data-k="${esc(o.k)}"` : ''}${o.title !== undefined ? ` title="${esc(o.title)}"` : ''}>${esc(text)}</td>`;
};

export const table = (
  headers: { t: string; num?: boolean }[],
  rows: string[][],
  o: { sortable?: boolean; label: string; total?: string[]; compact?: boolean } = { label: '' }
): string =>
  `<div class="tablewrap" role="region" aria-label="${esc(o.label)}" tabindex="0"><table class="data${o.sortable === true ? ' sortable' : ''}${o.compact === true ? ' compact' : ''}"><thead><tr>${headers
    .map((h) => `<th scope="col"${h.num === true ? ' class="num"' : ''}>${esc(h.t)}</th>`)
    .join(
      ''
    )}</tr></thead><tbody>${rows.map((r) => `<tr>${r.join('')}</tr>`).join('')}${o.total === undefined ? '' : `<tr class="total">${o.total.join('')}</tr>`}</tbody></table></div>`;

export const empty = (message: string): string => `<p class="empty">${esc(message)}</p>`;
export const note = (message: string): string => `<p class="note">${esc(message)}</p>`;
export const section = (id: string, title: string, body: string): string =>
  `<section id="${esc(id)}" class="panel" aria-labelledby="${esc(id)}-h"><h2 id="${esc(id)}-h">${esc(title)}</h2>${body}</section>`;

const ICONS: Record<string, string> = {
  pass: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fail: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  none: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="4 3"/></svg>'
};

export const LEVEL_WORD: Record<ReportModel['verdict']['level'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  incomplete: 'INCOMPLETE',
  aborted: 'ABORTED',
  nolaps: 'NO LAPS'
};
export const LEVEL_ICON: Record<ReportModel['verdict']['level'], string> = {
  pass: ICONS.pass,
  fail: ICONS.fail,
  incomplete: ICONS.warn,
  aborted: ICONS.warn,
  nolaps: ICONS.none
};

const toggle = (lin: string, log: string): string =>
  `<div class="axis-toggle"><div class="lin-view">${lin}</div><div class="log-view">${log}</div></div>`;

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

const renderVerdict = (m: ReportModel, notes: string[]): string => {
  const v = m.verdict;
  const id = m.identity;
  const rates = `<div class="rates"><span>Lap failure rate <b>${esc(pct(v.lapFailureRate))}</b> (${v.lapsFailed} of ${v.lapsFinished} finished laps)</span><span>Hard hop-failure rate <b>${esc(pct(v.hardHopFailureRate))}</b> (${v.hardHopFailures} of ${v.hopsEnded} hops, SC1 outcome set)</span><span>Laps in flight at stop <b>${v.lapsInFlightAtStop}</b></span><span class="chip ${v.pumpOn ? 'good' : ''}">PUMP ${v.pumpOn ? 'ON' : 'OFF'}</span></div>`;
  const dl = (k: string, val: string): string =>
    `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`;
  const ringLabel = id.meta.ring === undefined ? '' : `${id.meta.ring} · `;
  const requested = `${id.requested.users} users (${id.requested.browser} browser) · ${id.requested.ratePerUserPerMin}/user/min · ${id.requested.minutes} min`;
  return `<section id="verdict" class="panel first" aria-labelledby="verdict-h"><h2 id="verdict-h" hidden>Verdict</h2><div class="banner"><div class="stamp ${v.level}" role="status">${LEVEL_ICON[v.level]}<span>${LEVEL_WORD[v.level]}</span></div><div class="banner-main"><h1 class="verdict-line">${esc(v.text)}</h1>${id.neverStarted ? `<p class="empty">Run never started (preflight or init failure): there is no lap data.</p>` : ''}${rates}<dl class="identity">${dl('Run', id.runName)}${dl('Ring', `${ringLabel}${id.ringPath}`)}${dl('Environment', id.env)}${dl('Started (UTC)', fmtTs(id.startedAt))}${dl('Ended (UTC)', fmtTs(id.endedAt))}${dl('Duration', id.durationMs === null ? 'n/a' : fmtDurationShort(id.durationMs))}${dl('Requested', requested)}${dl('Tool version', id.toolVersion ?? 'unknown')}${dl('Report generated (UTC)', fmtTs(m.generator.generatedAt))}</dl><p class="gonogo">Campaign go/no-go uses the stop criteria (section "Stop criteria" below), not this verdict: the verdict is FAIL on any single failed lap.</p></div></div>${notes.length > 0 ? `<div class="dropped" role="note"><b>Size cap applied.</b> ${notes.map((n) => esc(n)).join(' ')}</div>` : ''}</section>`;
};

const renderToc = (): string =>
  `<nav class="toc" aria-label="Sections">${[
    ['kpis', 'Key figures'],
    ['throughput', 'Throughput'],
    ['outcomes', 'Hop outcomes'],
    ['latency', 'Latency'],
    ['timeline', 'Timeline'],
    ['gas', 'Claim gas'],
    ['gates', 'Gate stalls'],
    ['errors', 'Errors'],
    ['endpoints', 'Endpoints'],
    ['resources', 'Resources'],
    ['pump', 'Pump'],
    ['stop', 'Stop criteria'],
    ['wallets', 'Wallets'],
    ['config', 'Configuration'],
    ['environment', 'Environment']
  ]
    .map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`)
    .join('')}</nav>`;

const renderKpis = (m: ReportModel): string =>
  section(
    'kpis',
    'Key figures',
    `<div class="kpis">${m.kpis
      .map(
        (k) =>
          `<div class="kpi ${k.tone === 'neutral' ? '' : k.tone}"${k.why !== undefined ? ` title="${esc(k.why)}"` : ''}><div class="label">${esc(k.label)}</div><div class="value${k.na ? ' na' : ''}" data-metric="${esc(k.metric)}">${esc(k.value)}</div><div class="sub">${esc(k.sub)}</div></div>`
      )
      .join('')}</div>`
  );

const renderThroughput = (m: ReportModel): string => {
  const t = m.throughput;
  if (t.lapsStarted === 0) {
    return section(
      'throughput',
      'Throughput',
      empty('No laps started: there is no achieved rate to compare.')
    );
  }
  const a = t.achieved;
  const rows: [string, string, string][] = [
    ['users (requested)', String(t.requested.users), '-'],
    ['browser users (requested)', String(t.requested.browser), '-'],
    ['rate per user/min (requested)', String(t.requested.ratePerUserPerMin), '-'],
    ['duration minutes (requested)', String(t.requested.minutes), '-'],
    ['ticksExpected', String(a.ticksExpected), 'users x rate x minutes, from the config alone'],
    ['ticksOffered', String(a.ticksOffered), 'lap-start opportunities, all users'],
    ['lapStartsSubmitted', String(a.lapStartsSubmitted), 'same unit as the requested rate'],
    ['skippedBackpressure', String(a.skippedBackpressure), '-'],
    ['ticksLostToRamp', String(a.ticksLostToRamp), '-'],
    [
      'hopBridgesSubmitted',
      String(a.hopBridgesSubmitted),
      'per-hop bridge sends, not part of the identity'
    ],
    [
      'steadyStateRatePerUserPerMin (achieved)',
      a.steadyStateRatePerUserPerMin.toFixed(4),
      'same unit as the requested rate'
    ]
  ];
  const byMode = a.steadyStateRatePerUserPerModeMin;
  const lapsRows = (['browser', 'headless'] as const).map((mode) => {
    const r = t.lapsByMode[mode];
    return [
      td(mode),
      td(mode === 'browser' ? t.requested.browser : t.requested.users - t.requested.browser, {
        num: true
      }),
      td(
        (mode === 'browser' ? byMode.browser : byMode.headless) === null
          ? 'n/a (0 users)'
          : (mode === 'browser' ? byMode.browser : byMode.headless)?.toFixed(4),
        { num: true }
      ),
      td(r.attempted, { num: true }),
      td(r.completed, { num: true }),
      td(r.completionRate === null ? 'n/a' : pct(r.completionRate), { num: true })
    ];
  });
  return section(
    'throughput',
    'Throughput',
    `${table(
      [{ t: 'Metric' }, { t: 'Value', num: true }, { t: 'Note' }],
      rows.map(([k, v, n]) => [
        td(k),
        td(v, { num: true, k: `throughput.${k}` }),
        td(n, { wrap: true, cls: 'muted' })
      ]),
      { label: 'Requested versus achieved load' }
    )}<p>Identity check (<code>ticksOffered = lapStartsSubmitted + skippedBackpressure + ticksLostToRamp</code>): <span class="chip ${t.identityOk ? 'good' : 'bad'}">${t.identityOk ? 'OK' : 'MISMATCH'}</span> · <code>ticksOffered - ticksExpected</code> = <b>${t.gap}</b></p><h3>Per mode</h3>${table([{ t: 'Mode' }, { t: 'Users', num: true }, { t: 'Rate /user/min', num: true }, { t: 'Laps attempted', num: true }, { t: 'Laps completed', num: true }, { t: 'Completion', num: true }], lapsRows, { label: 'Lap reliability per mode' })}`
  );
};

const OUTCOME_SLOT = (outcome: string, i: number): number | 'crit' => {
  if (outcome.startsWith('hop_completed')) return 5;
  if (outcome.includes('revert') || outcome === 'lbt_underflow') return 'crit';
  if (outcome.startsWith('timeout')) return 3;
  const cycle = [1, 6, 4, 7, 2];
  return cycle[i % cycle.length];
};

const renderOutcomes = (m: ReportModel): string => {
  const h = m.hopOutcomes;
  if (h.byRoute.length === 0 && Object.keys(h.byOutcome).length === 0) {
    return section('outcomes', 'Hop outcomes', empty('No hops recorded.'));
  }
  const order = h.outcomeOrder;
  const rows = h.byRoute.map((r) => ({
    label: m.routes.find((x) => x.key === r.route)?.label ?? r.route,
    segments: order.map((o, i) => ({
      name: o,
      slot: OUTCOME_SLOT(o, i),
      value: r.byOutcome[o] ?? 0
    }))
  }));
  const chart = hbarStack({
    aria: 'Hop outcomes per route, stacked by outcome',
    rows,
    integer: true,
    valueFmt: (v) => fmtInt(Math.round(v))
  });
  const lg = legend(order.map((o, i) => ({ name: o, slot: OUTCOME_SLOT(o, i) })));
  const tbl = table(
    [{ t: 'Route' }, ...order.map((o) => ({ t: o, num: true })), { t: 'Total', num: true }],
    h.byRoute.map((r) => [
      td(m.routes.find((x) => x.key === r.route)?.label ?? r.route),
      ...order.map((o) => td(r.byOutcome[o] ?? 0, { num: true, k: `outcome.${r.route}.${o}` })),
      td(
        order.reduce((s, o) => s + (r.byOutcome[o] ?? 0), 0),
        { num: true }
      )
    ]),
    {
      label: 'Hop outcomes by route',
      total: [
        td('All routes'),
        ...order.map((o) => td(h.byOutcome[o] ?? 0, { num: true, k: `outcome.all.${o}` })),
        td(
          order.reduce((s, o) => s + (h.byOutcome[o] ?? 0), 0),
          { num: true }
        )
      ]
    }
  );
  const rm = table(
    [
      { t: 'Route' },
      { t: 'Mode' },
      { t: 'Attempted', num: true },
      { t: 'Completed', num: true },
      { t: 'Completion', num: true }
    ],
    h.byRouteMode.map((r) => [
      td(r.route),
      td(r.mode),
      td(r.attempted, { num: true }),
      td(r.completed, { num: true }),
      td(r.completionRate === null ? 'n/a' : pct(r.completionRate), { num: true })
    ]),
    { label: 'Route by mode reliability' }
  );
  return section('outcomes', 'Hop outcomes', `${chart}${lg}${tbl}<h3>Route by mode</h3>${rm}`);
};

const renderLatency = (m: ReportModel, tier: number): string => {
  const l = m.latency;
  let body = '';
  if (m.latency.eventLoopDisqualifiedAt !== null) {
    body += `<p class="finding"><b>Latency figures are not reliable from +${esc(fmtDurationShort(m.latency.eventLoopDisqualifiedAt))}.</b> The tool's own event loop was backed up (stop criterion SC7 fired), so tool-side timings after that moment include its own queueing.</p>`;
  }
  if (l.hasMeasurements && l.routes.length > 0) {
    const stats = (
      d: { n: number; min: number; median: number; p90: number; max: number } | null,
      key: string
    ): string[] =>
      d === null
        ? [
            td('n/a', { num: true }),
            td('n/a', { num: true }),
            td('n/a', { num: true }),
            td('n/a', { num: true }),
            td(0, { num: true })
          ]
        : [
            td(ms(d.min), { num: true, v: d.min, k: `${key}.min` }),
            td(ms(d.median), { num: true, v: d.median, k: `${key}.median` }),
            td(ms(d.p90), { num: true, v: d.p90, k: `${key}.p90` }),
            td(ms(d.max), { num: true, v: d.max, k: `${key}.max` }),
            td(d.n, { num: true, k: `${key}.n` })
          ];
    const head = [
      { t: 'Route' },
      { t: 'Measure' },
      { t: 'Min', num: true },
      { t: 'Median', num: true },
      { t: 'p90', num: true },
      { t: 'Max', num: true },
      { t: 'n', num: true }
    ];
    const trs: string[][] = [];
    for (const r of l.routes) {
      const label = m.routes.find((x) => x.key === r.route)?.label ?? r.route;
      trs.push([td(label), td('Ready wait (T3b - T0)'), ...stats(r.ready, `ready.${r.route}`)]);
      trs.push([td(label), td('End to end (T5 - T0)'), ...stats(r.endToEnd, `e2e.${r.route}`)]);
      trs.push([td(label), td('Claim tx (T5 - T4)'), ...stats(r.claimTx, `claim.${r.route}`)]);
    }
    body += `<h3>Distribution per route</h3>${table(head, trs, { label: 'Latency per route', sortable: true })}`;
    body += note(
      `Only completed hops are counted. Hops that failed, timed out or were aborted are left out of the figures. Their counts: ${l.routes.map((r) => `${r.route} ${r.failedExcluded}`).join(', ')}. Median is the true median, p90 is nearest rank.`
    );
    const sc = (log: boolean): string =>
      stripPlot({
        aria: `Ready wait per hop and route${log ? ' (log axis)' : ''}: min, median, p90, max`,
        rows: l.routes.map((r) => ({
          label: m.routes.find((x) => x.key === r.route)?.label ?? r.route,
          slot: m.routes.find((x) => x.key === r.route)?.slot ?? 0,
          points: r.points.ready,
          failedPoints: r.points.failedReady,
          stats: r.ready
        })),
        valueFmt: (v) => fmtDurationShort(v),
        log,
        timeAxis: true,
        withPoints: tier < 1,
        xLabel:
          'ready wait (bridge mined to READY_TO_CLAIM observed); diamond = p90, bar = median, line = min to max'
      });
    body += `<h3>Ready wait, every completed hop</h3>${toggle(sc(false), sc(true))}`;
    if (l.routes.some((r) => r.pointsSampled))
      body += note(
        'Large run: the strip shows a deterministic sample of hops; the statistics above use every hop.'
      );
    const segRoutes = l.routes.filter((r) => r.segments !== null);
    if (segRoutes.length > 0) {
      body += `<h3>Per-stage breakdown (median of each stage)</h3>${hbarStack({
        aria: 'Median time per probe stage per route',
        rows: segRoutes.map((r) => ({
          label: m.routes.find((x) => x.key === r.route)?.label ?? r.route,
          segments: (r.segments ?? []).map((s, i) => ({ name: s.name, slot: i, value: s.median }))
        })),
        valueFmt: (v) => fmtDurationShort(v),
        timeAxis: true
      })}${legend(SEGMENT_NAMES.map((name, i) => ({ name, slot: i })))}`;
      body += note(
        `Each bar adds the per-stage medians, so its total can differ slightly from the end-to-end median. T0 is the client-observed bridge receipt. Stage probe interval ${l.probeIntervalMs === null ? 'off' : `${l.probeIntervalMs} ms`}: each stage time is an upper bound within one interval, plus one request latency.`
      );
    } else {
      body += empty(
        'Stage probe was off, so there is no per-stage breakdown (only the claim tx and end-to-end rows above).'
      );
    }
    body += `<h3>Stage deltas</h3>${table(
      [
        { t: 'Route' },
        { t: 'Delta' },
        { t: 'Min', num: true },
        { t: 'Median', num: true },
        { t: 'p90', num: true },
        { t: 'Max', num: true },
        { t: 'n', num: true }
      ],
      l.routes.flatMap((r) =>
        r.stageRows.map((s) => [
          td(m.routes.find((x) => x.key === r.route)?.label ?? r.route),
          td(s.name),
          ...(s.dist === null
            ? [
                td('n/a', { num: true }),
                td('n/a', { num: true }),
                td('n/a', { num: true }),
                td('n/a', { num: true }),
                td(0, { num: true })
              ]
            : [
                td(ms(s.dist.min), { num: true, v: s.dist.min }),
                td(ms(s.dist.median), { num: true, v: s.dist.median }),
                td(ms(s.dist.p90), { num: true, v: s.dist.p90 }),
                td(ms(s.dist.max), { num: true, v: s.dist.max }),
                td(s.dist.n, { num: true })
              ])
        ])
      ),
      { label: 'Stage deltas per route', sortable: true }
    )}`;
  } else {
    body += `<p class="empty">Per-hop measurements were not recorded for this run (no <code>measurement</code> block or an older tool version). The table below falls back to the phase timings: n, p50 (nearest rank), p90, p99, max. The minimum is not recorded by this tool version.</p>`;
    body += table(
      [
        { t: 'Route' },
        { t: 'Phase' },
        { t: 'n', num: true },
        { t: 'p50', num: true },
        { t: 'p90', num: true },
        { t: 'p99', num: true },
        { t: 'Max', num: true }
      ],
      l.fallbackRoutes.map((r) =>
        r.ready === null
          ? [
              td(m.routes.find((x) => x.key === r.route)?.label ?? r.route),
              td('ready_to_claim'),
              td('no completed hops on this route', { cls: 'muted' }),
              td(''),
              td(''),
              td(''),
              td('')
            ]
          : [
              td(m.routes.find((x) => x.key === r.route)?.label ?? r.route),
              td('ready_to_claim'),
              td(r.ready.n, { num: true }),
              td(ms(r.ready.p50), { num: true }),
              td(ms(r.ready.p90), { num: true }),
              td(ms(r.ready.p99), { num: true }),
              td(ms(r.ready.max), { num: true })
            ]
      ),
      { label: 'Ready-to-claim phase per route (fallback)' }
    );
  }
  body += `<h3>Phase timings</h3>`;
  body +=
    l.phases.length === 0
      ? empty('No phase timings recorded.')
      : table(
          [
            { t: 'Phase' },
            { t: 'Mode' },
            { t: 'n', num: true },
            { t: 'p50', num: true },
            { t: 'p90', num: true },
            { t: 'p99', num: true },
            { t: 'Max', num: true },
            { t: 'Timed out', num: true }
          ],
          l.phases.map((p) => [
            td(p.phase),
            td(p.mode),
            td(p.n, { num: true, v: p.n }),
            td(ms(p.p50), { num: true, v: p.p50 }),
            td(ms(p.p90), { num: true, v: p.p90 }),
            td(ms(p.p99), { num: true, v: p.p99 }),
            td(ms(p.max), { num: true, v: p.max }),
            td(p.censored, { num: true, v: p.censored })
          ]),
          { label: 'Phase timings', sortable: true }
        );
  body += note(
    'Percentiles are over phases that completed. "Timed out" counts hops that entered the phase and hit its timeout instead, kept out of the percentiles. Headless numbers are the tool\'s own; they are trustworthy only while the event loop stays under control (see Resources).'
  );
  return section('latency', 'Latency distributions per route', body);
};

const renderTimeline = (m: ReportModel, tier: number): string => {
  const tl = m.timeline;
  if (tl.mode === 'none') return section('timeline', 'Lap and hop timeline', empty(tl.reason));
  let rows = tl.rows;
  let dropNote = '';
  if (tier >= 2) {
    rows = rows.filter((r) => r.failed);
    dropNote = note(
      `Size cap: only the ${rows.length} failed row(s) are drawn out of ${tl.rowsShown}.`
    );
  }
  const vlines =
    tl.plannedStopAt === null
      ? []
      : [
          {
            at: tl.plannedStopAt,
            label: `planned stop (+${fmtDurationShort(tl.plannedStopAt)}), drain follows`
          }
        ];
  let body = '';
  if (tl.mode === 'area' && tl.area.length > 0) {
    body += `<h3>Hops in flight per route</h3>${lineChart({
      aria: 'Hops in flight per route over time',
      series: tl.area.map((a) => ({
        name: m.routes.find((r) => r.key === a.route)?.label ?? a.route,
        slot: a.slot,
        buckets: a.buckets
      })),
      xMax: tl.spanMs,
      vlines,
      ticksTop: [
        ...tl.leaves.map((at) => ({ at, kind: 'leaf' as const })),
        ...tl.pumps.map((at) => ({ at, kind: 'pump' as const }))
      ],
      valueFmt: (v) => String(Math.round(v))
    })}${legend(tl.area.map((a) => ({ name: m.routes.find((r) => r.key === a.route)?.label ?? a.route, slot: a.slot })))}`;
    body += note(tl.reason);
  } else if (tl.mode === 'area') {
    body += note(tl.reason);
  }
  if (rows.length > 0) {
    body += `<h3>${tl.mode === 'rows' ? 'One row per lap, ordered by start' : 'Failed and slowest hops'}</h3><div class="tallwrap-holder">${timelineChart(
      {
        aria:
          tl.mode === 'rows'
            ? 'Lap timeline: one row per lap'
            : 'Timeline of failed and slowest hops',
        rows,
        xMax: tl.spanMs,
        vlines,
        leaves: tl.leaves,
        pumps: tl.pumps
      }
    ).replace(
      'class="chart-wrap"',
      'class="chart-wrap tallwrap"'
    )}</div>${legend([...TIMELINE_STAGES.map((name, slot) => ({ name, slot })), { name: 'Failed hop (red to its end)', slot: 'crit' as const }])}`;
    body += note(
      `x is the time since run start. Lighter segments were still running when the log ended.${tl.leaves.length > 0 ? ' Ticks above the plot are L1 info tree leaves.' : ''}${tl.pumps.length > 0 ? ' Diamonds are pump deposits.' : ''}${vlines.length > 0 ? ' The dashed line is the planned stop; the drain follows it.' : ''}`
    );
    if (tl.leaves.length === 0 && tl.pumps.length === 0)
      body += note('No L1 leaf or pump overlays: neither was sampled in this run.');
  } else if (tl.mode === 'rows') {
    body += empty('The log holds no lap rows.');
  }
  return section('timeline', 'Lap and hop timeline', body + dropNote);
};

const renderGas = (m: ReportModel): string => {
  const g = m.claimGas;
  if (!g.hasMeasurements) {
    return section(
      'gas',
      'Claim gas',
      empty('Claim gas not recorded (tool version before S45, or no measurement block).')
    );
  }
  const kindLabel: Record<string, string> = {
    erc20_wrapper_deploy: 'First claim (wrapper deployed)',
    erc20_wrapped_mint: 'Repeat claim (wrapped mint)',
    erc20_origin_unlock: 'Origin unlock',
    eth: 'ETH claim'
  };
  const order = ['erc20_wrapper_deploy', 'erc20_wrapped_mint', 'erc20_origin_unlock', 'eth'];
  const nets = [...new Set(g.rows.map((r) => r.toNetworkId))].sort((a, b) => a - b);
  const trs: string[][] = [];
  for (const net of nets) {
    for (const kind of order) {
      const r = g.rows.find((x) => x.toNetworkId === net && x.claimKind === kind);
      if (r === undefined) {
        trs.push([
          td(net, { num: true }),
          td(kindLabel[kind]),
          td(0, {
            num: true,
            cls: 'muted',
            title: kind === 'erc20_wrapper_deploy' ? '0 (wrapper already deployed)' : ''
          }),
          td(''),
          td(''),
          td(''),
          td(''),
          td('')
        ]);
        continue;
      }
      trs.push([
        td(net, { num: true }),
        td(kindLabel[kind]),
        td(r.n, { num: true, k: `gas.${net}.${kind}.n` }),
        td(fmtInt(r.gasMin), { num: true, v: r.gasMin, k: `gas.${net}.${kind}.min` }),
        td(fmtInt(r.gasMedian), { num: true, v: r.gasMedian, k: `gas.${net}.${kind}.median` }),
        td(fmtInt(r.gasMax), { num: true, v: r.gasMax, k: `gas.${net}.${kind}.max` }),
        td(`${gwei(r.priceMedian)} gwei`, { num: true }),
        td(gweiAmount(r.feeMedian), { num: true })
      ]);
    }
  }
  let body = table(
    [
      { t: 'To network', num: true },
      { t: 'Claim' },
      { t: 'n', num: true },
      { t: 'gasUsed min', num: true },
      { t: 'gasUsed median', num: true },
      { t: 'gasUsed max', num: true },
      { t: 'Median price', num: true },
      { t: 'Median total fee (gwei)', num: true }
    ],
    trs,
    { label: 'Claim gas by destination and claim kind' }
  );
  const noFirst = nets.filter(
    (net) => !g.rows.some((x) => x.toNetworkId === net && x.claimKind === 'erc20_wrapper_deploy')
  );
  if (noFirst.length > 0) {
    body += note(
      `First claims (wrapper deployed) on network ${noFirst.join(', ')}: 0 (wrapper already deployed).`
    );
  }
  body += `<p class="finding"><b>Finding (S51).</b> A first claim of a bridged token deploys its wrapper. A repeat claim mints into the existing wrapper and costs about ${fmtInt(REPEAT_CLAIM_GAS_NONZERO)} gas when the wrapped token supply and the recipient balance are already nonzero, and about ${fmtInt(REPEAT_CLAIM_GAS_ZERO)} gas when they are zero (3 SSTOREs from zero at 17,100 each). The ring steady state, where tokens round-trip and balances return to zero, is the higher figure.</p>`;
  if (g.mintGas.length > 0) {
    const d = [...g.mintGas].sort((a, b) => a - b);
    const mid = d.length >> 1;
    const med = d.length % 2 === 1 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
    const p90 = d[Math.min(d.length - 1, Math.ceil(0.9 * d.length) - 1)];
    body += `<h3>Repeat-claim gas, every claim</h3>${stripPlot({
      aria: 'Repeat claim gas per claim with the S51 reference lines',
      rows: [
        {
          label: `Repeat claim (n ${d.length})`,
          slot: 3,
          points: g.mintGas,
          stats: { min: d[0], median: med, p90, max: d[d.length - 1] }
        }
      ],
      valueFmt: (v) => fmtCompact(v),
      refLines: [
        {
          value: REPEAT_CLAIM_GAS_NONZERO,
          label: `${fmtInt(REPEAT_CLAIM_GAS_NONZERO)} supply nonzero`
        },
        { value: REPEAT_CLAIM_GAS_ZERO, label: `${fmtInt(REPEAT_CLAIM_GAS_ZERO)} supply zero` }
      ],
      xLabel: 'gasUsed'
    })}`;
    if (g.mintPreState !== null) {
      body += `<h3>Split by observed wrapped-token state before the claim</h3>${table(
        [
          { t: 'State before claim' },
          { t: 'n', num: true },
          { t: 'gasUsed min', num: true },
          { t: 'median', num: true },
          { t: 'max', num: true }
        ],
        g.mintPreState.map((p) => [
          td(p.label),
          td(p.n, { num: true }),
          td(fmtInt(p.min), { num: true }),
          td(fmtInt(p.median), { num: true }),
          td(fmtInt(p.max), { num: true })
        ]),
        { label: 'Repeat-claim gas by observed pre-state' }
      )}${note('The two reads are made just before the claim is sent, so they are approximate if other claims land in between.')}`;
    } else if (g.mintBuckets.length > 0) {
      body += `<h3>Grouped by gas step</h3>${table(
        [
          { t: 'Bucket' },
          { t: 'n', num: true },
          { t: 'gasUsed min', num: true },
          { t: 'max', num: true }
        ],
        g.mintBuckets.map((b) => [
          td(`+${b.k} zero-to-nonzero write${b.k === 1 ? '' : 's'} (inferred from gas, S51)`),
          td(b.n, { num: true }),
          td(fmtInt(b.min), { num: true }),
          td(fmtInt(b.max), { num: true })
        ]),
        { label: 'Repeat-claim gas bucketed by 17,100 gas steps' }
      )}${note('Bucket k = round((gasUsed - lowest repeat claim) / 17,100). No pre-state reads were recorded (measurement.claimPreState off), so this is an inference.')}`;
    }
  } else {
    body += empty(
      'No repeat claims (wrapped mint) were measured, so the 177k versus 228k comparison has no data in this run.'
    );
  }
  body += `<h3>Bridge and approve gas</h3>`;
  body +=
    g.bridgeGas.length === 0
      ? empty('No bridge receipts with gas fields.')
      : table(
          [
            { t: 'Route' },
            { t: 'n', num: true },
            { t: 'gasUsed min', num: true },
            { t: 'median', num: true },
            { t: 'max', num: true },
            { t: 'Median price', num: true }
          ],
          g.bridgeGas.map((b) => [
            td(b.route),
            td(b.n, { num: true }),
            td(fmtInt(b.min), { num: true }),
            td(fmtInt(b.median), { num: true }),
            td(fmtInt(b.max), { num: true }),
            td(`${gwei(b.priceMedian)} gwei`, { num: true })
          ]),
          { label: 'Bridge gas per route' }
        );
  if (g.approveGas.length > 0) {
    body += table(
      [
        { t: 'Approve on network', num: true },
        { t: 'n', num: true },
        { t: 'gasUsed min', num: true },
        { t: 'median', num: true },
        { t: 'max', num: true }
      ],
      g.approveGas.map((a) => [
        td(a.networkId, { num: true }),
        td(a.n, { num: true }),
        td(fmtInt(a.gasMin), { num: true }),
        td(fmtInt(a.gasMedian), { num: true }),
        td(fmtInt(a.gasMax), { num: true })
      ]),
      { label: 'Approve gas per source network' }
    );
  }
  return section('gas', 'Claim gas', body);
};

const renderGates = (m: ReportModel): string => {
  if (m.gates.length === 0) return section('gates', 'Gate stalls', empty('No gate visits.'));
  const totalTicks = m.gates.reduce((s, g) => s + g.blockedTicks, 0);
  return section(
    'gates',
    'Gate stalls',
    `${table(
      [
        { t: 'Gate' },
        { t: 'Hops entered', num: true },
        { t: 'Total time', num: true },
        { t: 'p50', num: true },
        { t: 'p90', num: true },
        { t: 'p99', num: true },
        { t: 'Blocked ticks', num: true },
        { t: 'Timed-out visits', num: true }
      ],
      m.gates.map((g) => [
        td(g.gate),
        td(g.hopsEntered, { num: true, k: `gate.${g.gate}.hops` }),
        td(ms(g.totalMs), { num: true, v: g.totalMs, k: `gate.${g.gate}.total` }),
        td(ms(g.p50), { num: true, v: g.p50 }),
        td(ms(g.p90), { num: true, v: g.p90 }),
        td(ms(g.p99), { num: true, v: g.p99 }),
        td(g.blockedTicks, { num: true, cls: g.blockedTicks > 0 ? 'bad' : '' }),
        td(g.timedOutVisits, { num: true, cls: g.timedOutVisits > 0 ? 'bad' : '' })
      ]),
      { label: 'Gate stalls, longest total first', sortable: true }
    )}${note(`Percentiles include visits that ended at the timeout, so a pile-up at the timeout reads as a stall, not a latency: "Timed-out visits" says how many. Blocked ticks in total: ${totalTicks}.`)}`
  );
};

const renderErrors = (m: ReportModel): string => {
  const e = m.errors;
  const sc4 = m.stop.find((c) => c.id === 'SC4');
  if (
    e.rows.length === 0 &&
    e.suppressed.notReady === 0 &&
    e.suppressed.benignExternalAsset === 0
  ) {
    return section('errors', 'Errors by class', empty('No errors recorded.'));
  }
  let body = '';
  if (e.nonSuppressedTotal === 0 && e.rows.every((r) => r.own)) {
    body += empty(
      `No errors that count. Only warnings or tracker_not_ready rows (${e.rows.reduce((s, r) => s + r.count, 0)}), and ${e.suppressed.notReady + e.suppressed.benignExternalAsset} suppressed.${
        m.verdict.level === 'fail'
          ? ' A failed hop is not an error row: see Hop outcomes for its outcome class.'
          : ''
      }`
    );
  }
  body += table(
    [{ t: 'Class' }, { t: 'Count', num: true }, { t: 'Meaning' }],
    e.rows.map((r) => [
      td(r.class),
      td(r.count, { num: true, k: `error.${r.class}` }),
      td(
        r.own
          ? r.class === 'tracker_not_ready'
            ? 'tracker answered 503 "not ready yet" for a first-time address; never a hop failure'
            : 'bridge service not fully synced warning on a successful response; never a hop failure'
          : '',
        { wrap: true, cls: 'muted' }
      )
    ]),
    { label: 'Errors by class', sortable: true }
  );
  body += `<p class="note">Suppressed and counted separately: not_ready ${e.suppressed.notReady}, benign external asset ${e.suppressed.benignExternalAsset}.${sc4 !== undefined ? ` SC4 (proxy 4xx/5xx burst): ${esc(sc4.value)}.` : ''}</p>`;
  if (e.perMinute !== null) {
    body += `<h3>Errors over time</h3>${stackedColumns({
      aria: 'Errors per time bucket, stacked by class',
      starts: e.perMinute.starts,
      widthMs: e.perMinute.widthMs,
      stacks: e.perMinute.stacks,
      xMax: m.resources.spanMs
    })}${legend(e.perMinute.stacks.map((s) => ({ name: s.name, slot: s.slot })))}`;
  } else if (!m.environment.ndjson.present) {
    body += note('Errors over time needs activity.ndjson, which was not found.');
  }
  if (e.top.length > 0) {
    body += `<h3>Top samples (redacted)</h3>${table(
      [
        { t: 'Class' },
        { t: 'Count', num: true },
        { t: 'First seen' },
        { t: 'Last seen' },
        { t: 'Endpoint' },
        { t: 'Sample' }
      ],
      e.top.map((t) => [
        td(t.class),
        td(t.count, { num: true }),
        td(fmtTs(t.firstSeen)),
        td(fmtTs(t.lastSeen)),
        td(t.endpointClass),
        td(t.sample, { wrap: true })
      ]),
      { label: 'Top error samples' }
    )}`;
  }
  return section('errors', 'Errors by class', body);
};

const renderEndpoints = (m: ReportModel): string => {
  const h = m.http;
  let body = '';
  if (h.rows.length === 0) body += empty('No HTTP samples recorded.');
  else {
    body += table(
      [
        { t: 'Endpoint class' },
        { t: 'Mode' },
        { t: 'Origin' },
        { t: 'n', num: true },
        { t: 'p50 ms', num: true },
        { t: 'p90 ms', num: true },
        { t: 'p99 ms', num: true },
        { t: 'Max ms', num: true },
        { t: 'Status mix' },
        { t: 'Retries', num: true }
      ],
      h.rows.map((r) => [
        td(r.endpointClass),
        td(r.mode),
        td(r.origin),
        td(r.n, { num: true, v: r.n }),
        td(fmtInt(r.p50), { num: true, v: r.p50 }),
        td(fmtInt(r.p90), { num: true, v: r.p90 }),
        td(fmtInt(r.p99), { num: true, v: r.p99 }),
        td(fmtInt(r.max), { num: true, v: r.max }),
        td(
          Object.entries(r.byStatus)
            .map(([s, c]) => `${s}:${c}`)
            .join(' '),
          { cls: Object.keys(r.byStatus).some((s) => !s.startsWith('2')) ? 'bad' : '' }
        ),
        td(r.retries, { num: true, v: r.retries })
      ]),
      { label: 'Per endpoint class latency and status mix', sortable: true, compact: true }
    );
    body += note(
      `"ui" is UI-shaped load (the headline); "harness" is the tool's own control traffic. Uncontexted requests: ${h.uncontextedRequests} (0 means the table is complete). Tracker rows come first; RPC classes show the chain key, never the provider URL.`
    );
  }
  if (h.windows === null) {
    body += note(
      'Live per-window figures were not sampled (measurement.httpWindowMs not set), so only the whole-run table is shown.'
    );
  } else {
    if (h.windows.p90.length > 0) {
      body += `<h3>p90 latency per window (ui origin)</h3>${lineChart({
        aria: 'p90 latency per HTTP window for the busiest endpoint groups',
        series: h.windows.p90.map((s) => ({ name: s.name, slot: s.slot, buckets: s.buckets })),
        xMax: m.resources.spanMs,
        yFmt: (v) => `${fmtCompact(v)} ms`,
        valueFmt: (v) => `${Math.round(v)} ms`
      })}${legend(h.windows.p90.map((s) => ({ name: s.name, slot: s.slot })))}`;
    }
    if (h.windows.statuses !== null) {
      body += `<h3>Error responses per window</h3>${stackedColumns({
        aria: 'Responses with status 400 or above per window',
        starts: h.windows.statuses.starts,
        widthMs: h.windows.statuses.widthMs,
        stacks: h.windows.statuses.stacks,
        xMax: m.resources.spanMs
      })}${legend(h.windows.statuses.stacks.map((s) => ({ name: s.name, slot: s.slot })))}`;
    } else {
      body += note('No response with status 400 or above in any sampled window.');
    }
  }
  return section('endpoints', 'Proxy and endpoint health', body);
};

const renderResources = (m: ReportModel): string => {
  const r = m.resources;
  if (r.samples === 0)
    return section('resources', 'Tool resources over time', empty('No resource samples.'));
  const chart = (
    aria: string,
    name: string,
    slot: number,
    buckets: typeof r.rss,
    unit: string,
    thr?: { value: number; label: string },
    peak = false
  ): string =>
    `<h3>${esc(name)}</h3>${lineChart({ aria, series: [{ name, slot, buckets, band: true, usePeak: peak }], xMax: r.spanMs, yFmt: (v) => `${fmtCompact(v)}${unit}`, valueFmt: (v) => `${v.toFixed(unit === ' MB' ? 0 : 1)}${unit}`, thresholds: thr === undefined ? [] : [thr], h: 190 })}`;
  let body = chart('Tool resident memory over time', 'Memory (RSS)', 0, r.rss, ' MB', {
    value: 4096,
    label: 'SC6: 4096 MB'
  });
  body += chart('Tool CPU over time', 'CPU', 1, r.cpu, '%', { value: 90, label: 'SC8: 90%' });
  body += chart(
    'Event-loop p99 delay over time (peak per bucket)',
    'Event-loop p99 delay',
    2,
    r.eventLoop,
    ' ms',
    { value: 500, label: 'SC7: 500 ms' },
    true
  );
  if (r.browserRss !== null)
    body += chart(
      'Browser process memory over time',
      'Browser processes (RSS, summed)',
      3,
      r.browserRss,
      ' MB'
    );
  body += note(
    `${r.samples} samples. The line is the bucket mean (event loop: the peak), the shaded band is the min to max of each bucket, so a one-sample spike is still visible. Dashed red lines are the stop thresholds SC6/SC7/SC8.`
  );
  return section('resources', 'Tool resources over time', body);
};

const renderPump = (m: ReportModel): string => {
  const p = m.pump;
  const leaves =
    p.leavesInWindow === null
      ? ''
      : `<p>L1 leaves in window: <b>${p.leavesInWindow}</b>${p.leavesFromPump === null ? '' : ` (${p.leavesFromPump} from the pump, ${p.leavesOther} from other sources)`}.</p>`;
  if (p.state === 'off') {
    return section(
      'pump',
      'Pump activity',
      `<p class="empty">${esc(p.note)}${p.leavesInWindow === null ? '' : ` L1 leaves in window: ${p.leavesInWindow} (from other sources).`}</p>`
    );
  }
  const cap = p.maxTotalSpendWei === null ? 0 : Number(p.maxTotalSpendWei);
  const spent = p.totalSpendWei === null ? 0 : Number(p.totalSpendWei);
  const frac = cap > 0 ? Math.min(1, spent / cap) : 0;
  const kv = (k: string, v: string): string => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  return section(
    'pump',
    'Pump activity',
    `<p><span class="chip good">PUMP ON</span> ${esc(p.note)}</p><dl class="kv">${kv('Sender', p.sender ?? 'n/a')}${kv('Destination network', String(p.destinationNetworkId ?? 'n/a'))}${kv('Amount per deposit', `${eth(p.amountWei, 9)} ETH`)}${kv('Interval', `${p.intervalSeconds ?? 'n/a'} s`)}${kv('Gas price ceiling', `${p.maxGasPriceWei === null ? 'n/a' : gwei(p.maxGasPriceWei)} gwei`)}${kv('Pending receipt at stop', p.pendingAtStop === null ? 'n/a' : p.pendingAtStop ? 'yes' : 'no')}</dl><h3>Spend versus cap</h3><svg class="meterbar${frac >= 1 ? ' over' : ''}" viewBox="0 0 520 14" role="img" aria-label="Pump spend ${eth(p.totalSpendWei)} of ${eth(p.maxTotalSpendWei, 3)} ETH"><rect class="track" x="0" y="1" width="520" height="12" rx="6"/><rect class="fill" x="0" y="1" width="${(frac * 520).toFixed(1)}" height="12" rx="6"/></svg><p>${eth(p.totalSpendWei)} ETH of ${eth(p.maxTotalSpendWei, 3)} ETH (worst case counted for a pending deposit).</p><h3>Deposits</h3>${
      p.deposits.length === 0
        ? empty('The pump sent no deposit.')
        : table(
            [
              { t: 'Tx' },
              { t: 'Block', num: true },
              { t: 'depositCount', num: true },
              { t: 'Status' },
              { t: 'gasUsed', num: true },
              { t: 'Price gwei', num: true },
              { t: 'Cost ETH', num: true },
              { t: 'Cumulative ETH', num: true }
            ],
            p.deposits.map((d) => [
              td(d.txHash, { cls: 'mono' }),
              td(d.blockNumber, { num: true }),
              td(d.depositCount ?? 'n/a', { num: true }),
              td(d.status, { cls: d.status === 'success' ? 'good' : 'bad' }),
              td(fmtInt(d.gasUsed), { num: true }),
              td(gwei(d.effectiveGasPrice), { num: true }),
              td(eth(d.costWei, 9), { num: true }),
              td(d.cumulativeWei === '' ? 'n/a' : eth(d.cumulativeWei, 9), { num: true })
            ]),
            { label: 'Pump deposits' }
          )
    }<h3>Skipped ticks</h3>${table(
      [{ t: 'Reason' }, { t: 'Count', num: true }],
      Object.entries(p.skipped).map(([k, v]) => [td(k), td(v, { num: true })]),
      { label: 'Pump skips by reason' }
    )}${leaves}`
  );
};

const renderStop = (m: ReportModel): string => {
  const rows = m.stop.map((c) => {
    const state =
      c.fired === null
        ? c.kind === 'outside'
          ? 'outside the tool'
          : 'not evaluable'
        : c.fired
          ? c.kind === 'gate'
            ? 'GATE FAILED'
            : 'FIRED'
          : 'ok';
    const cls = c.fired === true ? 'bad' : c.fired === false ? 'good' : 'muted';
    return [
      td(c.id),
      td(c.title),
      td(c.threshold, { wrap: true }),
      td(c.value, { wrap: true }),
      td(state, { cls }),
      td(c.firstFiredAt === null ? '' : fmtTs(new Date(c.firstFiredAt).toISOString())),
      td(c.note, { wrap: true, cls: 'muted' })
    ];
  });
  return section(
    'stop',
    'Stop criteria (post-hoc)',
    `${table([{ t: 'ID' }, { t: 'Criterion' }, { t: 'Rule' }, { t: 'Observed' }, { t: 'Result' }, { t: 'First at (UTC)' }, { t: 'Note' }], rows, { label: 'Stop criteria SC1 to SC13 and the stage gate' })}${note('Read-only evaluation of the campaign stop criteria over this run. It stops nothing; the operator decides. Criteria without data are marked not evaluable and name the missing metric.')}`
  );
};

const renderWallets = (m: ReportModel): string => {
  const w = m.wallets;
  let body = '';
  if (w.balanceCharts.length === 0) {
    body += empty('Balances not sampled (measurement.walletBalanceIntervalMs not set).');
  } else {
    for (const c of w.balanceCharts) {
      body += `<h3>${esc(c.chainKey)} balance (ETH)</h3>${lineChart({
        aria: `Lowest and median wallet balance on ${c.chainKey}`,
        series: [
          { name: 'lowest wallet', slot: 0, buckets: c.min },
          { name: 'median wallet', slot: 2, buckets: c.median }
        ],
        xMax: m.resources.spanMs,
        yFmt: (v) => v.toFixed(4),
        valueFmt: (v) => `${v.toFixed(6)} ETH`,
        thresholds:
          c.floorEth === null
            ? []
            : [{ value: c.floorEth, label: `SC9 floor ${c.floorEth.toFixed(4)} ETH` }],
        h: 190,
        minSpan: 1e-6
      })}${legend([
        { name: 'lowest wallet', slot: 0 },
        { name: 'median wallet', slot: 2 }
      ])}`;
    }
  }
  body += '<h3>Per wallet</h3>';
  if (w.rows.length === 0)
    body += empty(
      'No per-wallet activity: activity.ndjson was not found or holds no wallet lines.'
    );
  else {
    body += table(
      [
        { t: 'User' },
        { t: 'HD index', num: true },
        { t: 'Ticks', num: true },
        { t: 'Laps done', num: true },
        { t: 'Laps failed', num: true },
        { t: 'Laps aborted', num: true },
        { t: 'Hops ok', num: true },
        { t: 'Hops failed', num: true },
        { t: 'Last lowest balance', num: true }
      ],
      w.rows.map((r) => [
        td(r.userId),
        td(r.walletIndex ?? 'n/a', { num: true, v: r.walletIndex ?? -1 }),
        td(r.ticks, { num: true, v: r.ticks }),
        td(r.lapsDone, { num: true, v: r.lapsDone }),
        td(r.lapsFailed, { num: true, v: r.lapsFailed, cls: r.lapsFailed > 0 ? 'bad' : '' }),
        td(r.lapsAborted, { num: true, v: r.lapsAborted }),
        td(r.hopsOk, { num: true, v: r.hopsOk }),
        td(r.hopsFailed, { num: true, v: r.hopsFailed, cls: r.hopsFailed > 0 ? 'bad' : '' }),
        td(r.lastMinBalanceWei === null ? 'n/a' : `${eth(r.lastMinBalanceWei)} ETH`, {
          num: true,
          v: r.lastMinBalanceWei === null ? -1 : Number(r.lastMinBalanceWei)
        })
      ]),
      { label: 'Per wallet activity', sortable: true, compact: true }
    );
    if (w.rowsTruncated)
      body += note(`Showing 200 of ${w.totalWallets} wallets (lowest user numbers first).`);
  }
  return section('wallets', 'Wallet balances', body);
};

const flattenConfig = (value: unknown, prefix: string, out: [string, string][]): void => {
  if (value === null || value === undefined) {
    out.push([prefix, 'none']);
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push([prefix, 'none']);
    else if (value.every((v) => typeof v !== 'object' || v === null))
      out.push([prefix, value.join(' > ')]);
    else value.forEach((v, i) => flattenConfig(v, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out.push([prefix, 'none']);
    for (const [k, v] of entries) flattenConfig(v, prefix === '' ? k : `${prefix}.${k}`, out);
  } else {
    const text = String(value);
    // Millisecond settings read better with the duration next to the raw number.
    const human =
      /Ms$/.test(prefix) && typeof value === 'number' && value >= 1000
        ? ` (${fmtDurationShort(value)})`
        : '';
    out.push([prefix, text === '' ? '(empty)' : `${text}${human}`]);
  }
};

const renderConfig = (m: ReportModel): string => {
  const groups = new Map<string, [string, string][]>();
  const general: [string, string][] = [];
  for (const [key, value] of Object.entries(m.config)) {
    if (
      typeof value !== 'object' ||
      value === null ||
      (Array.isArray(value) && value.every((v) => typeof v !== 'object'))
    ) {
      flattenConfig(value, key, general);
    } else {
      const rows: [string, string][] = [];
      flattenConfig(value, key, rows);
      groups.set(key, rows);
    }
  }
  const block = (name: string, rows: [string, string][]): string =>
    `<details open><summary>${esc(name)} <span class="muted">(${rows.length})</span></summary>${table(
      [{ t: 'Field' }, { t: 'Value' }],
      rows.map(([k, v]) => [td(k, { cls: 'mono' }), td(v, { wrap: true })]),
      { label: `Configuration: ${name}`, compact: true }
    )}</details>`;
  return section(
    'config',
    'Configuration (redacted)',
    `${note('Only an allowlist of fields is shown. RPC and proxy addresses appear as host only, secret references as their name, and the output directory as its last path segment.')}${block('general', general)}${[...groups.entries()].map(([name, rows]) => block(name, rows)).join('')}`
  );
};

const renderEnvironment = (m: ReportModel, notes: string[]): string => {
  const e = m.environment;
  const kv = (k: string, v: unknown): string =>
    `<dt>${esc(k)}</dt><dd>${esc(v === null || v === undefined || v === '' ? 'unknown' : v)}</dd>`;
  return section(
    'environment',
    'Environment and report notes',
    `<dl class="kv">${kv('Tool version', e.toolVersion)}${kv('SDK version', e.sdkVersion)}${kv('Host', e.host === null ? null : `${e.host.cores} cores, ${fmtInt(e.host.totalMemMb)} MB, ${e.host.platform}`)}${kv('Gas-token chains', e.gasTokenChains.length === 0 ? 'none' : e.gasTokenChains.join(', '))}${kv('results.json schema', e.schemaVersion)}${kv('Report generator', m.generator.version)}${kv('activity.ndjson', e.ndjson.present ? `${fmtInt(e.ndjson.lines)} lines read, ${e.ndjson.malformed} malformed${e.ndjson.truncatedTail ? ', last line truncated' : ''}` : 'not found')}${kv('Downsampling', notes.length === 0 ? 'none needed' : notes.join(' '))}</dl>`
  );
};

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

/** The JSON embedded in the page. `tier >= 3` removes the per-hop columns and timeline rows. */
export const embeddedModel = (m: ReportModel, tier: number): unknown => {
  if (tier < 3) return m;
  return {
    ...m,
    latency: {
      ...m.latency,
      routes: m.latency.routes.map((r) => ({ ...r, points: { ready: [], failedReady: [] } }))
    },
    timeline: { ...m.timeline, rows: [] }
  };
};

export interface RenderedReport {
  html: string;
  bytes: number;
  tier: number;
  notes: string[];
}

/** The shared page shell: CSP with the script hash, inline CSS, the embedded JSON and the one inline script. */
export const wrapDocument = (title: string, body: string, embedded: unknown): string => {
  const script = REPORT_CLIENT_JS;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src ${cspHash(script)}; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(csp, 1000)}">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
${body}
<footer>Single self-contained file generated by the load test tool. It makes no network request and needs no script to read.</footer>
</div>
<script type="application/json" id="report-data">${safeJsonForScript(embedded)}</script>
<script>${script}</script>
</body>
</html>
`;
};

export const renderReportHtml = (m: ReportModel, options: RenderOptions = {}): RenderedReport => {
  const tier = options.tier ?? 0;
  const notes = SIZE_TIER_NOTES.slice(0, tier);
  const body = [
    renderVerdict(m, notes),
    renderToc(),
    renderKpis(m),
    renderThroughput(m),
    renderOutcomes(m),
    renderLatency(m, tier),
    renderTimeline(m, tier),
    renderGas(m),
    renderGates(m),
    renderErrors(m),
    renderEndpoints(m),
    renderResources(m),
    renderPump(m),
    renderStop(m),
    renderWallets(m),
    renderConfig(m),
    renderEnvironment(m, notes)
  ].join('\n');
  const html = wrapDocument(`Load test report ${m.identity.runName}`, body, embeddedModel(m, tier));
  return { html, bytes: Buffer.byteLength(html, 'utf8'), tier, notes };
};

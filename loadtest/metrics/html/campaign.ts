// The campaign roll-up page (S54, heavy-load design §4.7): one self-contained
// HTML file comparing several runs. Hop-level data of the processes that make up
// one stage is POOLED before any percentile is taken (percentiles are never
// averaged). It reuses the per-run modules and the same safety rules: CSP, one
// `esc()`, no network, no absolute paths (links are relative, and only when the
// target sits under the roll-up's own directory).
import fs from 'node:fs';
import path from 'node:path';

import type { ResultsJson } from '../report';
import type { Dist, RunMeta } from './model';
import type { Digest } from './ndjsonDigest';

import { isSuccessOutcome } from '../../core/types';
import { failureRates, computeVerdict } from '../report';
import { evaluateStopCriteria } from '../stopCriteria';
import { esc } from './escape';
import { assertNoSecrets, DEFAULT_MAX_BYTES, loadResults, parseMeta, runNameOf } from './index';
import { dist, levelOfVerdict } from './model';
import { digestFromFile } from './ndjsonDigest';
import {
  empty,
  fmtInt,
  LEVEL_ICON,
  LEVEL_WORD,
  ms,
  note,
  pct,
  section,
  table,
  td,
  wrapDocument
} from './render';
import { categoryLineChart, ecdfChart, fmtDurationShort, hbarStack, legend } from './svg';

export interface CampaignRunSpec {
  /** Stage label, e.g. `3a`. Several directories under one label are the processes of one stage. */
  label: string;
  dirs: string[];
}

interface Proc {
  label: string;
  dir: string;
  results: ResultsJson;
  digest: Digest;
  meta: RunMeta;
  runName: string;
  /** Wait of every completed hop, per route. */
  ready: Record<string, number[]>;
}

export interface CampaignProcRow {
  label: string;
  runName: string;
  ring: string;
  wallets: number;
  rate: number;
  minutes: number;
  pump: 'on' | 'off';
  level: string;
  verdict: string;
  lapFailureRate: number | null;
  hardHopFailureRate: number | null;
  achievedRate: number;
  backpressurePct: number | null;
  readyByRoute: { route: string; dist: Dist | null }[];
  leaves: number | null;
  pumpDeposits: number | null;
  peakRssMb: number | null;
  worstEventLoopMs: number | null;
  fired: string[];
  link: string | null;
}

export interface CampaignStage {
  label: string;
  processes: number;
  wallets: number;
  pump: 'on' | 'off' | 'mixed';
  routes: { route: string; dist: Dist | null; completed: number }[];
  hopsEnded: number;
  hardHopFailures: number;
  failureRate: number | null;
  leavesPerHour: number | null;
  pumpDeposits: number | null;
  peakRssMb: number | null;
  worstEventLoopMs: number | null;
  curves: Record<string, number[]>;
}

export interface CampaignModel {
  generatedAt: string;
  rows: CampaignProcRow[];
  stages: CampaignStage[];
  routes: string[];
}

const readyWaits = (results: ResultsJson): Record<string, number[]> => {
  const out: Record<string, number[]> = {};
  for (const h of results.measurements?.hops ?? []) {
    if (!isSuccessOutcome(h.outcome)) continue;
    const t0 = h.bridge.minedObservedAt;
    if (t0 === null || h.readyObservedAt === null) continue;
    const wait = h.readyObservedAt - t0;
    if (wait < 0) continue;
    (out[h.hopRoute] ??= []).push(wait);
  }
  return out;
};

const loadProc = async (label: string, dirArg: string): Promise<Proc> => {
  const dir = path.resolve(dirArg);
  const results = loadResults(dir);
  const digest = await digestFromFile(path.join(dir, 'activity.ndjson'));
  const metaPath = path.join(dir, '..', 'meta.txt');
  const meta = fs.existsSync(metaPath) ? parseMeta(fs.readFileSync(metaPath, 'utf8')) : {};
  return { label, dir, results, digest, meta, runName: runNameOf(dir), ready: readyWaits(results) };
};

const max = (values: (number | null)[]): number | null => {
  const v = values.filter((x): x is number => x !== null);
  return v.length === 0 ? null : Math.max(...v);
};

export const buildCampaignModel = (
  procs: Proc[],
  outPath: string,
  generatedAt: string
): CampaignModel => {
  const routes = [...new Set(procs.flatMap((p) => Object.keys(p.results.hops.byRoute)))].sort();
  const rows: CampaignProcRow[] = procs.map((p) => {
    const cfg = (p.results.config ?? {}) as {
      ring?: string[];
      pump?: { enabled?: boolean };
      chains?: { key: string; networkId: number }[];
    };
    const verdict = computeVerdict(p.results);
    const rates = failureRates(p.results);
    const samples = p.results.resources?.samples ?? [];
    const stop = evaluateStopCriteria({
      digest: p.digest,
      ring: cfg.ring ?? [],
      chains: cfg.chains,
      gasPerChain: (
        p.results.config as { users?: { funder?: { gasPerChain?: Record<string, string> } } }
      )?.users?.funder?.gasPerChain,
      pump:
        p.results.pump === undefined
          ? null
          : {
              maxTotalSpendWei: p.results.pump.maxTotalSpendWei,
              totalSpendWei: p.results.pump.totalSpendWei
            },
      readyWaitByRoute: p.ready
    });
    const offered = p.results.achieved.ticksOffered;
    const target = path.join(p.dir, 'report.html');
    const rel = path.relative(path.dirname(path.resolve(outPath)), target);
    return {
      label: p.label,
      runName: p.runName,
      ring: (cfg.ring ?? []).join(' > '),
      wallets: p.results.requested.users,
      rate: p.results.requested.ratePerUserPerMin,
      minutes: p.results.requested.minutes,
      pump: p.results.pump?.enabled === true ? 'on' : 'off',
      level: levelOfVerdict(verdict),
      verdict,
      lapFailureRate: rates.lapFailureRate,
      hardHopFailureRate: rates.hardHopFailureRate,
      achievedRate: p.results.achieved.steadyStateRatePerUserPerMin,
      backpressurePct:
        offered > 0 ? (p.results.achieved.skippedBackpressure / offered) * 100 : null,
      readyByRoute: Object.keys(p.ready)
        .sort()
        .map((route) => ({ route, dist: dist(p.ready[route]) })),
      leaves: p.results.l1InfoTree === undefined ? null : p.results.l1InfoTree.leaves.length,
      pumpDeposits: p.results.pump === undefined ? null : p.results.pump.deposits.length,
      peakRssMb: samples.length === 0 ? null : Math.max(...samples.map((s) => s.toolRssMb)),
      worstEventLoopMs: samples.some((s) => s.eventLoopDelayP99Ms !== undefined)
        ? Math.max(...samples.map((s) => s.eventLoopDelayP99Ms ?? 0))
        : null,
      fired: stop.filter((c) => c.fired === true).map((c) => c.id),
      link: rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/')
    };
  });

  const labels = [...new Set(procs.map((p) => p.label))];
  const stages: CampaignStage[] = labels.map((label) => {
    const group = procs.filter((p) => p.label === label);
    const groupRows = rows.filter((r) => r.label === label);
    const pooled: Record<string, number[]> = {};
    for (const p of group)
      for (const [route, waits] of Object.entries(p.ready)) (pooled[route] ??= []).push(...waits);
    let hopsEnded = 0;
    let hard = 0;
    for (const p of group) {
      const r = failureRates(p.results);
      hopsEnded += r.hopsEnded;
      hard += r.hardHopFailures;
    }
    const hours = Math.max(...group.map((p) => (p.results.run.durationMs ?? 0) / 3_600_000));
    const leaves = group.map((p) => p.results.l1InfoTree?.leaves.length ?? null);
    const pumpModes = new Set(groupRows.map((r) => r.pump));
    return {
      label,
      processes: group.length,
      wallets: groupRows.reduce((s, r) => s + r.wallets, 0),
      pump: pumpModes.size > 1 ? 'mixed' : (groupRows[0]?.pump ?? 'off'),
      routes: routes.map((route) => ({
        route,
        dist: dist(pooled[route] ?? []),
        completed: (pooled[route] ?? []).length
      })),
      hopsEnded,
      hardHopFailures: hard,
      failureRate: hopsEnded > 0 ? hard / hopsEnded : null,
      // Leaves are chain-wide, so the same L1 leaves show up in every process of a stage: use the busiest sample, never the sum.
      leavesPerHour:
        leaves.every((l) => l === null) || hours === 0 ? null : (max(leaves) as number) / hours,
      pumpDeposits: groupRows.some((r) => r.pumpDeposits !== null)
        ? groupRows.reduce((s, r) => s + (r.pumpDeposits ?? 0), 0)
        : null,
      peakRssMb: max(groupRows.map((r) => r.peakRssMb)),
      worstEventLoopMs: max(groupRows.map((r) => r.worstEventLoopMs)),
      curves: pooled
    };
  });
  stages.sort((a, b) => a.wallets - b.wallets || a.label.localeCompare(b.label));
  return { generatedAt, rows, stages, routes };
};

/** `82>85` when both chain keys end in a network id (BALI_82), else the route as written. */
const routeShort = (route: string): string => {
  const [from, to] = route.split('->');
  const a = /(\d+)$/.exec(from ?? '');
  const b = /(\d+)$/.exec(to ?? '');
  return a !== null && b !== null ? `${a[1]}>${b[1]}` : route;
};

export const renderCampaignHtml = (m: CampaignModel): string => {
  const parts: string[] = [];
  const worst: 'fail' | 'incomplete' | 'pass' = m.rows.some((r) => r.level === 'fail')
    ? 'fail'
    : m.rows.some((r) => r.level !== 'pass')
      ? 'incomplete'
      : 'pass';
  parts.push(
    `<section id="rollup" class="panel first" aria-labelledby="rollup-h"><h2 id="rollup-h" hidden>Campaign</h2><div class="banner"><div class="stamp ${worst}">${LEVEL_ICON[worst]}<span>${LEVEL_WORD[worst]}</span></div><div class="banner-main"><h1 class="verdict-line">Campaign roll-up: ${m.stages.length} stage${m.stages.length === 1 ? '' : 's'}, ${m.rows.length} process${m.rows.length === 1 ? '' : 'es'}</h1><p class="rates"><span>${m.rows.filter((r) => r.level === 'pass').length} PASS</span><span>${m.rows.filter((r) => r.level === 'fail').length} FAIL</span><span>${m.rows.filter((r) => r.level !== 'pass' && r.level !== 'fail').length} other</span></p><p class="gonogo">Go/no-go uses the stop criteria listed per run below, not the strict verdict (FAIL on any failed lap). Generated ${esc(m.generatedAt)}.</p></div></div></section>`
  );

  // run table
  parts.push(
    section(
      'runs',
      'Runs',
      table(
        [
          { t: 'Stage' },
          { t: 'Run' },
          { t: 'Ring' },
          { t: 'Wallets', num: true },
          { t: 'Load (rate, min)', num: true },
          { t: 'Pump' },
          { t: 'Verdict' },
          { t: 'Lap / hop fail', num: true },
          { t: 'Achieved', num: true },
          { t: 'Backpressure', num: true },
          { t: 'Stop criteria fired' },
          { t: 'Report' }
        ],
        m.rows.map((r) => [
          td(r.label),
          td(r.runName),
          td(r.ring, { wrap: true }),
          td(r.wallets, { num: true, v: r.wallets }),
          td(`${r.rate} / ${r.minutes}`, { num: true }),
          td(r.pump.toUpperCase()),
          td(r.verdict, {
            wrap: true,
            cls: r.level === 'pass' ? 'good' : r.level === 'fail' ? 'bad' : ''
          }),
          td(`${pct(r.lapFailureRate)} / ${pct(r.hardHopFailureRate)}`, { num: true }),
          td(r.achievedRate.toFixed(3), { num: true, v: r.achievedRate }),
          td(r.backpressurePct === null ? 'n/a' : `${r.backpressurePct.toFixed(1)}%`, {
            num: true
          }),
          td(r.fired.length === 0 ? 'none' : r.fired.join(', '), {
            cls: r.fired.length === 0 ? 'good' : 'bad'
          }),
          r.link === null
            ? td('n/a', { cls: 'muted', title: "Report is outside this page's directory tree" })
            : `<td><a href="${esc(r.link)}">report</a></td>`
        ]),
        { label: 'One row per process', sortable: true, compact: true }
      ) +
        note(
          "One row per process (one ring on one wallet range). The report link is relative and only present when the run directory sits under this page's own directory."
        ) +
        '<h3>Measurements per process</h3>' +
        table(
          [
            { t: 'Stage' },
            { t: 'Run' },
            { t: 'Ready wait median / p90 / max' },
            { t: 'Leaves / pump deposits', num: true },
            { t: 'Peak RSS / loop p99', num: true }
          ],
          m.rows.map((r) => [
            td(r.label),
            td(r.runName),
          td(
            r.readyByRoute.length === 0
              ? 'n/a (no measurement)'
              : r.readyByRoute
                  .map(
                    (x) =>
                      `${routeShort(x.route)}: ${x.dist === null ? 'n/a' : `${ms(x.dist.median)} / ${ms(x.dist.p90)} / ${ms(x.dist.max)}`}`
                  )
                  .join('; '),
            { wrap: true }
          ),
          td(
            `${r.leaves === null ? 'n/a' : r.leaves} / ${r.pumpDeposits === null ? 'n/a' : r.pumpDeposits}`,
            { num: true }
          ),
          td(
            `${r.peakRssMb === null ? 'n/a' : `${r.peakRssMb.toFixed(0)} MB`} / ${r.worstEventLoopMs === null ? 'n/a' : `${r.worstEventLoopMs.toFixed(0)} ms`}`,
            { num: true, v: r.peakRssMb ?? -1 }
          ),
          ]),
          { label: 'Measurements per process', sortable: true, compact: true }
        )
    )
  );

  // stage table (pooled)
  const stageRows: string[][] = [];
  for (const s of m.stages) {
    for (const r of s.routes) {
      if (r.completed === 0) continue;
      stageRows.push([
        td(s.label),
        td(s.wallets, { num: true }),
        td(s.pump.toUpperCase()),
        td(routeShort(r.route)),
        td(r.completed, { num: true }),
        td(r.dist === null ? 'n/a' : ms(r.dist.min), { num: true }),
        td(r.dist === null ? 'n/a' : ms(r.dist.median), { num: true }),
        td(r.dist === null ? 'n/a' : ms(r.dist.p90), { num: true }),
        td(r.dist === null ? 'n/a' : ms(r.dist.max), { num: true }),
        td(pct(s.failureRate, 2), { num: true }),
        td(s.leavesPerHour === null ? 'n/a (not sampled)' : s.leavesPerHour.toFixed(1), {
          num: true
        }),
        td(s.pumpDeposits === null ? 'n/a' : s.pumpDeposits, { num: true })
      ]);
    }
  }
  parts.push(
    section(
      'stages',
      'Stages (hops pooled across processes)',
      (stageRows.length === 0
        ? empty('No completed hop with a ready-wait measurement in any run.')
        : table(
            [
              { t: 'Stage' },
              { t: 'Wallets', num: true },
              { t: 'Pump' },
              { t: 'Route' },
              { t: 'Completed hops', num: true },
              { t: 'Min', num: true },
              { t: 'Median', num: true },
              { t: 'p90', num: true },
              { t: 'Max', num: true },
              { t: 'Hard hop failures', num: true },
              { t: 'L1 leaves /h', num: true },
              { t: 'Pump deposits', num: true }
            ],
            stageRows,
            { label: 'Pooled ready wait per stage and route', sortable: true, compact: true }
          )) +
        note(
          'The ready wait of every completed hop of a stage is pooled first and the min, median, p90 and max are taken over the pool; percentiles are never averaged across processes. Failure rate is hard hop failures (SC1 outcomes) over every hop that reached an outcome.'
        )
    )
  );

  // charts
  let charts = '';
  const withData = m.stages.filter((s) => s.routes.some((r) => r.dist !== null));
  if (withData.length === 0) {
    charts += empty('No ready-wait data to chart.');
  } else {
    const cats = withData.map((s) => `${s.label} (${s.wallets})`);
    const routeSlots = m.routes.filter((route) =>
      withData.some((s) => s.routes.some((r) => r.route === route && r.dist !== null))
    );
    charts += `<h3>Ready wait versus wallets</h3>${categoryLineChart({
      aria: 'Ready wait median and p90 per route, one point per stage, ordered by total wallets',
      categories: cats,
      series: routeSlots.flatMap((route, i) => [
        {
          name: `${routeShort(route)} p90`,
          slot: i,
          values: withData.map((s) => s.routes.find((r) => r.route === route)?.dist?.p90 ?? null)
        },
        {
          name: `${routeShort(route)} median`,
          slot: i,
          dashed: true,
          values: withData.map((s) => s.routes.find((r) => r.route === route)?.dist?.median ?? null)
        }
      ]),
      valueFmt: (v) => fmtDurationShort(v),
      timeAxis: true,
      xLabel: 'stage (total wallets); solid = p90, dashed = median'
    })}${legend(routeSlots.map((route, i) => ({ name: routeShort(route), slot: i })))}`;
    // ECDF panels
    for (const route of routeSlots) {
      const curves = withData
        .filter((s) => (s.curves[route] ?? []).length > 0)
        .map((s, i) => ({
          name: `${s.label}${s.pump === 'on' ? ' (pump on)' : ''}`,
          slot: i,
          values: s.curves[route]
        }));
      if (curves.length < 1) continue;
      charts += `<h3>Distribution of ${esc(routeShort(route))} ready wait per stage</h3>${ecdfChart({ aria: `Cumulative distribution of ready wait on ${routeShort(route)}, one curve per stage`, curves, valueFmt: (v) => fmtDurationShort(v) })}${legend(curves.map((c) => ({ name: c.name, slot: c.slot })))}`;
    }
    const lph = withData.filter((s) => s.leavesPerHour !== null);
    charts += `<h3>L1 leaves and pump deposits per stage</h3>${
      lph.length === 0
        ? empty('n/a (not sampled): no run sampled the L1 info tree.')
        : table(
            [
              { t: 'Stage' },
              { t: 'Pump' },
              { t: 'Leaves per hour', num: true },
              { t: 'Pump deposits', num: true }
            ],
            lph.map((s) => [
              td(s.label),
              td(s.pump.toUpperCase()),
              td((s.leavesPerHour as number).toFixed(1), { num: true }),
              td(s.pumpDeposits === null ? 'n/a' : s.pumpDeposits, { num: true })
            ]),
            { label: 'Leaves and pump deposits per stage' }
          )
    }`;
  }
  const noData = m.stages.filter((s) => !withData.includes(s));
  if (withData.length > 0 && noData.length > 0) {
    charts = `${note(`Not in the charts or the stage table: ${noData.map((s) => s.label).join(', ')} (no per-hop ready-wait measurement in that run, so there is nothing to pool).`)}${charts}`;
  }
  parts.push(section('charts', 'Comparison charts', charts));

  // resources per stage
  const rs = m.stages.filter((s) => s.peakRssMb !== null || s.worstEventLoopMs !== null);
  parts.push(
    section(
      'resources',
      'Tool resources per stage',
      rs.length === 0
        ? empty('No resource samples.')
        : `<h3>Peak tool RSS (MB)</h3>${hbarStack({ aria: 'Peak tool RSS per stage', rows: rs.map((s) => ({ label: `${s.label} (${s.wallets} ${s.wallets === 1 ? 'wallet' : 'wallets'})`, segments: [{ name: 'peak RSS', slot: 0, value: s.peakRssMb ?? 0 }] })), valueFmt: (v) => `${fmtInt(Math.round(v))}` })}<h3>Worst event-loop p99 (ms)</h3>${hbarStack({ aria: 'Worst event-loop p99 per stage', rows: rs.map((s) => ({ label: `${s.label} (${s.wallets} ${s.wallets === 1 ? 'wallet' : 'wallets'})`, segments: [{ name: 'worst p99', slot: 2, value: s.worstEventLoopMs ?? 0 }] })), valueFmt: (v) => `${fmtInt(Math.round(v))}` })}`
    )
  );
  return parts.join('\n');
};

export interface CampaignReportOptions {
  outPath: string;
  runs: CampaignRunSpec[];
  maxBytes?: number;
  now?: () => Date;
}

export const generateCampaignReport = async (
  options: CampaignReportOptions
): Promise<{ htmlPath: string; bytes: number }> => {
  const procs: Proc[] = [];
  for (const spec of options.runs)
    for (const dir of spec.dirs) procs.push(await loadProc(spec.label, dir));
  if (procs.length === 0) throw new Error('campaign-report needs at least one --run <label>=<dir>');
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const model = buildCampaignModel(procs, options.outPath, generatedAt);
  const html = wrapDocument('Campaign roll-up', renderCampaignHtml(model), model);
  for (const p of procs) assertNoSecrets(html, p.results.config, model);
  const bytes = Buffer.byteLength(html, 'utf8');
  const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes > limit)
    throw new Error(`campaign report is ${bytes} bytes, over the ${limit} byte cap`);
  const htmlPath = path.resolve(options.outPath);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  return { htmlPath, bytes };
};

/** Parses repeated `--run <label>=<dir>[,<dir>...]` values. */
export const parseRunSpecs = (values: string[]): CampaignRunSpec[] =>
  values.map((v) => {
    const eq = v.indexOf('=');
    if (eq <= 0 || eq === v.length - 1)
      throw new Error(`--run must be <label>=<dir>[,<dir>], got "${v}"`);
    return {
      label: v.slice(0, eq),
      dirs: v
        .slice(eq + 1)
        .split(',')
        .filter((d) => d !== '')
    };
  });

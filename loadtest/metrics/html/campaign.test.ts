// S54: the campaign roll-up page (several runs, hops pooled per stage).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResultsJson } from '../report';
import type { CampaignModel } from './campaign';

import { copyFixtureRun, makeTempRoot, readJson } from './__fixtures__/load';
import { buildSyntheticRun, writeRunDir } from './__fixtures__/synthetic';
import { generateCampaignReport, parseRunSpecs } from './campaign';
import { dist } from './model';

const NOW = (): Date => new Date('2026-10-14T12:00:00Z');

const embedded = (html: string): CampaignModel => {
  const m = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error('no embedded JSON');
  return JSON.parse(m[1]) as CampaignModel;
};

const readyWaits = (results: ResultsJson, route: string): number[] =>
  (results.measurements?.hops ?? [])
    .filter((h) => h.hopRoute === route && h.outcome.startsWith('hop_completed'))
    .map((h) => (h.readyObservedAt as number) - (h.bridge.minedObservedAt as number));

describe('parseRunSpecs', () => {
  it('splits label and directories', () => {
    expect(parseRunSpecs(['3a=/x/out,/y/out', '3b=/z'])).toStrictEqual([
      { label: '3a', dirs: ['/x/out', '/y/out'] },
      { label: '3b', dirs: ['/z'] }
    ]);
  });

  it('rejects a spec without a label or directory', () => {
    expect(() => parseRunSpecs(['nope'])).toThrow(/--run must be/);
    expect(() => parseRunSpecs(['=dir'])).toThrow(/--run must be/);
    expect(() => parseRunSpecs(['a='])).toThrow(/--run must be/);
  });
});

describe('campaign roll-up', () => {
  const root = makeTempRoot();
  // Stage 3a: two processes (I and J rings), pump off. Stage 3b: the same shape with the pump on and more wallets.
  const a1 = buildSyntheticRun({ wallets: 3, hours: 2, seed: 1, lapEveryMin: 15 });
  const a2 = buildSyntheticRun({ wallets: 2, hours: 2, seed: 2, lapEveryMin: 15 });
  const b1 = buildSyntheticRun({ wallets: 5, hours: 2, seed: 3, pump: true, lapEveryMin: 15 });
  const dirs = {
    a1: writeRunDir(root, 'run-3a-I', a1),
    a2: writeRunDir(root, 'run-3a-J', a2),
    b1: writeRunDir(root, 'run-3b-I', b1)
  };
  const outPath = path.join(root, 'campaign.html');
  let html = '';
  let model: CampaignModel;

  it('renders every section', async () => {
    const generated = await generateCampaignReport({
      outPath,
      now: NOW,
      runs: [
        { label: '3a', dirs: [dirs.a1, dirs.a2] },
        { label: '3b', dirs: [dirs.b1] }
      ]
    });
    html = fs.readFileSync(generated.htmlPath, 'utf8');
    model = embedded(html);
    for (const id of ['rollup', 'runs', 'stages', 'charts', 'resources']) {
      expect(html, id).toContain(`id="${id}-h"`);
    }
    expect(html).toContain('<title>Campaign roll-up</title>');
    expect(html).toContain('Go/no-go uses the stop criteria');
    expect(model.rows).toHaveLength(3);
    expect(model.stages.map((s) => s.label)).toStrictEqual(['3a', '3b']);
  });

  it('pools the hops of a stage before taking percentiles', () => {
    const stage = model.stages.find((s) => s.label === '3a');
    const route = 'BALI_82->BALI_85';
    const pooled = [...readyWaits(a1.results, route), ...readyWaits(a2.results, route)];
    const expected = dist(pooled);
    expect(stage?.routes.find((r) => r.route === route)?.dist).toStrictEqual(expected);
    const perRun = [a1, a2].map((r) => dist(readyWaits(r.results, route))?.p90 as number);
    const averaged = (perRun[0] + perRun[1]) / 2;
    expect(expected?.p90).not.toBe(averaged);
    expect(stage?.wallets).toBe(5);
    expect(stage?.processes).toBe(2);
  });

  it('keeps one row per process with its own figures', () => {
    const row = model.rows.find((r) => r.runName === 'run-3b-I');
    expect(row).toMatchObject({ label: '3b', wallets: 5, pump: 'on' });
    expect(row?.pumpDeposits).toBe(b1.results.pump?.deposits.length);
    expect(row?.leaves).toBe(b1.results.l1InfoTree?.leaves.length);
    expect(model.stages.find((s) => s.label === '3b')?.pump).toBe('on');
    expect(model.stages.find((s) => s.label === '3a')?.pump).toBe('off');
  });

  it('uses the busiest leaf sample of a stage per hour, never the sum of its processes', () => {
    const stage = model.stages.find((s) => s.label === '3a');
    const leaves = Math.max(
      a1.results.l1InfoTree?.leaves.length ?? 0,
      a2.results.l1InfoTree?.leaves.length ?? 0
    );
    expect(stage?.leavesPerHour).toBeCloseTo(leaves / 2, 6);
  });

  it('links relatively when the run is under the page directory, and shows no absolute path', () => {
    expect(html).toContain('href="run-3a-I/out/report.html"');
    expect(html).not.toContain(root);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\ssrc\s*=|<link\b|url\(|@import|fetch\s*\(/i);
    expect(html).toContain('script-src &#39;sha256-');
    expect(html).toContain('Ready wait versus wallets');
    expect(html).toContain('Distribution of 82&gt;85 ready wait per stage');
  });

  it('shows plain text, not a link, when the run is outside the page directory', async () => {
    const elsewhere = path.join(makeTempRoot(), 'c.html');
    await generateCampaignReport({
      outPath: elsewhere,
      now: NOW,
      runs: [{ label: '3a', dirs: [dirs.a1] }]
    });
    const text = fs.readFileSync(elsewhere, 'utf8');
    expect(text).not.toContain('href="');
    expect(text).not.toContain(root);
  });
});

describe('campaign with missing data', () => {
  it('says not sampled when no run sampled the L1 info tree, and handles runs without measurements', async () => {
    const root = makeTempRoot();
    const a = copyFixtureRun('run-a-fail', root, 'run-a');
    const g = copyFixtureRun('run-g', root, 'run-g');
    const outPath = path.join(root, 'c.html');
    await generateCampaignReport({
      outPath,
      now: NOW,
      runs: [
        { label: 'fail', dirs: [a] },
        { label: 'ok', dirs: [g] }
      ]
    });
    const html = fs.readFileSync(outPath, 'utf8');
    expect(html).toContain('n/a (not sampled)');
    expect(html).toContain('n/a (no measurement)');
    expect(html).toContain('class="stamp fail"');
    expect(html).toContain('FAIL (1 of 1 lap(s) failed: timeout_ready_to_claim x1)');
    expect(html).not.toContain('FAKEKEYFAKEKEY');
    const results = readJson<ResultsJson>(path.join(g, 'results.json'));
    const model = embedded(html);
    const route = Object.keys(results.hops.byRoute)[0];
    expect(
      model.stages.find((s) => s.label === 'ok')?.routes.find((r) => r.route === route)?.dist
    ).toStrictEqual(dist(readyWaits(results, route)));
  });

  it('needs at least one run', async () => {
    await expect(
      generateCampaignReport({ outPath: path.join(makeTempRoot(), 'x.html'), runs: [] })
    ).rejects.toThrow(/at least one/);
  });
});

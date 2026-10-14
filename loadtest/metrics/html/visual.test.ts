// S55: regression tests for the defects found by looking at the rendered pages
// in a headless browser (chart axes, label collisions, table width, wording).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { redactEndpointClass } from '../redactReport';
import { copyFixtureRun, makeTempRoot } from './__fixtures__/load';
import { buildSyntheticRun, writeRunDir } from './__fixtures__/synthetic';
import { generateCampaignReport } from './campaign';
import { generateRunReport } from './index';
import { hbarStack, lineChart, stripPlot } from './svg';

const NOW = (): Date => new Date('2026-10-14T12:00:00Z');
const tickLabels = (svg: string): string[] =>
  [...svg.matchAll(/<text class="ax"[^>]*text-anchor="middle"[^>]*>([^<]*)</g)].map((m) => m[1]);

describe('hbarStack integer axis', () => {
  it('never repeats a tick label for small counts', () => {
    const svg = hbarStack({
      aria: 't',
      integer: true,
      rows: [{ label: 'r', segments: [{ name: 'a', slot: 0, value: 1 }] }],
      valueFmt: (v) => String(Math.round(v))
    });
    const labels = tickLabels(svg);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toStrictEqual(['0', '1']);
  });
});

describe('lineChart minSpan', () => {
  it('scales a tiny ETH balance to its own range instead of 0..1', () => {
    const buckets = [
      { t: 0, min: 0.005, max: 0.005, mean: 0.005, n: 1 },
      { t: 60_000, min: 0.003, max: 0.003, mean: 0.003, n: 1 }
    ];
    const svg = lineChart({
      aria: 't',
      series: [{ name: 's', slot: 0, buckets }],
      xMax: 60_000,
      yFmt: (v) => v.toFixed(4),
      minSpan: 1e-6
    });
    expect(svg).not.toContain('1.0000');
    expect(svg).toMatch(/0\.00[0-9]{2}/);
  });
});

describe('stripPlot reference labels', () => {
  it('puts the reference labels above the rows, one per line', () => {
    const svg = stripPlot({
      aria: 't',
      rows: [{ label: 'r', slot: 0, points: [228_040], stats: null }],
      valueFmt: (v) => String(v),
      refLines: [
        { value: 177_166, label: 'low' },
        { value: 228_454, label: 'high' }
      ]
    });
    const ys = [...svg.matchAll(/<text class="ax thr"[^>]* y="([0-9.]+)"/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(2);
    expect(ys[0]).not.toBe(ys[1]);
    // every reference line starts below its label band
    const y1 = Number(/<line class="vline"[^>]* y1="([0-9.]+)"/.exec(svg)?.[1]);
    expect(y1).toBeGreaterThan(Math.max(...ys));
  });
});

describe('redactEndpointClass provider host', () => {
  it('shows the chain key for an old run that named the class by RPC host', () => {
    const config = {
      chains: [
        { key: 'BALI_82', rpcUrl: 'http://203.0.113.7:8545/<redacted>' },
        { key: 'BALI_85', rpcUrl: 'http://203.0.113.9:8545' }
      ]
    };
    expect(redactEndpointClass('rpc/203.0.113.7/eth_call', config)).toBe('rpc/BALI_82/eth_call');
    expect(redactEndpointClass('rpc/203.0.113.9', config)).toBe('rpc/BALI_85');
    expect(redactEndpointClass('rpc/198.51.100.1/eth_call', config)).toBe(
      'rpc/198.51.100.1/eth_call'
    );
  });
});

describe('run page wording', () => {
  const root = makeTempRoot();
  const render = async (name: string, ab: { failOne?: boolean }): Promise<string> => {
    const out = writeRunDir(root, name, buildSyntheticRun({ wallets: 2, hours: 1, ...ab }));
    const g = await generateRunReport({
      dir: out,
      outPath: path.join(root, `${name}.html`),
      now: NOW
    });
    return fs.readFileSync(g.htmlPath, 'utf8');
  };

  it('shows durations next to millisecond settings and a placeholder for empty values', async () => {
    const out = copyFixtureRun('run-g', root, 'ring-G-cfg');
    const g = await generateRunReport({ dir: out, outPath: path.join(root, 'cfg.html'), now: NOW });
    const html = fs.readFileSync(g.htmlPath, 'utf8');
    expect(html).toMatch(/timeouts\.readyToClaimMs<\/td><td[^>]*>7200000 \(2h/);
    expect(html).toContain('(empty)');
    expect(html).not.toMatch(/chains\[\d\]\.explorer<\/td><td[^>]*><\/td>/);
  });

  it('explains that a failed hop is not an error row', async () => {
    const html = await render('fail', { failOne: true });
    expect(html).toContain('A failed hop is not an error row');
  });
});

describe('campaign page', () => {
  it('keeps the runs table narrow, names stages without measurements, singular wallet', async () => {
    const root = makeTempRoot();
    const ok = writeRunDir(root, 'ok', buildSyntheticRun({ wallets: 1, hours: 1 }));
    const bare = buildSyntheticRun({ wallets: 1, hours: 1 });
    delete (bare.results as unknown as Record<string, unknown>).measurements;
    const noMeas = writeRunDir(root, 'bare', bare);
    const outPath = path.join(root, 'campaign.html');
    await generateCampaignReport({
      outPath,
      runs: [
        { label: 'G', dirs: [ok] },
        { label: 'A', dirs: [noMeas] }
      ],
      now: NOW
    });
    const html = fs.readFileSync(outPath, 'utf8');
    const runs = /<section id="runs"[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect((runs.match(/<th[ >]/g) ?? []).length).toBeLessThanOrEqual(13);
    expect(html).toContain('Not in the charts or the stage table: A');
    expect(html).toContain('G (1 wallet)');
    expect(html).not.toContain('(1 wallets)');
  });
});

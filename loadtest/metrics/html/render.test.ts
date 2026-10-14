// S54: the single-file HTML report. Covers section presence, numbers equal to
// results.json, no external request, CSP, escaping, redaction, empty states,
// the size cap and truncated logs. Fixtures are sanitized copies of real runs
// (`__fixtures__/run-g`, `run-a-fail`) plus a synthetic generator.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResultsJson } from '../report';
import type { ReportModel } from './model';

import { computeVerdict } from '../report';
import { copyFixtureRun, makeTempRoot, readJson } from './__fixtures__/load';
import { buildSyntheticRun, writeRunDir } from './__fixtures__/synthetic';
import {
  assertNoSecrets,
  generateRunReport,
  parseMeta,
  ReportSecretError,
  runNameOf
} from './index';
import { dist, fmtMsShort, buildReportModel } from './model';
import { digestFromFile } from './ndjsonDigest';
import { fmtInt, renderReportHtml, SIZE_TIER_NOTES } from './render';

const SECTION_IDS = [
  'verdict',
  'kpis',
  'throughput',
  'outcomes',
  'latency',
  'timeline',
  'gas',
  'gates',
  'errors',
  'endpoints',
  'resources',
  'pump',
  'stop',
  'wallets',
  'config',
  'environment'
];

const NOW = (): Date => new Date('2026-10-14T12:00:00Z');

const render = async (
  out: string,
  maxBytes?: number
): Promise<{ html: string; bytes: number; tier: number; notes: string[]; htmlPath: string }> => {
  const outPath = path.join(path.dirname(out), 'scratch-report.html');
  const generated = await generateRunReport({ dir: out, outPath, maxBytes, now: NOW });
  return { ...generated, html: fs.readFileSync(generated.htmlPath, 'utf8') };
};

const attr = (key: string): string => key.replace(/&/g, '&amp;').replace(/>/g, '&gt;');
const metricText = (html: string, key: string): string | undefined =>
  new RegExp(`data-metric="${attr(key)}"[^>]*>([^<]*)<`).exec(html)?.[1];
const cell = (html: string, key: string): { text: string; v: string | undefined } | undefined => {
  const m = new RegExp(`<td([^>]*)data-k="${attr(key)}"([^>]*)>([^<]*)</td>`).exec(html);
  if (m === undefined || m === null) return undefined;
  const v = /data-v="([^"]*)"/.exec(`${m[1]} ${m[2]}`)?.[1];
  return { text: m[3], v };
};
const embedded = (html: string): ReportModel => {
  const m = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error('no embedded JSON');
  return JSON.parse(m[1]) as ReportModel;
};

describe('G-derived fixture: structure and numbers', () => {
  const root = makeTempRoot();
  const out = copyFixtureRun('run-g', root, 'ring-G-test');
  const results = readJson<ResultsJson>(path.join(out, 'results.json'));
  let html = '';
  let model: ReportModel;
  it('renders', async () => {
    html = (await render(out)).html;
    model = embedded(html);
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('has every section heading', () => {
    for (const id of SECTION_IDS) {
      expect(html, id).toMatch(new RegExp(`<section id="${id}"[^>]*aria-labelledby="${id}-h"`));
      expect(html, id).toContain(`<h2 id="${id}-h"`);
    }
    expect(html).toContain('<nav class="toc"');
  });

  it('shows the strict verdict text and the run identity', () => {
    expect(html).toContain(computeVerdict(results));
    expect(html).toContain('ring-G-test');
    expect(html).toContain('PASS');
    expect(html).toContain('G · BALI_82 (82) &gt; BALI_85 (85) &gt; BALI_82 (82)');
    expect(html).toContain('Campaign go/no-go uses the stop criteria');
  });

  it('KPI numbers equal results.json', () => {
    const laps = results.laps.byOutcome;
    expect(metricText(html, 'laps.done')).toBe(String(laps.LAP_DONE));
    const hopsAll = Object.values(results.hops.byOutcome).reduce<number>(
      (sum, n) => sum + (n ?? 0),
      0
    );
    expect(metricText(html, 'hops.completed')).toBe(String(hopsAll));
    expect(metricText(html, 'rate.achieved')).toBe(
      results.achieved.steadyStateRatePerUserPerMin.toFixed(3)
    );
    const peak = Math.max(...results.resources.samples.map((s) => s.toolRssMb));
    expect(metricText(html, 'rss.peak')).toBe(`${peak.toFixed(0)} MB`);
    expect(metricText(html, 'errors.total')).toBe('0');
    expect(metricText(html, 'pump.deposits')).toBe('OFF');
    expect(metricText(html, 'l1.leaves')).toBe('n/a');
  });

  it('latency numbers equal values recomputed from results.measurements', () => {
    const hops = results.measurements?.hops ?? [];
    for (const route of Object.keys(results.hops.byRoute)) {
      const waits = hops
        .filter((h) => h.hopRoute === route && h.outcome.startsWith('hop_completed'))
        .map((h) => (h.readyObservedAt as number) - (h.bridge.minedObservedAt as number));
      const expected = dist(waits);
      expect(expected, route).not.toBeNull();
      for (const stat of ['min', 'median', 'p90', 'max'] as const) {
        const c = cell(html, `ready.${route}.${stat}`);
        expect(c?.v, `${route} ${stat}`).toBe(String(expected?.[stat]));
        expect(c?.text).toBe(fmtMsShort(expected?.[stat] as number));
      }
      expect(cell(html, `ready.${route}.n`)?.text).toBe(String(waits.length));
    }
  });

  it('claim gas rows equal results.measurements.claimGas', () => {
    for (const row of results.measurements?.claimGas ?? []) {
      const key = `gas.${row.toNetworkId}.${row.claimKind}`;
      expect(cell(html, `${key}.n`)?.text).toBe(String(row.n));
      expect(cell(html, `${key}.min`)?.text).toBe(fmtInt(row.gasUsed.min));
      expect(cell(html, `${key}.median`)?.text).toBe(fmtInt(row.gasUsed.median));
      expect(cell(html, `${key}.max`)?.text).toBe(fmtInt(row.gasUsed.max));
    }
  });

  it('states the repeat-claim gas finding and the zero first-claim case', () => {
    expect(html).toContain('177,166');
    expect(html).toContain('228,454');
    expect(html).toContain('supply nonzero');
    expect(html).toContain('inferred from gas');
    expect(html).toContain('0 (wrapper already deployed)');
  });

  it('outcome, gate and error tables equal results.json', () => {
    for (const [outcome, count] of Object.entries(results.hops.byOutcome)) {
      expect(cell(html, `outcome.all.${outcome}`)?.text).toBe(String(count));
    }
    for (const [gate, g] of Object.entries(results.gates)) {
      expect(cell(html, `gate.${gate}.hops`)?.text).toBe(String(g?.hopsEntered));
      expect(cell(html, `gate.${gate}.total`)?.v).toBe(String(g?.totalMs));
    }
    for (const [cls, count] of Object.entries(results.errors.byClass)) {
      expect(cell(html, `error.${cls}`)?.text).toBe(String(count));
    }
  });

  it('throughput table carries the requested and achieved terms', () => {
    expect(cell(html, 'throughput.lapStartsSubmitted')?.text).toBe(
      String(results.achieved.lapStartsSubmitted)
    );
    expect(cell(html, 'throughput.ticksExpected')?.text).toBe(
      String(results.achieved.ticksExpected)
    );
    expect(html).toContain('Identity check');
  });

  it('draws one timeline row per lap from the ndjson', () => {
    expect(model.timeline.mode).toBe('rows');
    expect(model.timeline.rows).toHaveLength(results.achieved.lapStartsSubmitted);
    expect(html).toContain('One row per lap, ordered by start');
  });

  it('renders SVG charts with accessible labels and native hover text', () => {
    expect(html).toContain('<svg class="chart"');
    expect(html).toMatch(/role="img" aria-label="[^"]+"/);
    expect(html).toContain('<title>');
    expect(html).toContain('class="axis-toggle"');
  });

  it('embeds a model whose figures equal the page', () => {
    expect(model.verdict.text).toBe(computeVerdict(results));
    expect(model.kpis.find((k) => k.metric === 'laps.done')?.raw).toBe(
      results.laps.byOutcome.LAP_DONE
    );
    expect(model.claimGas.rows).toHaveLength(results.measurements?.claimGas.length ?? -1);
  });
});

describe('no external requests, CSP and the one script', () => {
  const root = makeTempRoot();
  const out = copyFixtureRun('run-g', root, 'ring-G-csp');
  it('holds no network-capable construct and a matching CSP hash', async () => {
    const { html } = await render(out);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/\ssrcset\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(
      /\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(|WebSocket|sendBeacon|EventSource|<iframe|<object|<embed/i
    );
    for (const m of html.matchAll(/\shref="([^"]*)"/g))
      expect(m[1].startsWith('#'), m[1]).toBe(true);

    // The attribute is HTML-decoded by the browser before the policy is parsed.
    const csp = (
      /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
    ).replaceAll('&#39;', "'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain('img-src data:');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const plain = scripts.filter((s) => !/\btype=/.test(s[1]));
    expect(plain).toHaveLength(1);
    expect(scripts).toHaveLength(2);
    const hash = createHash('sha256').update(plain[0][2], 'utf8').digest('base64');
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  });

  it('works with JavaScript off: every section is static HTML', async () => {
    const { html } = await render(out);
    const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/g, '');
    for (const id of SECTION_IDS) expect(withoutScripts).toContain(`id="${id}-h"`);
    expect(withoutScripts).toContain('<table class="data');
    expect(withoutScripts).toContain('<svg class="chart"');
    expect(withoutScripts).toContain('@media print');
  });
});

describe('HTML injection', () => {
  const HOSTILE = '</script><img src=x onerror=alert(1)>';
  const root = makeTempRoot();
  const run = buildSyntheticRun({ wallets: 1, hours: 1, errorSample: HOSTILE });
  const out = writeRunDir(
    root,
    'run"><svg onload=alert(1)>',
    run,
    'ring="><svg onload=alert(2)> users=1'
  );
  it('renders hostile strings as escaped text only', async () => {
    const { html } = await render(out);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg onload');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html.match(/<script\b/g)?.length).toBe(2);
    const json = /id="report-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(json).not.toMatch(/[<>&]/);
    expect(JSON.stringify(embedded(html))).toContain(HOSTILE);
    expect(html.includes('"><svg onload')).toBe(false);
  });
});

describe('redaction', () => {
  // Obviously fake secret-shaped values.
  const FAKE_TOKEN = 'AbCdEf0123456789FakeTokenXyz';
  const FAKE_PASS = 'p4ssw0rdFAKE';
  const FAKE_QUERY = 'SECRETQFAKE';
  const FAKE_MNEMONIC = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
  const FAKE_PRIVATE_KEY = `0x${'deadbeef'.repeat(8)}`;
  const FAKE_FILE = '/home/someone/secret.txt';

  const seeded = (): { out: string; results: ResultsJson } => {
    const run = buildSyntheticRun({
      wallets: 2,
      hours: 1,
      errorSample: `rpc failed: URL: https://rpc.example.invalid/${FAKE_TOKEN} mnemonic ${FAKE_MNEMONIC} key ${FAKE_PRIVATE_KEY}`,
      configOverride: {
        aggkitProxyUrl: `https://user:${FAKE_PASS}@proxy.example.invalid/?apikey=${FAKE_QUERY}`,
        uiBaseUrl: `https://ui.example.invalid/${FAKE_TOKEN}`,
        users: {
          total: 2,
          browser: 0,
          wallets: { mnemonicRef: { ref: `file:${FAKE_FILE}` }, startIndex: 0 },
          funder: {
            privateKeyRef: { ref: `file:${FAKE_FILE}` },
            gasPerChain: { BALI_82: '0.005' },
            maxTotalSpend: { BALI_82: '0.2' }
          }
        },
        chains: [
          {
            key: 'BALI_82',
            chainId: 828282,
            networkId: 82,
            rpcUrl: `https://rpc.example.invalid/${FAKE_TOKEN}`,
            bridgeAddress: '0x0000000000000000000000000000000000000001',
            explorerUrl: `https://explorer.example.invalid/?key=${FAKE_QUERY}`,
            nativeSymbol: 'ETH'
          },
          {
            key: 'BALI_85',
            chainId: 858585,
            networkId: 85,
            rpcUrl: 'http://203.0.113.11:8545',
            bridgeAddress: '0x0000000000000000000000000000000000000001',
            explorerUrl: '',
            nativeSymbol: 'ETH'
          }
        ]
      }
    });
    // Endpoint class names as a pre-S53 run wrote them: the provider key is the URL's last path segment.
    run.results.http = {
      [`rpc/${FAKE_TOKEN}/eth_call`]: {
        browser: { ui: null, harness: null },
        headless: {
          ui: { n: 1, p50: 1, p90: 1, p99: 1, max: 1, byStatus: { '200': 1 }, retries: 0 },
          harness: null
        }
      }
    };
    run.results.run.abortCause = null;
    const root = makeTempRoot();
    return { out: writeRunDir(root, 'run-redact', run), results: run.results };
  };

  it('keeps every seeded secret out of the HTML', async () => {
    const { out } = seeded();
    const { html } = await render(out);
    for (const secret of [
      FAKE_TOKEN,
      FAKE_PASS,
      FAKE_QUERY,
      FAKE_MNEMONIC,
      'alpha bravo',
      FAKE_PRIVATE_KEY,
      'deadbeefdeadbeef',
      FAKE_FILE,
      '/home/someone',
      'user:p4ss'
    ]) {
      expect(html.includes(secret), `leaked: ${secret.slice(0, 6)}...`).toBe(false);
    }
    // The class names are rewritten rather than dropped.
    expect(html).toContain('rpc/BALI_82/eth_call');
    expect(html).toContain('file:secret.txt');
    expect(html).toContain('rpc.example.invalid');
    expect(html).toContain('(path/query redacted)');
  });

  it('shows RPC addresses by host only and secret refs by name', async () => {
    const { out } = seeded();
    const { html } = await render(out);
    const model = embedded(html);
    const chains = model.config.chains as { rpc: string; explorer: string }[];
    expect(chains[0].rpc).toBe(
      'https:&#47;&#47;rpc.example.invalid (path/query redacted)'.replace('&#47;&#47;', '//')
    );
    expect(chains[1].rpc).toBe('http://203.0.113.11:8545');
    const users = model.config.users as { wallets: { ref: string } };
    expect(users.wallets.ref).toBe('file:secret.txt');
  });

  it('assertNoSecrets refuses a leak and never names the value', () => {
    const config = {
      chains: [{ key: 'A', rpcUrl: `https://rpc.example.invalid/${FAKE_TOKEN}` }],
      aggkitProxyUrl: `https://u:${FAKE_PASS}@h.example.invalid/?k=${FAKE_QUERY}`
    };
    for (const leak of [FAKE_TOKEN, FAKE_PASS, FAKE_QUERY]) {
      let message = '';
      try {
        assertNoSecrets(`<p>${leak}</p>`, config);
      } catch (error) {
        expect(error).toBeInstanceOf(ReportSecretError);
        message = (error as Error).message;
      }
      expect(message).toContain('config.');
      expect(message).not.toContain(leak);
    }
    expect(() => assertNoSecrets(`<td>${FAKE_PRIVATE_KEY}</td>`, config)).toThrow(
      /64-character hex/
    );
    expect(() => assertNoSecrets('<p>clean</p>', config, { text: FAKE_MNEMONIC })).toThrow(
      /mnemonic/
    );
    expect(() =>
      assertNoSecrets('<p>clean</p>', config, { text: 'a short sentence of plain words' })
    ).not.toThrow();
  });

  it('refuses to write the file when the HTML would hold a secret', async () => {
    const run = buildSyntheticRun({ wallets: 1, hours: 1 });
    // A secret that only exists in the unredacted config AND is printed through a path the allowlist missed:
    // the run directory name is shown verbatim, so name the directory after the token.
    const root = makeTempRoot();
    (run.results.config as { chains: { rpcUrl: string }[] }).chains[0].rpcUrl =
      `https://rpc.example.invalid/${FAKE_TOKEN}`;
    const out = writeRunDir(root, `run-${FAKE_TOKEN}`, run);
    await expect(
      generateRunReport({ dir: out, outPath: path.join(root, 'r.html') })
    ).rejects.toThrow(/refused/);
    expect(fs.existsSync(path.join(root, 'r.html'))).toBe(false);
  });
});

describe('A-shaped FAIL fixture (no measurements, keyed config)', () => {
  const root = makeTempRoot();
  const out = copyFixtureRun('run-a-fail', root, 'ring-A-test');
  const results = readJson<ResultsJson>(path.join(out, 'results.json'));
  it('renders a red FAIL banner with the failure and the empty states', async () => {
    const { html } = await render(out);
    expect(html).toContain('class="stamp fail"');
    expect(html).toContain('FAIL (1 of 1 lap(s) failed: timeout_ready_to_claim x1)');
    expect(html).toContain('Lap failure rate <b>100.0%</b>');
    expect(html).toContain('Claim gas not recorded');
    expect(html).toContain('Per-hop measurements were not recorded');
    expect(html).toContain('nearest rank');
    expect(html).toContain('min is not recorded'.replace('min', 'minimum'));
    expect(cell(html, 'gate.claim-proof.hops')).toBeDefined();
    const timedOut = results.gates['claim-proof']?.timedOutVisits;
    expect(timedOut).toBe(1);
    const model = embedded(html);
    expect(model.timeline.rows.some((r) => r.failed)).toBe(true);
    expect(model.timeline.rows.flatMap((r) => r.segments).some((s) => s.slot === 'crit')).toBe(
      true
    );
    for (const id of SECTION_IDS) expect(html).toContain(`id="${id}-h"`);
  });

  it('drops the keyed endpoint names and the key itself', async () => {
    const { html } = await render(out);
    expect(html).not.toContain('FAKEKEYFAKEKEY');
    expect(html).toContain('rpc/SEPOLIA/');
    expect(html).not.toContain('tenderly');
  });
});

describe('empty and degenerate runs', () => {
  const synth = (mutate: (r: ResultsJson) => void, options: { ndjson?: boolean } = {}): string => {
    const run = buildSyntheticRun({ wallets: 1, hours: 1 });
    mutate(run.results);
    const root = makeTempRoot();
    const out = writeRunDir(root, 'run-x', run);
    if (options.ndjson === false) fs.rmSync(path.join(out, 'activity.ndjson'));
    return out;
  };

  it('aborted run shows ABORTED with the cause and the laps in flight', async () => {
    const out = synth((r) => {
      r.run.aborted = true;
      r.run.abortCause = 'sigint';
      r.run.lapsInFlightAtStop = 3;
    });
    const { html } = await render(out);
    expect(html).toContain('class="stamp aborted"');
    expect(html).toContain('ABORTED (sigint)');
    expect(html).toContain('Laps in flight at stop <b>3</b>');
  });

  it('a run with no laps started says so and every section still has a heading', async () => {
    const out = synth(
      (r) => {
        r.achieved.lapStartsSubmitted = 0;
        r.laps.byOutcome = { LAP_DONE: 0, LAP_FAILED: 0, LAP_ABORTED: 0 };
        r.hops.byOutcome = {};
        r.hops.byRoute = {};
        r.hops.byRouteMode = {};
        delete r.measurements;
        r.gates = {};
        r.errors = { byClass: {}, top: [], suppressed: { notReady: 0, benignExternalAsset: 0 } };
      },
      { ndjson: false }
    );
    const { html } = await render(out);
    expect(html).toContain('NO LAPS STARTED');
    expect(html).toContain('class="stamp nolaps"');
    expect(html).toContain('No laps started: there is no achieved rate to compare.');
    expect(html).toContain('No hops recorded.');
    expect(html).toContain('No gate visits.');
    expect(html).toContain('No errors recorded.');
    expect(html).toContain('activity.ndjson not found');
    for (const id of SECTION_IDS) expect(html).toContain(`id="${id}-h"`);
  });

  it('a run that never started (init failure) is labelled', async () => {
    const out = synth(
      (r) => {
        r.run.startedAt = null;
        r.run.endedAt = null;
        r.run.durationMs = null;
        r.achieved.lapStartsSubmitted = 0;
        delete r.measurements;
      },
      { ndjson: false }
    );
    const { html } = await render(out);
    expect(html).toContain('Run never started');
    for (const id of SECTION_IDS) expect(html).toContain(`id="${id}-h"`);
  });

  it('without a measurement block the latency section falls back to phases and the gas section says why', async () => {
    const out = synth((r) => {
      delete r.measurements;
    });
    const { html } = await render(out);
    expect(html).toContain('Per-hop measurements were not recorded');
    expect(html).toContain('Claim gas not recorded');
  });

  it('without ndjson the timeline, wallets and error time series show empty states', async () => {
    const out = synth(() => undefined, { ndjson: false });
    const { html } = await render(out);
    expect(html).toContain('activity.ndjson not found');
    expect(html).toContain('No per-wallet activity');
    expect(html).toContain('Errors over time needs activity.ndjson');
    expect(html).toContain('not found');
  });

  it('no pump block reads as OFF and still reports the L1 leaves', async () => {
    const { html } = await render(synth(() => undefined));
    expect(html).toContain('PUMP OFF');
    expect(html).toContain('Pump: OFF (not configured).');
    expect(html).toContain('from other sources');
  });
});

describe('pump, wallets and heavy-load blocks', () => {
  const root = makeTempRoot();
  const run = buildSyntheticRun({ wallets: 5, hours: 2, pump: true, failOne: true });
  const out = writeRunDir(root, 'run-pump', run);
  it('renders the pump, balances, leaves and http windows', async () => {
    const { html } = await render(out);
    const deposits = run.results.pump?.deposits.length ?? 0;
    expect(html).toContain('PUMP ON');
    expect(metricText(html, 'pump.deposits')).toBe(String(deposits));
    expect(html).toContain('Spend versus cap');
    expect(html).toContain('class="meterbar"');
    expect((html.match(/<td class="mono">0x[0-9a-f]{8}…[0-9a-f]{8}<\/td>/g) ?? []).length).toBe(
      deposits
    );
    expect(html).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(metricText(html, 'l1.leaves')).toBe(String(run.results.l1InfoTree?.leaves.length));
    expect(html).toContain('from the pump');
    expect(html).toContain('SC9 floor');
    expect(html).toContain('p90 latency per window');
    expect(html).toContain('lowest wallet');
    expect(html).toContain('Error responses per window');
    const model = embedded(html);
    expect(model.wallets.rows).toHaveLength(5);
    expect(model.wallets.rows[0]).toMatchObject({ userId: 'u0', walletIndex: 200 });
    expect(model.verdict.level).toBe('fail');
    expect(model.stop.find((c) => c.id === 'SC11')?.fired).toBe(false);
  });
});

describe('size cap and downsampling (50 wallets, 5 hours)', () => {
  const root = makeTempRoot();
  const run = buildSyntheticRun({ wallets: 50, hours: 5, pump: true, lapEveryMin: 20 });
  const out = writeRunDir(root, 'run-big', run);

  it('stays under the 2 MB target with the default cap and bounds every series', async () => {
    const t0 = Date.now();
    const generated = await render(out);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(run.ndjson.length).toBeGreaterThan(3_000_000);
    expect(generated.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(generated.tier).toBe(0);
    const model = embedded(generated.html);
    expect(model.timeline.mode).toBe('area');
    expect(model.timeline.rows.length).toBeLessThanOrEqual(200);
    for (const series of [model.resources.rss, model.resources.cpu, model.resources.eventLoop]) {
      expect(series.length).toBeLessThanOrEqual(720);
    }
    // the one-sample event-loop spike (400 ms extra) survives the bucketing
    expect(Math.max(...model.resources.eventLoop.map((b) => b.max))).toBeGreaterThan(400);
    expect(model.wallets.totalWallets).toBe(50);
  });

  it('drops tiers in the stated order when over the cap, lists them, and never changes a statistic', async () => {
    const full = await render(out);
    const sizes = [0, 1, 2, 3].map((tier) => {
      const analysed = renderReportHtml(embedded(full.html), { tier });
      return analysed.bytes;
    });
    expect(sizes[1]).toBeLessThan(sizes[0]);
    expect(sizes[2]).toBeLessThanOrEqual(sizes[1]);
    expect(sizes[3]).toBeLessThan(sizes[2]);

    const capped = await render(out, 200_000);
    expect(capped.tier).toBe(3);
    expect(capped.notes).toStrictEqual(SIZE_TIER_NOTES);
    for (const note of SIZE_TIER_NOTES) expect(capped.html).toContain(note);
    expect(capped.html).toContain('Size cap applied.');
    for (const route of ['BALI_82->BALI_85', 'BALI_85->BALI_82']) {
      expect(cell(capped.html, `ready.${route}.p90`)).toStrictEqual(
        cell(full.html, `ready.${route}.p90`)
      );
    }
    expect(metricText(capped.html, 'laps.done')).toBe(metricText(full.html, 'laps.done'));
    const trimmed = embedded(capped.html);
    expect(trimmed.latency.routes.every((r) => r.points.ready.length === 0)).toBe(true);
    expect(trimmed.timeline.rows).toHaveLength(0);
  });

  it('applies the first tier only when that is enough', async () => {
    const full = await render(out);
    const oneStepCap = renderReportHtml(embedded(full.html), { tier: 1 }).bytes + 1;
    const generated = await render(out, oneStepCap);
    expect(generated.tier).toBeLessThanOrEqual(1);
  });
});

describe('truncated and malformed ndjson', () => {
  it('renders from a cut log and says so', async () => {
    const root = makeTempRoot();
    const out = copyFixtureRun('run-g', root, 'ring-G-cut');
    const file = path.join(out, 'activity.ndjson');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${text.slice(0, text.length - 40)}`);
    const { html } = await render(out);
    expect(html).toContain('last line truncated');
    const digest = await digestFromFile(file);
    expect(digest.truncatedTail).toBe(true);
    for (const id of SECTION_IDS) expect(html).toContain(`id="${id}-h"`);
  });
});

describe('model and helpers', () => {
  it('buildReportModel is pure: the same inputs give the same model', async () => {
    const root = makeTempRoot();
    const out = copyFixtureRun('run-g', root, 'ring-G-pure');
    const results = readJson<ResultsJson>(path.join(out, 'results.json'));
    const digest = await digestFromFile(path.join(out, 'activity.ndjson'));
    const input = { results, digest, meta: {}, runName: 'x', generatedAt: '2026-10-14T00:00:00Z' };
    expect(buildReportModel(input)).toStrictEqual(buildReportModel(input));
  });

  it('dist gives min, true median, nearest-rank p90 and max', () => {
    expect(dist([])).toBeNull();
    expect(dist([5, 1, 3, 2])).toStrictEqual({ n: 4, min: 1, median: 2.5, p90: 5, max: 5 });
  });

  it('parseMeta reads only the known keys', () => {
    expect(
      parseMeta('ring=G users=1 minutes=50 rate=0.2 check=0 dev-ui=feat/x@abc123 secret=hunter2')
    ).toStrictEqual({
      ring: 'G',
      users: '1',
      minutes: '50',
      rate: '0.2',
      devUi: 'feat/x@abc123'
    });
  });

  it('runNameOf shows the run directory, never an absolute path', () => {
    expect(runNameOf('/a/b/ring-G-1/out')).toBe('ring-G-1');
    expect(runNameOf('/a/b/ring-G-1')).toBe('ring-G-1');
  });

  it('generateRunReport writes only where asked and leaves the run directory untouched', async () => {
    const root = makeTempRoot();
    const out = copyFixtureRun('run-g', root, 'ring-G-keep');
    const before = fs.readdirSync(out).sort();
    const target = path.join(root, 'elsewhere', 'r.html');
    const generated = await generateRunReport({ dir: out, outPath: target, now: NOW });
    expect(generated.htmlPath).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(out).sort()).toStrictEqual(before);
    const defaultPath = await generateRunReport({ dir: out, now: NOW });
    expect(defaultPath.htmlPath).toBe(path.join(out, 'report.html'));
  });

  it('the report is deterministic for a fixed clock', async () => {
    const root = makeTempRoot();
    const out = copyFixtureRun('run-g', root, 'ring-G-det');
    const a = await render(out);
    const b = await render(out);
    expect(a.html).toBe(b.html);
  });
});

describe('page text', () => {
  it('holds no run of lowercase words that reads like a mnemonic, so an outside scan stays clean', async () => {
    const root = makeTempRoot();
    const pages = [
      await render(copyFixtureRun('run-g', root, 'ring-G-prose')),
      await render(copyFixtureRun('run-a-fail', root, 'ring-A-prose')),
      await render(
        writeRunDir(
          root,
          'run-pump-prose',
          buildSyntheticRun({ wallets: 3, hours: 2, pump: true, failOne: true })
        )
      )
    ];
    for (const { html } of pages) {
      const text = html.replace(/<script\b[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ');
      expect(text).not.toMatch(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/);
    }
  });
});

// Entry points of the HTML report (S54): render one run directory, and the
// write-time secret scan (heavy-load design §5.2 rule 8).
import fs from 'node:fs';
import path from 'node:path';

import type { ResultsJson } from '../report';
import type { RunMeta } from './model';

import { buildReportModel } from './model';
import { digestFromFile } from './ndjsonDigest';
import { renderReportHtml, SIZE_TIER_NOTES } from './render';

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export class ReportSecretError extends Error {}

/** Parses the workspace runner's `meta.txt` (`ring=G users=1 minutes=50 rate=0.2 ... dev-ui=...`); only these keys are read. */
export const parseMeta = (text: string): RunMeta => {
  const out: RunMeta = {};
  for (const token of text.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (value === '' || value.length > 120) continue;
    if (key === 'ring') out.ring = value;
    else if (key === 'users') out.users = value;
    else if (key === 'minutes') out.minutes = value;
    else if (key === 'rate') out.rate = value;
    else if (key === 'dev-ui') out.devUi = value;
  }
  return out;
};

/** Name shown for a run: the run directory, or its parent when the directory is the `out` folder. No absolute path. */
export const runNameOf = (dir: string): string => {
  const abs = path.resolve(dir);
  const base = path.basename(abs);
  return base === 'out' ? path.basename(path.dirname(abs)) : base;
};

const URL_FIELDS = ['rpcUrl', 'explorerUrl', 'aggkitProxyUrl', 'uiBaseUrl'];

/** Strings from the UNREDACTED config that must never appear in the HTML: path segments, userinfo and query values of its URLs. */
const secretNeedles = (config: unknown): { field: string; needle: string }[] => {
  const needles: { field: string; needle: string }[] = [];
  const visit = (value: unknown, pathParts: string[]): void => {
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...pathParts, String(i)]));
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        visit(v, [...pathParts, k]);
    } else if (typeof value === 'string' && URL_FIELDS.includes(pathParts[pathParts.length - 1])) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      const field = `config.${pathParts.join('.')}`;
      const isRpc = pathParts[pathParts.length - 1] === 'rpcUrl';
      for (const seg of url.pathname.split('/').filter(Boolean)) {
        if (seg === '<redacted>') continue;
        if (isRpc ? seg.length > 8 : seg.length >= 16) needles.push({ field, needle: seg });
      }
      // Short userinfo or query values (`user`, `true`, `1`) would match ordinary page text, so only values of
      // six or more characters are needles on their own; the whole `user:password` pair always is.
      const user = decodeURIComponent(url.username);
      const pass = decodeURIComponent(url.password);
      if (user !== '' || pass !== '')
        needles.push({ field, needle: pass === '' ? user : `${user}:${pass}` });
      for (const value of [user, pass])
        if (value.length >= 6) needles.push({ field, needle: value });
      for (const [, v] of url.searchParams) if (v.length >= 6) needles.push({ field, needle: v });
    }
  };
  visit(config, []);
  return needles;
};

const HEX64 = /0x[0-9a-fA-F]{64}/;
const BARE_HEX64 = /\b[0-9a-fA-F]{64}\b/;
const MNEMONIC = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;

const anyStringMatches = (value: unknown, pattern: RegExp): boolean => {
  if (typeof value === 'string') return pattern.test(value);
  if (Array.isArray(value)) return value.some((v) => anyStringMatches(v, pattern));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      anyStringMatches(v, pattern)
    );
  }
  return false;
};

/**
 * Throws `ReportSecretError` (naming the field or kind, never the value) when the HTML holds a secret.
 * The mnemonic heuristic is applied to the data strings of the model, one string at a time: the page's
 * own explanatory prose is ordinary lowercase words and would trip it.
 */
export const assertNoSecrets = (html: string, unredactedConfig: unknown, model?: unknown): void => {
  for (const { field, needle } of secretNeedles(unredactedConfig)) {
    if (html.includes(needle)) {
      throw new ReportSecretError(`report refused: the HTML contains a value taken from ${field}`);
    }
  }
  // A transaction hash is 0x + 64 hex and is legitimate in the report only when abbreviated; no full 64-hex run may remain.
  if (HEX64.test(html) || BARE_HEX64.test(html)) {
    throw new ReportSecretError(
      'report refused: the HTML contains a 64-character hex string (private key shape)'
    );
  }
  if (model !== undefined && anyStringMatches(model, MNEMONIC)) {
    throw new ReportSecretError('report refused: the HTML contains a mnemonic-shaped run of words');
  }
};

export interface GenerateRunReportOptions {
  /** The run's `out` directory: `results.json` required, `activity.ndjson` optional. */
  dir: string;
  /** Where to write; defaults to `<dir>/report.html`. */
  outPath?: string;
  maxBytes?: number;
  now?: () => Date;
}

export interface GeneratedReport {
  htmlPath: string;
  bytes: number;
  tier: number;
  notes: string[];
}

export const loadResults = (dir: string): ResultsJson =>
  JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) as ResultsJson;

/** Renders one run directory to a report file. Throws when `results.json` is missing or the scan finds a secret. */
export const generateRunReport = async (
  options: GenerateRunReportOptions
): Promise<GeneratedReport> => {
  const dir = path.resolve(options.dir);
  const results = loadResults(dir);
  const digest = await digestFromFile(path.join(dir, 'activity.ndjson'));
  const metaPath = path.join(dir, '..', 'meta.txt');
  const meta = fs.existsSync(metaPath) ? parseMeta(fs.readFileSync(metaPath, 'utf8')) : {};
  const model = buildReportModel({
    results,
    digest,
    meta,
    runName: runNameOf(dir),
    generatedAt: (options.now ?? (() => new Date()))().toISOString()
  });
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let rendered = renderReportHtml(model, { tier: 0 });
  for (let tier = 1; rendered.bytes > maxBytes && tier <= SIZE_TIER_NOTES.length; tier += 1) {
    rendered = renderReportHtml(model, { tier });
  }
  assertNoSecrets(rendered.html, results.config, model);
  const htmlPath =
    options.outPath === undefined ? path.join(dir, 'report.html') : path.resolve(options.outPath);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, rendered.html);
  return { htmlPath, bytes: rendered.bytes, tier: rendered.tier, notes: rendered.notes };
};

/**
 * Called by `pnpm loadtest run` in a `finally`, so it must never throw: it writes
 * `<outDir>/report.html` when this run wrote a `results.json` (a stale one from an
 * earlier run into the same directory is not rendered), reports the path through
 * `log`, and turns any failure into a `warn` line (already redacted by the caller's
 * `redact`), leaving the run's own outcome alone.
 */
export const renderReportAfterRun = async (options: {
  outDir: string;
  runStartedAtMs: number;
  log: (line: string) => void;
  warn: (line: string) => void;
  redact: (error: unknown) => string;
  relativeTo?: string;
}): Promise<GeneratedReport | null> => {
  const resultsPath = path.join(options.outDir, 'results.json');
  try {
    if (
      !fs.existsSync(resultsPath) ||
      fs.statSync(resultsPath).mtimeMs < options.runStartedAtMs - 1000
    ) {
      options.log('report: no results.json written by this run, no HTML report');
      return null;
    }
    const generated = await generateRunReport({ dir: options.outDir });
    const shown = path.relative(options.relativeTo ?? process.cwd(), generated.htmlPath);
    options.log(
      `report: ${shown} (${generated.bytes} bytes${generated.notes.length > 0 ? `, size cap applied: ${generated.notes.length} step(s)` : ''})`
    );
    return generated;
  } catch (error) {
    options.warn(`report: HTML report failed: ${options.redact(error)}`);
    return null;
  }
};

// Reads `activity.ndjson` (DESIGN §6.2 — collector.ts's ONLY writer) to
// recover a per-asset-kind / per-mode breakdown of lap outcomes.
//
// Why this exists: `results.json`'s `laps.byOutcome` and `hops.byOutcome`
// (metrics/collector.ts, metrics/report.ts) are aggregated across every
// active asset — there is no per-asset dimension in that summary. The plan
// asked for "≥1 completed lap per asset per mode", which isn't answerable
// from `results.json` alone. It IS answerable from `activity.ndjson`
// without touching any production module: every `lap_end`/`hop_end` line
// already carries `mode` directly and an asset index encoded in `lapId`
// (`core/ring.ts`'s `createLap`: `` `${userId}:a${assetIndex}:l${lapIndex}` ``).
// This module just parses that, unmodified, already-shipped log format.
import fs from 'node:fs';

import type { AssetKind } from '../../loadtest/core/types';
import type { DriverMode } from '../../loadtest/core/userDriver';

const LAP_ID_ASSET_INDEX = /^[^:]+:a(\d+):/;

interface ActivityLine {
  kind: string;
  mode: DriverMode | null;
  lapId?: string;
  outcome?: string;
}

const parseAssetIndex = (lapId: string): number | null => {
  const match = LAP_ID_ASSET_INDEX.exec(lapId);
  if (match === null) return null;
  return Number.parseInt(match[1], 10);
};

export interface PerCategoryCounts {
  [outcome: string]: number;
}

// Keyed "<assetKind>/<mode>", e.g. "eth/browser" -> { LAP_DONE: 2, ... }.
export type LapBreakdown = Record<string, PerCategoryCounts>;

export const summarizeLapsByAssetAndMode = (
  activityNdjsonPath: string,
  assetKindByIndex: readonly AssetKind[]
): LapBreakdown => {
  const breakdown: LapBreakdown = {};
  const raw = fs.readFileSync(activityNdjsonPath, 'utf8');

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as ActivityLine;
    if (parsed.kind !== 'lap_end' || parsed.mode === null || parsed.lapId === undefined) continue;

    const assetIndex = parseAssetIndex(parsed.lapId);
    if (assetIndex === null) continue;
    const assetKind = assetKindByIndex[assetIndex] ?? `asset[${assetIndex}]`;

    const key = `${assetKind}/${parsed.mode}`;
    const counts = (breakdown[key] ??= {});
    const outcome = parsed.outcome ?? 'unknown';
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }

  return breakdown;
};

// S27 (plans/bridge-loadtest-plan.md §7): the hop-level counterpart of
// `summarizeLapsByAssetAndMode` above — same log, same `hop_end`/`mode`
// fields (`metrics/collector.ts`'s `hopEnd()` writes `mode` and `outcome`
// on every line exactly like `lapEnd()` does), just grouped by `mode` alone
// (no per-asset split needed here) so `run.spec.ts` can hard-assert that at
// least one HOP — not just a lap, and not just an HTTP request — actually
// completed in EACH mode. This is what closes the gap the plan calls out:
// pre-S27, the only browser-mode assertion was `activity?.browser.ui?.n > 0`
// (an HTTP request COUNT), which stayed true even while browser mode
// completed ~2% of its laps and, by extension, nearly none of its hops.
export const summarizeHopsByMode = (
  activityNdjsonPath: string
): Record<DriverMode, PerCategoryCounts> => {
  const breakdown: Record<DriverMode, PerCategoryCounts> = { browser: {}, headless: {} };
  const raw = fs.readFileSync(activityNdjsonPath, 'utf8');

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as ActivityLine;
    if (parsed.kind !== 'hop_end' || parsed.mode === null) continue;

    const counts = breakdown[parsed.mode];
    const outcome = parsed.outcome ?? 'unknown';
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }

  return breakdown;
};

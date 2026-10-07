// S30 (plans/bridge-loadtest-plan.md §7/§8) — closes the structural blind
// spot S27's e2e (`run.spec.ts`) left, recorded in that step's own outcome:
//
//   1. `run.spec.ts` shortens the ring to `L1 -> L2A -> L1` (2 hops) so it
//      fits a nightly-CI-sized wall clock. That ring structurally NEVER
//      exercises `L2A->L2B` or `L2B->L1` — the exact hop where S26 measured
//      headless failing 38.6% (`rpc_error`, "replacement transaction
//      underpriced" — same-EOA nonce collisions, S29's finding) and where
//      S25 fixed browser's UI-serialization collapse.
//   2. Even where `run.spec.ts` DOES have a route (`L1->L2A`, `L2A->L1`),
//      its `--rate 1 --minutes 2` config structurally produces only ~2
//      attempted laps per mode. A 50% floor over n=2 catches COLLAPSE
//      (~2%) but not DEGRADATION (a hop quietly running at 60% instead of
//      95%+ still clears a floor built for n=2).
//
// ---------------------------------------------------------------------------
// COVERAGE-DESIGN DECISION (do this, and why, over the other two options)
// ---------------------------------------------------------------------------
//
// Three ways to close this were on the table:
//   (a) extend `run.spec.ts`'s OWN ring to the full 3 hops;
//   (b) add a second, longer-ring Playwright PROJECT (i.e. a second entry
//       in `playwright.loadtest.config.ts`'s `projects` array);
//   (c) add a second spec FILE, reusing the same project, that runs the
//       tool's normal (unshortened) 3-hop ring and asserts on its own
//       `results.json`.
//
// This file is (c). Reasons, in order of weight:
//   - (a) is ruled out by `run.spec.ts`'s own doc comment: the full 3-hop
//     ring's `L2A->L2B` hop measured 87s idle up to >900s under just 6
//     concurrent users in THIS session, so a `--minutes 2` run asserting on
//     it would be flaky-to-impossible, and widening the ring would defeat
//     the entire reason that file is cheap enough to want to keep passing
//     quickly. The two specs answer genuinely different questions at
//     genuinely different price points; conflating them makes both worse.
//   - (b) buys nothing over (c) here: a Playwright "project" mainly earns
//     its keep when specs need different `use` options (different browser,
//     different base URL, different device). This suite doesn't use the
//     `page` fixture at all (see `playwright.loadtest.config.ts`'s doc
//     comment) — both specs shell out to the same `pnpm loadtest` CLI and
//     assert on the same `results.json` shape. A second file in the SAME
//     project (already configured `fullyParallel: false, workers: 1`, so it
//     runs strictly after `run.spec.ts` rather than racing it for the
//     compose devnet) gets identical isolation for zero extra config.
//   - A separate `results.json` from a full-ring `run` (the third option,
//     read literally) is what this file's own `run` step produces anyway —
//     there's no meaningful difference between "assert on a full-ring run's
//     results.json" and "a second spec that produces and asserts on one";
//     (c) IS that option, just wired into the existing harness
//     (`runCli.ts`) instead of a bespoke one-off script.
//
// Runtime being committed to: this is NOT cheap. `deriveDevnetConfig()`'s
// default ring already IS the tool's normal `L1 -> L2A -> L2B -> L1` (3
// hops) — nothing needs shortening here, only the wallet start index moves
// (see `deriveFullRingE2eConfig.ts`). The config below
// (`--users 6 --browser 2 --rate 2 --minutes 15`) is the SAME "reliable
// configuration" PR #41 documents as its tooling-validation baseline, and
// two real runs of it this session (`loadtest-results/s28-run1`,
// `s28-run2` — see the threshold derivation below) took ~18 and ~15
// minutes wall-clock. Budgeted here at up to 90 minutes for the `run` step
// alone (a stuck manual-claim hop can occupy the derived `hopMs`/`lapMs`
// budget before its own timeout fires) — see `.github/workflows/
// loadtest-e2e.yaml`'s `timeout-minutes`, raised alongside this file so the
// nightly job isn't cut off before a legitimately slow (not stuck) run
// finishes.
//
// Certificate-window safety (finding C1, `loadtest-results/` capacity
// probes referenced throughout this plan section): C1 wedges the prover
// above ~126 exits even on an idle host. This config's steady-state lap
// starts (`--users 6 --rate 2`) are 12 lap-starts/minute at full
// throughput, i.e. ~60 in ANY rolling 5-minute window — well under 100,
// and matches the exact shape S28 already ran clean (`latest_certificate_
// in_error` 0 before/during/after).
//
// ---------------------------------------------------------------------------
// THRESHOLD DERIVATION — measured post-fix rates, not invented
// ---------------------------------------------------------------------------
//
// All figures below come from real full-3-hop-ring runs already on record
// in this plan (plans/bridge-loadtest-plan.md §7/§8, S28/S29 outcomes),
// recomputed here to the finer (per-ROUTE, per-MODE, HOP-level) grain this
// gate needs — the plan's own headline figures are lap-level, which is one
// grain coarser (a lap needs all 3 hops to succeed, so lap-level and
// `L2B->L1` hop-level nearly coincide once `L1->L2A`/`L2A->L2B` are healthy,
// but this gate reads the hop-level number directly rather than inferring
// it):
//
//   Route `L2B->L1` (the hop S25 fixed for browser and S29 fixed for
//   headless — the one this whole step exists to cover):
//     - browser, post-S25 fix:      100% (36/36, S28 run 1) and 87.5%
//       (42/48, S28 run 2) — the plan's cited 94.7%/84.0% ARE these two
//       runs' LAP-level completion rates; S25 was not touched again since,
//       so these hop-level numbers are still the current code path.
//     - headless, PRE-S29 fix:      61.2% (52/85) and 62.1% (18/29) in
//       those same two runs — this is the degraded-but-not-collapsed state
//       S29 fixed (its root cause: same-EOA nonce collisions,
//       "replacement transaction underpriced").
//     - headless, POST-S29 fix:     100% (87/87, S29's `s29-postfix`
//       isolated full-ring run, `--browser 0`) — the fix eliminated the
//       `rpc_error` class entirely on this exact route.
//   Floor chosen: **75%** for BOTH modes on `L2B->L1`. It sits at the
//   midpoint of the pre-fix headless band (61–62%) and every post-fix
//   measurement (84.0/87.5/94.7/100%): comfortably below every known-good
//   sample (12.5+ points of headroom against the worst of them, 87.5%) and
//   comfortably above the pre-fix degraded state (13+ points), so a
//   regression back toward EITHER the old browser-collapse shape or the old
//   headless-nonce-collision shape fails this gate, while a single
//   flaky-but-tolerated hop (the same `ui_assertion`/`internal` UI-timeout
//   class `run.spec.ts` already declines to hard-assert to zero) does not.
//
//   Routes `L1->L2A` and `L2A->L2B`: neither was ever the SUBJECT of a
//   regression this session — every measured sample across S25/S26/S28/S29
//   sits at ~98–100% (e.g. S28 run 1: 122/123 and 121/122 non-error hops).
//   There is no post-fix/pre-fix band to split for these routes the way
//   `L2B->L1` has one, so this gate reuses S27's already-justified 50%
//   floor verbatim rather than inventing a number these routes' own history
//   doesn't support — 50% still catches an outright collapse on either
//   route (the ~2%/~39% failure shapes this whole plan section fixed) while
//   never having come close to firing on any healthy run.
//
// Every (route, mode) pair also gets a structural "attempted > 0" check —
// same rule S27 applied to per-mode laps (DESIGN §5.5 invariant 5: a
// `completionRate` of `null`, from zero attempts, must never be silently
// read as "passing"). For `L2B->L1` specifically, THIS is the assertion
// that proves the hop was genuinely exercised in both modes rather than
// skipped by a shortened ring — the failure this whole file exists to make
// impossible again.
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import type { DriverMode } from '../../loadtest/core/userDriver';
import type { ResultsJson } from '../../loadtest/metrics/report';

import { serializeLoadtestConfig } from '../../loadtest/config/schema';
import { buildFullRingE2eConfig } from './deriveFullRingE2eConfig';
import { runCliOrThrow } from './runCli';

// See run.spec.ts's identical comment: this file is compiled to CJS by
// Playwright's require-hook transform, so plain `__dirname` is the correct
// (and only working) choice here, not `import.meta.url`.
const REPO_ROOT = path.resolve(__dirname, '../..');

const WORK_DIR = path.join(REPO_ROOT, 'loadtest-results/loadtest-e2e-fullring');
const CONFIG_PATH = path.join(WORK_DIR, 'loadtest.config.json');
const OUT_DIR = path.join(WORK_DIR, 'run');

const REQUIRED_ENV_VARS = ['LOADTEST_DEVNET_FUNDER_KEY', 'LOADTEST_MNEMONIC'] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The three routes the tool's normal (unshortened) devnet ring produces —
// `deriveDevnetConfig()`'s ring is `L1 -> L2A -> L2B -> L1`.
const ALL_ROUTES = ['L1->L2A', 'L2A->L2B', 'L2B->L1'] as const;

// Per-(route, mode) completion floor — see this file's top-of-file doc
// comment for the full derivation. `L2B->L1` gets the tight, evidence-based
// 75% floor; the other two routes reuse S27's already-justified 50% floor.
const HOP_COMPLETION_THRESHOLD: Record<(typeof ALL_ROUTES)[number], number> = {
  'L1->L2A': 0.5,
  'L2A->L2B': 0.5,
  'L2B->L1': 0.75
};

test.describe('loadtest tool E2E — full 3-hop ring, per-route x per-mode reliability gate', () => {
  test.beforeAll(() => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `missing required env var(s): ${missing.join(', ')} — see run.spec.ts's top-of-file doc ` +
          'comment for the export commands (also: plans/bridge-loadtest-plan.md S13/S30).'
      );
    }
  });

  test('derive (full ring) -> fund -> preflight -> run -> assert per-route x per-mode hop reliability', async () => {
    // See this file's top-of-file "runtime being committed to" section for
    // why this budget is so much larger than run.spec.ts's.
    test.setTimeout(100 * 60 * 1000);

    const cliEnv = process.env;

    // --- 1. derive the FULL 3-hop devnet config (no ring-shortening) -----
    const { config } = buildFullRingE2eConfig(REPO_ROOT);
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${serializeLoadtestConfig(config)}\n`);

    // --- 2. fund 6 wallets (the real `pnpm loadtest fund` CLI) ------------
    await runCliOrThrow(['fund', CONFIG_PATH, '--users', '6'], {
      cwd: REPO_ROOT,
      env: cliEnv,
      timeoutMs: 3 * 60 * 1000,
      label: '[fund]'
    });

    // --- 3. preflight, tolerating the same documented transient
    // fund->preflight race run.spec.ts tolerates (S24's "Two observations
    // carried to S13/S14"). ------------------------------------------------
    let preflightError: unknown;
    const PREFLIGHT_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt += 1) {
      try {
        await runCliOrThrow(['preflight', CONFIG_PATH, '--users', '6'], {
          cwd: REPO_ROOT,
          env: cliEnv,
          timeoutMs: 60 * 1000,
          label: `[preflight attempt ${attempt}]`
        });
        preflightError = undefined;
        break;
      } catch (error) {
        preflightError = error;
        if (attempt < PREFLIGHT_ATTEMPTS) await sleep(5_000);
      }
    }
    if (preflightError !== undefined) throw preflightError;

    // --- 4. run the FULL 3-hop ring — S28's "reliable configuration" -----
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    await runCliOrThrow(
      [
        'run',
        '--config',
        CONFIG_PATH,
        '--users',
        '6',
        '--browser',
        '2',
        '--rate',
        '2',
        '--minutes',
        '15',
        '--assets',
        'eth,erc20',
        '--out',
        OUT_DIR
      ],
      { cwd: REPO_ROOT, env: cliEnv, timeoutMs: 95 * 60 * 1000, label: '[run]' }
    );

    // --- 5. assert on the report -------------------------------------------
    const resultsPath = path.join(OUT_DIR, 'results.json');
    expect(fs.existsSync(resultsPath)).toBe(true);
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as ResultsJson;

    await test.step('the run completed normally (not aborted)', () => {
      expect(results.run.aborted).toBe(false);
    });

    await test.step('genuinely invariant error classes are zero (funding, config)', () => {
      expect(results.errors.byClass.funding ?? 0).toBe(0);
      expect(results.errors.byClass.config ?? 0).toBe(0);
    });

    // Reported, not hard-asserted — same rationale as run.spec.ts: finding
    // C5 (browser can't apply a gas limit) and S24's residual UI-timeout
    // class are both documented, tolerated flakes.
    test.info().annotations.push({
      type: 'flaky-but-not-asserted error counts',
      description: JSON.stringify({
        ui_assertion: results.errors.byClass.ui_assertion ?? 0,
        internal: results.errors.byClass.internal ?? 0,
        rpc_error: results.errors.byClass.rpc_error ?? 0
      })
    });

    // --- The gate this file exists to add: per-route x per-mode hop
    // reliability, for EVERY route the full ring produces — see this file's
    // top-of-file doc comment for the threshold derivation. ---------------
    for (const route of ALL_ROUTES) {
      const byMode = results.hops.byRouteMode[route];

      await test.step(`route ${route} was recorded at all`, () => {
        expect(byMode).toBeDefined();
      });

      for (const mode of ['browser', 'headless'] as const) {
        const reliability = byMode[mode];

        await test.step(`route ${route} / ${mode} was genuinely exercised (attempted > 0)`, () => {
          // DESIGN §5.5 invariant 5's "no false zero" rule, applied to this
          // gate: a `completionRate` of `null` must never be silently read
          // as passing. For `L2B->L1` specifically, this IS the assertion
          // that proves the hop was actually exercised (not skipped by a
          // shortened ring, per S27's known limitation) in BOTH modes.
          expect(reliability.attempted).toBeGreaterThan(0);
        });

        await test.step(`route ${route} / ${mode} clears its ${HOP_COMPLETION_THRESHOLD[route] * 100}% floor (attempted=${reliability.attempted}, completed=${reliability.completed})`, () => {
          expect(reliability.completionRate ?? 0).toBeGreaterThanOrEqual(
            HOP_COMPLETION_THRESHOLD[route]
          );
        });
      }
    }

    // --- Same per-mode LAP floor S27 already established, reused here as
    // a second, coarser-grained check on this heavier config — not a
    // replacement for the per-route gate above, which is what actually
    // closes S27's blind spot. -------------------------------------------
    const LAP_COMPLETION_THRESHOLD: Record<DriverMode, number> = { browser: 0.5, headless: 0.5 };
    for (const mode of ['browser', 'headless'] as const) {
      const reliability = results.laps.byMode[mode];

      await test.step(`${mode} mode issued at least one full-ring lap attempt`, () => {
        expect(reliability.attempted).toBeGreaterThan(0);
      });

      await test.step(`${mode} mode full-ring lap completion clears its ${LAP_COMPLETION_THRESHOLD[mode] * 100}% floor (attempted=${reliability.attempted}, completed=${reliability.completed})`, () => {
        expect(reliability.completionRate ?? 0).toBeGreaterThanOrEqual(
          LAP_COMPLETION_THRESHOLD[mode]
        );
      });
    }

    // Informational: the full per-route table, for a human reading the
    // Playwright report without opening summary.md.
    test.info().annotations.push({
      type: 'per-route x per-mode hop reliability (S30)',
      description: JSON.stringify(results.hops.byRouteMode)
    });
  });
});

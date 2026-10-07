// S13 (plans/bridge-loadtest-plan.md) — an end-to-end test of the loadtest
// TOOL ITSELF (not of aggkit-proxy or the dev-ui) against the real compose
// devnet. It derives a devnet config, funds 4 wallets, runs
// `pnpm loadtest run --users 4 --browser 2 --rate 1 --minutes 2 --assets
// eth,erc20` (which builds and serves an E2E-enabled static export of the
// dev-ui itself for its 2 browser users), and asserts on the resulting
// `results.json` / `summary.md` / `activity.ndjson`.
//
// Requires: the compose devnet up (`docker compose -f
// tests/devnet/docker-compose.yml up -d --wait`, `node
// scripts/devnetReady.mjs`) and two env vars exported in the shell that
// invokes Playwright:
//   export LOADTEST_DEVNET_FUNDER_KEY=$(python3 -c "import json;print(json.load(open('tests/devnet/summary.json'))['accounts']['e2e_wallet']['private_key'])")
//   export LOADTEST_MNEMONIC="test test test test test test test test test test test junk"
//
// Budget: up to ~60–75 minutes wall-clock (see the ring-shortening note
// below for why this run is normally much faster in practice, and the
// timeouts note for why the worst case is still that large).
//
// ---------------------------------------------------------------------------
// WHAT THIS TEST PROVES, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
//
// This section exists so a future reader is not misled by a green run.
//
// ## The ring is shortened to 2 hops (L1 -> L2A -> L1), not the tool's
//    normal 3-hop devnet ring (L1 -> L2A -> L2B -> L1)
//
// This session measured devnet L2->L2 latency (the L2A->L2B hop) as
// LOAD-SENSITIVE: ~95s idle, ~638s lightly loaded, and >900s under just 6
// concurrent users (12/12 laps timed out on that hop at the tool's raised
// 900_000ms `readyToClaimMs` budget, with `sync-status` healthy and no
// aggsender wedge — i.e. genuine devnet certificate-settlement capacity,
// not a bug). A `--minutes 2` run asserting on the FULL 3-hop ring would be
// flaky-to-impossible: it would either never see a completed lap, or need
// an enormous timeout to occasionally see one.
//
// The fix applied here (deriveE2eConfig.ts) drops the L2A->L2B hop
// entirely and runs the ring L1 -> L2A -> L1 instead. This is not a lesser
// test of the wrong thing: it still exercises exactly the two hop KINDS
// the plan's assertions care about —
//   - L1->L2A is `l1_to_l2`, autoclaim-expected (config.ci.devnet.json) —
//     the "autoclaim route reaches CLAIMED without a manual claim" case.
//   - L2A->L1 is `l2_to_l1`, never autoclaimed on this devnet — the
//     "L2->L1 hop is claimed manually" case.
// What it does NOT exercise is an `l2_to_l2` hop (L2A<->L2B) at all — that
// combination is covered by the tool's unit tests (core/ring.test.ts) and
// by the ad hoc S10/S11/S24 validation runs recorded in the plan, not by
// this E2E test. A reader who needs L2->L2 E2E coverage under load should
// look at S14/S17's validation runs, not this file.
//
// ## Why this is still safe to run nightly
//
// With a healthy, freshly-booted devnet, an exploratory run of this exact
// config/command completed in ~226s (4/4 users: `hop_completed_auto` on
// L1->L2A, `hop_completed_manual` on L2A->L1, `LAP_DONE` on all 4 laps,
// zero errors). Separately, this session also hit a genuinely wedged
// devnet mid-work: a manual-claim hop sat at `timeout_ready_to_claim` for
// all 4 users because the aggsender's certificate settlement had entered
// `CertificatePending` with `status_string: "InError"` ("settlement job
// watcher closed before producing a result") after several hours of
// continuous heavy testing on the same long-lived compose devnet — the
// same class of problem the plan's reality-check calls out for L2->L2
// (`resolving root index of LER ... not found`), just a different error
// string for the same "aggsender pipeline is wedged, sync-status still
// says synced" symptom. `docker compose -f tests/devnet/docker-compose.yml
// down && up -d --wait` + `node scripts/devnetReady.mjs` fully recovered
// it (chain state resets to the settlement-free baked snapshot). A nightly
// job that starts from a **freshly booted** devnet (as
// `.github/workflows/loadtest-e2e.yaml` does, mirroring `e2e.yaml`) should
// not hit this — it is a long-lived-devnet hazard, not a per-run one — but
// if this test ever times out on the manual-claim hop, check
// `{proxy}/aggkitapi/tracker/v1/activity/from/{addr}?includeTracking=true`'s
// `tracking.all_steps` for an `InError`/wedged step before assuming a tool
// regression, and recover the devnet the same way.
//
// ## The "per asset" dimension is NOT exercised the way the plan first
//    asked for it, and this is a structural fact about `--rate 1 --minutes
//    2`, not a bug
//
// `core/scheduler.ts` gives each user a lap-start tick every
// `60_000 / bridgesPerMinutePerUser` ms — exactly 60_000ms at `--rate 1` —
// cycling round-robin through the run's active asset indices, starting
// every user at index 0. Over a 120-second (`--minutes 2`) load window,
// every user gets exactly ONE tick (the first, at ~t=60s; a second would
// land at ~t=120s, at or past the window's own cutoff) — this held with
// both the derived default `rampUpSeconds` (60s) and a cut-down 5s ramp,
// so it is not a ramp-tuning problem. That one tick is always for
// `config.assets[0]` (eth): nothing in a 4-user/2-minute run ever advances
// any user's round-robin cursor past its starting position. So this exact
// command — as specified by the plan, and reproduced verbatim below —
// structurally NEVER bridges the erc20 asset, no matter how many times you
// run it or how devnet-healthy it is.
//
// This test therefore does NOT assert "≥1 completed lap per asset per
// mode" as originally phrased in the plan — that's unsatisfiable for the
// erc20 half at this rate/duration, and asserting it would make the test
// permanently red rather than flaky. What it DOES do:
//   - passes `--assets eth,erc20` (so config/preflight/funding validation
//     genuinely covers both assets — an underfunded or misconfigured erc20
//     asset would still fail preflight before any bridging starts);
//   - asserts the aggregate (both-assets-combined) hop/lap outcomes the
//     plan actually needs evidence for;
//   - separately computes and reports (as a Playwright annotation, not a
//     hard assertion) the REAL per-(assetKind, mode) lap-outcome
//     breakdown, parsed straight out of `activity.ndjson` (see
//     activityBreakdown.ts) — so the eth-only coverage is visible in every
//     run's report, not silently swept under an aggregate number.
//
// ## Error-class assertions: only what's genuinely invariant is hard-failed
//
// The plan asked for "no `funding` / `ui_assertion` errors". `funding` and
// `config` are asserted at zero — genuine tool/config defects, not
// load-sensitive. `ui_assertion` (finding C5: browser mode cannot apply
// `bridgeGasOffset`, so a same-block `forceUpdateGlobalExitRoot` bridge can
// OutOfGas-revert under concurrency) and `internal` (S24: a residual
// `locator.click`/`locator.getAttribute` UI-timeout class under devnet
// load) are BOTH known-possible at concurrency per the plan's reality
// check. They are reported as annotations, not hard-asserted to zero —
// this run's 2 browser users and short duration make them unlikely, and
// the exploratory runs behind this file saw zero of either, but nightly CI
// should not go red over one flaky OutOfGas revert.
//
// ## S27 (plans/bridge-loadtest-plan.md §7): per-mode lap/hop completion
//    gates, so a mode collapsing toward 0% cannot hide behind the other
//
// Before this step, the ONLY assertion touching browser mode at all was
// the `tracker/activity` HTTP-request-count check below — it proves the
// browser ISSUED requests, never that a lap or hop it started ever
// FINISHED. That gap is exactly how CI stayed green while browser mode
// completed 1 of ~58 attempted laps (~2%) pre-S25. Fixing the browser
// driver's serialization bug (S25) does not, by itself, stop that same gap
// from reopening later for EITHER mode — S26's own live run showed it can
// just as easily move to headless (10 of 18 laps, 56%, on a heavier
// config) the moment browser looks healthy. So this file now hard-asserts,
// per mode, that laps actually complete (via `results.laps.byMode`,
// `metrics/report.ts`'s S27 addition) and that at least one hop actually
// reaches a `hop_completed_*` outcome (via `activityBreakdown.ts`'s
// `summarizeHopsByMode`, parsed from `activity.ndjson` the same way the
// pre-existing per-asset breakdown below is).
//
// Threshold derivation — measured data, not invented:
//   - Browser, post-S25 fix: 100% completion in every recorded
//     measurement — 16/16 and 15/15 in S25/S26's heavier concurrent
//     validation runs (plans/bridge-loadtest-plan.md §7), and 2/2 in THIS
//     exact e2e config's own exploratory run (see this file's "why this is
//     still safe to run nightly" section above: "LAP_DONE on all 4 laps").
//     The one documented browser-specific risk is the flaky-but-rare
//     `ui_assertion`/`internal` UI-timeout class this file already
//     declines to hard-assert to zero, two paragraphs up — a 100% gate
//     would turn that single documented, tolerated flake into a hard CI
//     failure, which contradicts that policy.
//   - Headless: this same shortened-ring config also measured 100% (2/2)
//     in its own exploratory run, and a separate 15-minute validation run
//     completed 51 laps clean. But S26's heavier, longer-ring validation
//     run saw 56% (10/18), from `rpc_error`s on the `L2B->L1` claim hop —
//     a hop this file's 2-hop `L1->L2A->L1` ring (see above) never
//     exercises. Real completion-rate variability exists on this devnet,
//     though, and this file has no repeated-CI-run history proving 100%
//     holds reliably for headless even on the lighter config — so
//     headless gets the SAME floor as browser below, not a tighter one
//     read off a single good run.
//   - Both floors are set at 50%. This run's structural per-user tick
//     count (exactly one, per the "per asset" section above) means each
//     mode attempts only ~2 laps here, so 50% is the only non-trivial
//     floor available at this scale — and it sits at the midpoint between
//     the measured REGRESSED state (~2%, effectively 0 of a run this
//     size) and the measured FIXED/healthy state (100%): equal headroom
//     against a silent regression toward either failure mode, while still
//     absorbing one already-tolerated flaky failure without making
//     nightly CI flaky on its own account. If future nightly runs
//     accumulate enough history to show headless (or a tighter browser
//     bound) reliably clears something stricter, tighten these then —
//     this is a floor grounded in what has actually been measured, not a
//     target.
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import type { Outcome } from '../../loadtest/core/types';
import type { DriverMode } from '../../loadtest/core/userDriver';
import type { ResultsJson } from '../../loadtest/metrics/report';

import { serializeLoadtestConfig } from '../../loadtest/config/schema';
import { isSuccessOutcome } from '../../loadtest/core/types';
import { summarizeHopsByMode, summarizeLapsByAssetAndMode } from './activityBreakdown';
import { buildE2eConfig } from './deriveE2eConfig';
import { runCliOrThrow } from './runCli';

// Deliberately the native CJS `__dirname` global, NOT
// `path.dirname(fileURLToPath(import.meta.url))`: Playwright's own
// require-hook-based TS transform compiles this file to CJS, and a
// statically-referenced `import.meta.url` in a file it transforms throws
// `ReferenceError: require is not defined in ES module scope` the moment
// the file is loaded — independent of what the surrounding code does with
// it. This is the same hazard `tests/e2e/appConfig.ts` documents (reproduced
// there for `config/configLoaderNode.mjs`) and the same fix: this file is
// plain CJS-compiled TS under Playwright, so plain `__dirname` is safe.
const REPO_ROOT = path.resolve(__dirname, '../..');

const WORK_DIR = path.join(REPO_ROOT, 'loadtest-results/loadtest-e2e');
const CONFIG_PATH = path.join(WORK_DIR, 'loadtest.config.json');
const OUT_DIR = path.join(WORK_DIR, 'run');

const REQUIRED_ENV_VARS = ['LOADTEST_DEVNET_FUNDER_KEY', 'LOADTEST_MNEMONIC'] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('loadtest tool E2E (compose devnet)', () => {
  test.beforeAll(() => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `missing required env var(s): ${missing.join(', ')} — see this file's top-of-file doc comment ` +
          'for the export commands (also: plans/bridge-loadtest-plan.md S13).'
      );
    }
  });

  test('derive -> fund -> preflight -> run -> assert on results.json', async () => {
    // Reality-check budget: up to ~60 min for the `run` step alone (a
    // stuck manual-claim hop can occupy `readyToClaimMs` + `claimedMs` =
    // 30 min before its OWN timeout fires, times up to
    // `maxInflightLapsPerUser`-driven overlap; `lapMs` caps a whole lap at
    // 60 min). Healthy-devnet runs behind this file finished in <4 min.
    test.setTimeout(75 * 60 * 1000);

    const cliEnv = process.env;

    // --- 1. derive the devnet config, then shorten its ring (see the
    // top-of-file doc comment) -------------------------------------------
    const { config } = buildE2eConfig(REPO_ROOT);
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${serializeLoadtestConfig(config)}\n`);

    // --- 2. fund 4 wallets (the real `pnpm loadtest fund` CLI) ------------
    await runCliOrThrow(['fund', CONFIG_PATH, '--users', '4'], {
      cwd: REPO_ROOT,
      env: cliEnv,
      timeoutMs: 3 * 60 * 1000,
      label: '[fund]'
    });

    // --- 3. preflight, tolerating the documented transient fund->preflight
    // race (fund reports success, an immediate preflight read can still
    // observe a stale ERC20 balance; it clears on retry with no code
    // change — S24's "Two observations carried to S13/S14"). -------------
    let preflightError: unknown;
    const PREFLIGHT_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt += 1) {
      try {
        await runCliOrThrow(['preflight', CONFIG_PATH, '--users', '4'], {
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

    // --- 4. run. `run` itself builds+serves the E2E-enabled UI export for
    // the 2 browser users (loadtest/ui/{build,serve}.ts) when
    // `config.uiBaseUrl` isn't already reachable — see runner.ts's
    // `runLoadTest` — so this one CLI invocation covers the plan's
    // "builds/serves the UI" step too. Exact command the plan mandates:
    // --------------------------------------------------------------------
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    await runCliOrThrow(
      [
        'run',
        '--config',
        CONFIG_PATH,
        '--users',
        '4',
        '--browser',
        '2',
        '--rate',
        '1',
        '--minutes',
        '2',
        '--assets',
        'eth,erc20',
        '--out',
        OUT_DIR
      ],
      { cwd: REPO_ROOT, env: cliEnv, timeoutMs: 65 * 60 * 1000, label: '[run]' }
    );

    // --- 5. assert on the report -------------------------------------------
    const resultsPath = path.join(OUT_DIR, 'results.json');
    const summaryPath = path.join(OUT_DIR, 'summary.md');
    const activityPath = path.join(OUT_DIR, 'activity.ndjson');

    await test.step('summary.md is present', () => {
      expect(fs.existsSync(summaryPath)).toBe(true);
    });

    expect(fs.existsSync(resultsPath)).toBe(true);
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as ResultsJson;

    await test.step('the run completed normally (not aborted)', () => {
      expect(results.run.aborted).toBe(false);
    });

    await test.step('genuinely invariant error classes are zero (funding, config)', () => {
      // Both classes are tool/config defects, never load-sensitive —
      // unlike ui_assertion/internal (see the top-of-file doc comment),
      // these are hard-asserted.
      expect(results.errors.byClass.funding ?? 0).toBe(0);
      expect(results.errors.byClass.config ?? 0).toBe(0);
    });

    // Reported, not hard-asserted — see the top-of-file doc comment on
    // finding C5 (ui_assertion) and S24's residual UI-timeout class
    // (internal).
    test.info().annotations.push({
      type: 'flaky-but-not-asserted error counts',
      description: JSON.stringify({
        ui_assertion: results.errors.byClass.ui_assertion ?? 0,
        internal: results.errors.byClass.internal ?? 0
      })
    });

    await test.step('L1->L2A (autoclaim) reached CLAIMED without a manual claim', () => {
      const outcomes = results.hops.byRoute['L1->L2A']?.byOutcome ?? {};
      expect(outcomes.hop_completed_auto ?? 0).toBeGreaterThanOrEqual(1);
    });

    await test.step('L2A->L1 (the L2->L1 hop) was claimed manually', () => {
      const outcomes = results.hops.byRoute['L2A->L1']?.byOutcome ?? {};
      expect(outcomes.hop_completed_manual ?? 0).toBeGreaterThanOrEqual(1);
    });

    await test.step('at least one full lap completed', () => {
      expect(results.laps.byOutcome.LAP_DONE ?? 0).toBeGreaterThanOrEqual(1);
    });

    await test.step('tracker/activity endpoint class has samples for both modes', () => {
      const activity = results.http['tracker/activity'];
      expect(activity).toBeDefined();
      expect(activity?.browser.ui?.n ?? 0).toBeGreaterThan(0);
      expect(activity?.headless.ui?.n ?? 0).toBeGreaterThan(0);
    });

    // --- S27 (plans/bridge-loadtest-plan.md §7): hard per-mode lap/hop
    // completion gates — see this file's top-of-file doc comment for the
    // full threshold derivation. `n=2 attempted/mode is this run's
    // structural minimum (one tick per user, per the "per asset" doc
    // comment above); 50% is the midpoint between the measured regressed
    // state (~2%) and the measured fixed/healthy state (100%). ------------
    const LAP_COMPLETION_THRESHOLD: Record<DriverMode, number> = {
      browser: 0.5,
      headless: 0.5
    };

    for (const mode of ['browser', 'headless'] as const) {
      const reliability = results.laps.byMode[mode];

      await test.step(`${mode} mode issued at least one lap attempt`, () => {
        // A mode reporting zero attempted laps is a structural failure
        // (the scheduler/runner never even started a lap for it) that the
        // completion-rate check below cannot express on its own (a
        // `completionRate` of `null` must never be silently read as
        // "passing" — DESIGN §5.5 invariant 5's "no false zero" rule,
        // applied to the gate itself).
        expect(reliability.attempted).toBeGreaterThan(0);
      });

      await test.step(`${mode} mode lap completion rate clears its ${LAP_COMPLETION_THRESHOLD[mode] * 100}% floor (attempted=${reliability.attempted}, completed=${reliability.completed})`, () => {
        expect(reliability.completionRate ?? 0).toBeGreaterThanOrEqual(
          LAP_COMPLETION_THRESHOLD[mode]
        );
      });
    }

    const hopsByMode = summarizeHopsByMode(activityPath);
    for (const mode of ['browser', 'headless'] as const) {
      const completedHops = Object.entries(hopsByMode[mode]).reduce(
        (sum, [outcome, count]) => sum + (isSuccessOutcome(outcome as Outcome) ? count : 0),
        0
      );

      await test.step(`${mode} mode completed at least one hop (not just issued HTTP requests)`, () => {
        // This is the exact assertion that was MISSING before S27 for
        // browser: `activity?.browser.ui?.n > 0` above proves the browser
        // issued requests, never that a hop it started ever reached
        // `hop_completed_*`. Parsed straight from `activity.ndjson`'s
        // `hop_end` lines (`activityBreakdown.ts`'s `summarizeHopsByMode`)
        // rather than `results.hops.byRoute` (which has no mode
        // dimension — see the per-asset breakdown's doc comment above for
        // why `activity.ndjson` is the source for anything split by mode
        // AND route/outcome at once).
        expect(completedHops).toBeGreaterThan(0);
      });
    }

    // Informational: the real per-(assetKind, mode) lap-outcome breakdown,
    // parsed from activity.ndjson (results.json has no per-asset
    // dimension — see the top-of-file doc comment). NOT hard-asserted per
    // combination: erc20 structurally gets zero ticks at this rate/
    // duration, so a hard per-combo assertion would make this test
    // permanently red.
    const breakdown = summarizeLapsByAssetAndMode(
      activityPath,
      config.assets.map((asset) => asset.kind)
    );
    test.info().annotations.push({
      type: 'per-asset/per-mode lap outcomes (informational — see doc comment)',
      description: JSON.stringify(breakdown)
    });
  });
});

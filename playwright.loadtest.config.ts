import { defineConfig, devices } from '@playwright/test';

// S13 (plans/bridge-loadtest-plan.md) — a THIRD, separate Playwright config
// (alongside playwright.config.ts for tests/bridge and
// playwright.container.config.ts for tests/container), for
// tests/loadtest-e2e/: an end-to-end test of the `loadtest/` TOOL itself
// against the real compose devnet.
//
// Deliberately NOT folded into playwright.config.ts, for the same class of
// reason playwright.container.config.ts gives:
//   - playwright.config.ts's top-level `webServer` array starts `pnpm run
//     dev` unconditionally for every run regardless of `--project` — this
//     suite doesn't need (or want) a `next dev` server at all. The tool
//     under test builds and serves its OWN E2E-enabled static export
//     (loadtest/ui/{build,serve}.ts, invoked by `pnpm loadtest run`
//     itself) on a different port (config.uiBaseUrl, 127.0.0.1:3100).
//   - This suite's single spec doesn't use Playwright's `page` fixture at
//     all — it shells out to the real `pnpm loadtest <command>` CLI
//     (tests/loadtest-e2e/runCli.ts) and asserts on the JSON/Markdown
//     report it writes. `@playwright/test`'s `test`/`expect`/`test.step`
//     are used purely as the test runner and reporter, the same role they
//     play in tests/container/*.spec.ts.
//   - Run duration is wildly different: tests/bridge specs are seconds
//     each; this one spec can take up to ~60 minutes (see
//     tests/loadtest-e2e/run.spec.ts's doc comment) — folding it into
//     playwright.config.ts's default timeout/retry/webServer shape would
//     be wrong for every other spec in that config.
//
// NOT part of `pnpm run check` or `pnpm run test:e2e` (both wired to
// playwright.config.ts's default project) and NOT in the PR-blocking CI
// matrix — see .github/workflows/loadtest-e2e.yaml (workflow_dispatch +
// nightly only). Requires the compose devnet up and
// LOADTEST_DEVNET_FUNDER_KEY / LOADTEST_MNEMONIC exported — see
// run.spec.ts's top-of-file doc comment.
export default defineConfig({
  testDir: 'tests/loadtest-e2e',
  testMatch: [/.*\.spec\.ts$/],

  // A single long-running spec that funds and drives real devnet wallets —
  // never parallelize, never retry (a retry would re-fund/re-run against
  // wallets a previous attempt already advanced, and would burn another up
  // to ~60 minutes).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,

  // The spec sets its own (larger) per-test timeout via `test.setTimeout`;
  // this is only a floor for anything that doesn't.
  timeout: 5 * 60 * 1000,

  reporter: [['list'], ['html', { outputFolder: 'playwright-report-loadtest-e2e', open: 'never' }]],

  use: {
    testIdAttribute: 'data-test-id',
    trace: 'retain-on-failure'
  },

  projects: [
    {
      name: 'loadtest-e2e',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});

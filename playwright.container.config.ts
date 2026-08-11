import { defineConfig, devices } from '@playwright/test';

// T-1: a SEPARATE Playwright config for tests that exercise the real built
// container artifact (agglayer-dev-ui:c1-test, produced by C-1) instead of
// `next dev`. Every other spec in this repo runs against `next dev` via
// playwright.config.ts's `webServer` array -- until this file, the static
// export produced by the Docker build had never been driven by a browser at
// all.
//
// Deliberately NOT folded into playwright.config.ts:
//   - playwright.config.ts throws at module-load time unless
//     E2E_PRIVATE_KEY / NEXT_PUBLIC_PROJECT_ID / NEXT_PUBLIC_AGGKIT_BRIDGE_APIS
//     are set (see its top-level checks) -- requirements that make sense for
//     a wallet-driving devnet suite, but have nothing to do with "does the
//     container start and render its mounted config". This config has none
//     of those requirements, so it can run in CI without any devnet secrets.
//   - Playwright's top-level `webServer` array starts unconditionally for
//     the whole run regardless of which `--project` is selected; reusing
//     playwright.config.ts's array would mean every run of this suite also
//     spins up two `next dev` servers it doesn't need.
//   - Container lifecycle here is per-spec (each spec starts/stops its own
//     named container against a fixture config via tests/container/docker.ts)
//     rather than Playwright's own `webServer`, because `docker run -d`
//     detaches and exits immediately -- it is not the kind of long-lived
//     foreground process `webServer.command` expects to supervise.
//
// Specs under tests/container/ skip cleanly (not fail) when Docker is
// unavailable or the C-1 image hasn't been built locally -- see
// tests/container/docker.ts's containerTestsUnavailableReason(). No devnet
// is required at all: every fixture config.json under
// tests/container/fixtures/ uses reachable-format-but-unused RPC URLs, and
// no spec here connects a wallet or submits a transaction.
export default defineConfig({
  testDir: 'tests/container',
  testMatch: [/.*\.spec\.ts$/],

  fullyParallel: false,
  // Run serially: specs share a small, deliberately non-overlapping set of
  // host ports and container names (see each spec file), and only one
  // container needs to be up at a time.
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [['list'], ['html', { outputFolder: 'playwright-report-container', open: 'never' }]],

  use: {
    testIdAttribute: 'data-test-id',
    trace: 'on-first-retry'
  },

  projects: [
    {
      name: 'container',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});

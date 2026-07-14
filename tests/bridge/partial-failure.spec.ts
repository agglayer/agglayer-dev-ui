import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// This spec runs under the dedicated "partial-failure" Playwright project
// (see playwright.config.ts), which boots its own Next dev server on a
// separate port with an extra bogus network (999, unresolvable) injected
// into NEXT_PUBLIC_AGGKIT_BRIDGE_APIS alongside the real one. This can't be
// done against the shared "chromium" project's dev server: NEXT_PUBLIC_*
// values are inlined into the client bundle at Next.js build/dev-compile
// time, so injecting a different value for just this one spec would require
// restarting the server every other bridge/*.spec.ts test depends on.
//
// Manually verified equivalent flow, same assertions: S12
// manual-validation.md §6 ("Partial failure (bogus second network)").
test('activity page surfaces a partial-failure notice for the unreachable network while the healthy network still renders', async ({
  page
}) => {
  test.setTimeout(60_000);

  const bridgePage = new BridgePage({ page });

  await page.goto('/transactions');
  await bridgePage.connectWallet();

  // Network 999's client exhausts its retries before the aggregator gives
  // up on it (design.md §2.4 partial fan-out failure contract) -- allow
  // enough time for that backoff plus the warning banner to render.
  await expect(page.getByText(/some networks are temporarily unavailable/i)).toBeVisible({
    timeout: 45_000
  });
  await expect(page.getByText(/unknown network/i)).toBeVisible();

  // Network 1's data must still render despite network 999 failing --
  // asserted via the same "Total transactions" summary line S12 used.
  await expect(page.getByText(/total transactions:/i)).toBeVisible();
});

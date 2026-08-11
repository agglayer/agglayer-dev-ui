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
// The equivalent flow (bogus second network) was verified manually with
// the same assertions during the migration's validation pass.
test('activity page surfaces a partial-failure notice for the unreachable network while the healthy network still renders', async ({
  page
}) => {
  test.setTimeout(60_000);

  const bridgePage = new BridgePage({ page });

  await page.goto('/transactions');
  await bridgePage.connectWallet();

  // Network 999's client exhausts its retries before the aggregator gives
  // up on it (the partial fan-out failure contract) -- allow
  // enough time for that backoff plus the warning banner to render.
  await expect(page.getByText(/some networks are temporarily unavailable/i)).toBeVisible({
    timeout: 45_000
  });
  await expect(page.getByText(/unknown network/i)).toBeVisible();

  // Network 1's query must still RESOLVE despite network 999 failing -- that is
  // the partial-failure contract: one bad network degrades to a notice instead
  // of rejecting the whole fan-out and leaving the list stuck loading.
  //
  // S12 asserted this via the "Total transactions:" summary line, but that line
  // is gated on `totalCount > 0` (transactionsView.tsx) over a fan-out filtered
  // to the shared E2E wallet -- so it silently required some earlier spec to
  // have bridged first, and this spec failed on a fresh enclave or when run as
  // the only project. transactionList.tsx renders exactly one of three
  // branches: a loading spinner, the "No transactions found" empty state, or the
  // populated list. Accepting either settled branch asserts "resolved, not
  // hanging" without depending on accumulated history.
  await expect(
    page.getByText(/total transactions:/i).or(page.getByText(/no transactions found/i))
  ).toBeVisible();
});

import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// RESTORED (D0d, config surface cleanup follow-up): this spec used to run
// under a dedicated "partial-failure" Playwright project (see git history)
// that booted its own Next dev server on a separate port with an extra
// bogus network (999, unresolvable) injected into the retired
// NEXT_PUBLIC_AGGKIT_BRIDGE_APIS per-network JSON-map override -- that env
// var's per-network map was the only mechanism able to point one specific
// network at a bad URL while leaving the rest of the mode alone.
//
// NEXT_PUBLIC_AGGKIT_BRIDGE_APIS (and the per-network aggkitBridgeApis config
// surface it overrode) has been removed: every mode now goes through a single
// aggkitProxy, and NEXT_PUBLIC_AGGKIT_PROXY's fan-out applies the SAME value
// to every non-L1 network in the mode by construction, so there is no config
// knob left to make just one network fail without a real (or mock) backend
// that itself behaves differently per `?network_id=`.
//
// The devnet's aggkit proxy IS that kind of backend from the browser's point
// of view: every AggkitBridgeAggregator call is a plain browser `fetch()` to
// the SAME base URL (config.json's devnet aggkitProxy,
// http://127.0.0.1:8555/aggkitapi) with a `network_id` query parameter
// distinguishing networks (@agglayer/sdk's AggkitApiClient#getBridges /
// #getClaims). Playwright's page.route can intercept that fetch and fail it
// for exactly one real, configured network (DEVNET_L2_002, networkId 2)
// while every other network's requests -- including L2_002's own /claims
// call D, which targets network_id=0 -- pass through untouched, because
// fetchNetworkFanout's Promise.all rejects the WHOLE per-network fan-out the
// moment any one of its four legs rejects (call A's /bridges?network_id=2 is
// enough). This reproduces the exact contract the old fixture exercised --
// one network's fan-out fails, the rest of the mode still resolves -- without
// needing a fake/unresolvable network id.
//
// One deliberate coverage difference from the old fixture: network 2 is a
// REAL configured chain (Devnet L2-002), not an unregistered one, so the
// notice names it by its real display name rather than falling back to
// transactionsView.tsx's `getChainByNetworkId(...) ?? 'Unknown network'`
// branch. That one-line fallback has no dedicated coverage after this
// change; it is trivial enough (an inline default for a display name) that
// this is judged an acceptable, explicit gap rather than a reason to block
// restoring the rest of this spec's coverage.
test('activity page surfaces a partial-failure notice for the unreachable network while the healthy network still renders', async ({
  page
}) => {
  test.setTimeout(60_000);

  // Fail every /bridges call for networkId 2 (Devnet L2-002) so that
  // network's fan-out (fetchNetworkFanout) rejects, while networkId 1
  // (Devnet L2-001) and L1-scoped calls (network_id=0) are left alone.
  // Matching on the exact `network_id` query value (not `network_ids`,
  // the plural list param used by the L1-origin-bridges leg) keeps this
  // from also intercepting network 1's or L1's own traffic against the
  // same proxy URL.
  await page.route(
    (url) => url.pathname.endsWith('/bridges') && url.searchParams.get('network_id') === '2',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'partial-failure fixture: network 2 unavailable' })
      })
  );

  const bridgePage = new BridgePage({ page });

  await page.goto('/transactions');
  await bridgePage.connectWallet();

  // Network 2's client exhausts its retries before the aggregator gives
  // up on it (the partial fan-out failure contract) -- allow
  // enough time for that backoff plus the warning banner to render.
  await expect(page.getByText(/some networks are temporarily unavailable/i)).toBeVisible({
    timeout: 45_000
  });
  // Scoped to the banner's own message text (not a bare /devnet l2-002/i
  // search): an earlier spec may have already bridged funds to/from
  // Devnet L2-002, in which case a transaction row elsewhere on the page
  // also renders that chain name and a loose match hits both, failing
  // Playwright's strict-mode single-element requirement.
  await expect(page.getByText(/couldn't load activity from.*devnet l2-002/i)).toBeVisible();

  // Network 1's query must still RESOLVE despite network 2 failing -- that is
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

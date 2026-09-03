import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// REWRITTEN (S11, replaces the S8/D0d fan-out-based version -- see git
// history): the previous fixture relied on the SDK's
// AggkitBridgeAggregator.getActivity fan-out (fetchNetworkFanout, one
// /bridges REST call per configured network) and asserted a
// "some networks are temporarily unavailable" banner. That fan-out and that
// banner text no longer exist anywhere in app/ -- app/services/activity.ts
// (see its top comment) replaced the whole per-network fan-out with a
// single call to aggkit's tracker/v1/activity/from/{address} endpoint, which
// already fans out to every configured bridge service SERVER-side and
// reports any per-network failure as a `warnings` array on its one JSON
// response (see ActivityWarning/RawActivityResponse in activity.ts). There
// is no client-side per-network REST call left to intercept, so the old
// "reject one network's /bridges call" fixture is structurally impossible
// to express against the current app.
//
// The product still has a real partial-failure surface, just reached
// differently now: transactionsView.tsx renders a warning-triangle button
// (data-test-id="transactions-warnings") whenever the activity response
// carries a non-empty `warnings` array, opening a modal
// (data-test-id="transactions-warnings-modal") that lists each warning's
// network name + message -- see useTransactions.ts (`warnings`) and
// transactionsView.tsx's "Network warnings" Modal. This rewrite intercepts
// the ONE tracker/v1/activity/from/ call, fetches the real response (so
// actual transaction history is untouched), and injects a `warnings` entry
// for Devnet L2-002 (networkId 2) before returning it -- reproducing "one
// network's bridge service reported a failure, the rest of the activity
// list still renders" without needing a fake per-network REST fan-out.
test('activity page surfaces a network-warning notice for a network the tracker endpoint reports as failed, while the rest of the list still renders', async ({
  page
}) => {
  test.setTimeout(60_000);

  const FIXTURE_WARNING = {
    network_id: 2,
    message: 'partial-failure fixture: dial tcp 127.0.0.1:33080: no route to host'
  };

  // NOTE for anyone copying this interceptor: `response.json()` here rounds
  // every precision-unsafe integer in the payload, `bridge.global_index`
  // included (~2^64 for L1-origin deposits -- see app/services/activity.ts's
  // parseActivityResponse, which exists precisely to avoid this). Harmless in
  // THIS spec: it only reads the warnings modal and the "Total transactions"
  // line, and row identity is tx_hash + deposit_count, not global_index. Do
  // NOT reuse this shape in a spec that goes on to CLAIM -- the claim would be
  // built with a globalIndex short by exactly `deposit_count`. Splice the
  // warning into the raw `await response.text()` instead if you need that.
  await page.route(
    (url) => url.pathname.includes('/tracker/v1/activity/from/'),
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.warnings = [...(body.warnings ?? []), FIXTURE_WARNING];
      await route.fulfill({ response, json: body });
    }
  );

  const bridgePage = new BridgePage({ page });

  await page.goto('/transactions');
  await bridgePage.connectWallet();

  const warningsButton = page.getByTestId('transactions-warnings');
  await expect(warningsButton).toBeVisible({ timeout: 15_000 });
  await warningsButton.click();

  const warningsModal = page.getByTestId('transactions-warnings-modal');
  await expect(warningsModal).toBeVisible();
  // Networkid 2 is a real configured chain (Devnet L2-002) in devnet mode,
  // so the modal names it directly rather than falling back to
  // transactionsView.tsx's `Network {id}` default.
  await expect(warningsModal.getByText(/devnet l2-002/i)).toBeVisible();
  await expect(warningsModal.getByText(new RegExp(FIXTURE_WARNING.message, 'i'))).toBeVisible();

  await warningsModal.getByLabel('Close modal').click();
  await expect(warningsModal).toHaveCount(0);

  // The rest of the activity list must still resolve despite the injected
  // warning -- that is the partial-failure contract: one bad network
  // degrades to a dismissible notice instead of blocking the whole feed.
  // Accepting either settled branch (as opposed to requiring a populated
  // list) keeps this independent of whichever transaction history the
  // shared E2E wallet happens to already have on this enclave.
  await expect(
    page.getByText(/total transactions:/i).or(page.getByText(/no transactions found/i))
  ).toBeVisible();
});

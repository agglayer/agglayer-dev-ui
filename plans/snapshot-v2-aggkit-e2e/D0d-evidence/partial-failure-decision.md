Decision: restored `tests/bridge/partial-failure.spec.ts`, not deleted.

## Why restoring was possible

D0c's skip comment said the old mechanism (a per-network bogus URL override
via `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS`'s JSON map) had "no equivalent" under a
single `aggkitProxy`. That is true at the *config* layer, but not at the
*network* layer: every `AggkitBridgeAggregator` call is a plain browser
`fetch()` to the same proxy base URL with a `network_id` query parameter
distinguishing networks (`@agglayer/sdk`'s `AggkitApiClient#getBridges` /
`#getClaims`, verified by reading `node_modules/.../@agglayer/sdk/dist/index.js`).
Playwright's `page.route()` can intercept and fail that fetch for one specific
`network_id` while leaving every other request (including the same network's
`/claims` call to `network_id=0`) untouched, because `fetchNetworkFanout`'s
`Promise.all` of its four legs rejects the whole per-network fan-out the
moment any one leg rejects — so failing just `/bridges?network_id=2` is
enough to fail all of network 2's fan-out.

This reproduces the exact contract the old fixture exercised — one network's
fan-out fails, the rest of the mode still resolves — via a route-level mock
against the real devnet backend, with no config-surface changes and no
per-network config knob needed.

## What changed in the restored spec

- Target network: `networkId: 2` (`DEVNET_L2_002`, a REAL configured devnet
  chain) instead of the old fixture's synthetic, unregistered `networkId: 999`.
- Failure injection: `page.route()` intercepts `GET .../bridges?network_id=2...`
  and fulfills with an HTTP 503, instead of pointing that network's aggkit URL
  at an unresolvable host via env var.
- Assertion change: the notice now names the failed network by its real
  display name (`/devnet l2-002/i`) instead of asserting the `'Unknown
  network'` fallback string, because network 2 is a real, registered chain
  entry in `config.json`, not an unregistered one.

## Explicit coverage delta

The one line this drops coverage for is `transactionsView.tsx`'s
`getChainByNetworkId(chains, failure.networkId)?.name ?? 'Unknown network'`
fallback branch — no spec (unit or E2E) now exercises the case where
`failedNetworks` names a network id absent from `config.json`. That fallback
is a trivial inline default with no branching logic of its own; the judgment
here is that this is an acceptable, EXPLICIT gap (recorded here, not silently
skipped) rather than a reason to leave the whole spec skipped or to delete it
outright. The spec's core contract — "one network's fan-out fails, the
notice names it, the healthy network still resolves" — is intact and
verified against a real devnet run (see `bridge-suite-result.txt`).

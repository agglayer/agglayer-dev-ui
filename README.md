# Agglayer Dev UI

The Agglayer Dev UI is a configurable, self-hosted bridging interface powered by the [Agglayer SDK](https://github.com/agglayer/sdk) and the [aggkit bridge service](https://github.com/agglayer/aggkit).

## Quickstart

1) Install dependencies:

```bash
pnpm install
```

2) Configure the app:

Edit `config.json` at the project root to set chains, app modes (each pointed at a single
`aggkitProxy` fronting every network in that mode — see
[`docs/config.md`](docs/config.md#aggkit-bridge-apis-aggkitproxy)), and external links. See
[`docs/config.md`](docs/config.md) for the full guide. For deploying the UI alongside
`aggkit-proxy` (DevOps-facing, incl. rollback), see [`docs/deployment.md`](docs/deployment.md).
To run the app as a self-hosted Docker container instead, see [`docs/docker.md`](docs/docker.md).

`config.json`'s `walletConnect.projectId` field sets the WalletConnect/Reown project ID —
see [`docs/config.md`](docs/config.md#walletconnect--reown-walletconnectprojectid). It is
required but a placeholder is a valid value: leaving it at the checked-in
`YOUR_PROJECT_ID_HERE` (or empty) runs AppKit in a graceful degraded `basic` mode —
injected-wallet connect fully works, only WalletConnect-cloud features (wallet directory
images, remote config) are skipped. Get a real id at https://cloud.reown.com. For local
dev only, `.env.local`'s `NEXT_PUBLIC_PROJECT_ID` overrides it without editing
`config.json`; this override has no effect in a built Docker image (see
[`docs/docker.md`](docs/docker.md)), where `config.json` is the only way to set it, at
runtime, with no rebuild.
Optionally set `NEXT_PUBLIC_AGGKIT_PROXY` to override `config.json`'s `aggkitProxy` per
environment:

```bash
cp .env.example .env.local
```

3) Run the dev server:

```bash
pnpm run dev
```

Open `http://localhost:3000`.

## Scripts

- `pnpm run dev` — start dev server
- `pnpm run build` — production build
- `pnpm run start` — run production server
- `pnpm run lint` — lint
- `pnpm run validate:config` — validate `config.json`
- `pnpm run typecheck` — TypeScript checks
- `pnpm run test` — unit tests (Vitest)
- `pnpm run test:e2e` — end-to-end tests (Playwright)
- `node scripts/kurtosisDevnetEnv.mjs [--enclave cdk]` — bring up devnet config from a running Kurtosis enclave (see below)

### Kurtosis devnet bring-up

Against a running Kurtosis `cdk` enclave (see the `kurtosis-cdk` repo, `bridge_ui_backend: aggkit` mode), this script eliminates manual port copying:

```bash
node scripts/kurtosisDevnetEnv.mjs --enclave cdk
```

It resolves the enclave's ephemeral ports live (`kurtosis port print`), then:

- writes `config.json`'s `chains` with `DEVNET_L1`, `DEVNET_L2_001`, `DEVNET_L2_002` (for 2-L2 enclaves) and `appModes.configs.devnet` with the live L1/L2 RPC URLs, chain ids (read via `eth_chainId`), and bridge address (verified deployed via `eth_getCode`);
- writes `.env.local` with `NEXT_PUBLIC_AGGKIT_PROXY` pointed at the enclave's CORS-safe haproxy proxy (a single URL, fanned out over every network at runtime, routed via `?network_id=`), `E2E_PRIVATE_KEY` set to a pre-funded devnet key, and for 2-L2 enclaves: `E2E_TO_CHAIN_ID` and `E2E_L2_CHAIN_IDS`.

Re-run it after every enclave recreate (ports are ephemeral). It fails with a clear error if the named enclave doesn't exist. Only supports Kurtosis-based devnets.

If your wallet shows a stuck/pending transaction or wrong balances after an enclave reset, see the kurtosis-cdk guide's [Troubleshooting § "After an enclave reset: recovering your wallet and UI"](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/aggkit-2l2-with-bridge-ui.md#after-an-enclave-reset-recovering-your-wallet-and-ui).

## Testing

Playwright E2E defaults to the local Kurtosis `cdk` devnet (aggkit backend)
using a funded devnet key -- see "Kurtosis devnet bring-up" above. Set
`E2E_BACKEND_MODE=testnet` in `.env.local` to instead run against real
Sepolia/Bokuto testnet infrastructure (the previous default before the aggkit devnet backend).
All backend-specific values (chain ids, ERC20 address, bridge amounts,
timeouts) are resolved by `app/constants/e2e.ts` per mode -- see that file
for the exact defaults and overrides, and `.env.example` for the full list
of E2E-only env vars.

### CI-devnet quick start (vendored compose, no Kurtosis toolchain)

`.github/workflows/e2e.yaml` doesn't bring up a live Kurtosis enclave at all -- it
vendors a frozen, self-contained snapshot bundle (`tests/devnet/`, see
[`tests/devnet/README.md`](tests/devnet/README.md)) produced by
`0xPolygon/kurtosis-cdk`'s [anvil-flavor
snapshot](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/anvil-devui-snapshot.md)
and brings it up with plain `docker compose`. This is the fastest way to get a real
bridging backend locally too -- it complements the live Kurtosis bring-up above rather
than replacing it (the live enclave is still the right tool when iterating on
kurtosis-cdk itself, e.g. testing a params-file change); the vendored bundle is for
"just run the suite" with nothing to build or configure:

```bash
# Bring up all 11 services (anvil x3, agglayer, aggkit x2 + bridge x2,
# aggkit-proxy, haproxy, dev-ui), self-contained -- no bind mounts, no
# volumes, no Kurtosis CLI. Pulls 11 public images from GHCR on first run.
docker compose -f tests/devnet/docker-compose.yml up -d --wait

# Replicates kurtosisDevnetEnv.mjs's readiness probes against the fixed
# compose ports (chainId per route, bridge bytecode per chain, sync-status
# both-sides-synced across the 3 network ids). Boot-to-ready is ~24s once
# the images are local; the FIRST run also pulls ~2.9GB, so pass a longer
# timeout than the 120s default for a cold start.
node scripts/devnetReady.mjs --timeout-ms 300000

# Point config.json at the vendored bundle's fixed 127.0.0.1:8555 URLs
# (committed config.json ships in testnet mode -- see above).
cp config/config.ci.devnet.json config.json
pnpm run validate:config

# playwright.config.ts THROWS unless these are set, and globalSetup falls
# back to deploying its own ERC20 via `sudo docker run` without
# E2E_ERC20_ADDRESS. Chain ids/ERC20 address are the exact literals
# .github/workflows/e2e.yaml uses -- all public devnet fixtures, never
# secrets. Keep them in sync with tests/devnet/summary.json (the workflow has
# a step that asserts this). NEXT_PUBLIC_AGGKIT_PROXY is this config surface
# cleanup's field -- .github/workflows/e2e.yaml (owned by a later step in this
# migration) still sets the retired NEXT_PUBLIC_AGGKIT_BRIDGE_APIS literal as
# of this writing; use NEXT_PUBLIC_AGGKIT_PROXY here regardless, since
# playwright.config.ts now requires it.
export E2E_PRIVATE_KEY='0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625'
export NEXT_PUBLIC_PROJECT_ID='ci-e2e'
export NEXT_PUBLIC_AGGKIT_PROXY='http://127.0.0.1:8555/aggkitapi'
export E2E_FROM_CHAIN_ID='271828'
export E2E_TO_CHAIN_ID='20201'
export E2E_L2_CHAIN_IDS='20201,20202'
export E2E_ERC20_ADDRESS="$(jq -r .erc20_address tests/devnet/summary.json)"

# NOTE: playwright.config.ts calls loadEnvConfig(), so a stale .env.local
# left behind by a previous `scripts/kurtosisDevnetEnv.mjs` run OVERRIDES
# the values above and will silently point the suite at a dead ephemeral
# enclave port. Remove or rename it first if you have one.

# Run the suite (same invocations e2e.yaml uses).
pnpm exec playwright test tests/e2e/preflight.spec.ts
pnpm exec playwright test tests/bridge

# Revert config.json (never commit the devnet fixture over the committed
# testnet-mode config), then tear down.
git checkout -- config.json
docker compose -f tests/devnet/docker-compose.yml down -v
```

The vendored bundle is pinned by immutable tag and drifts from kurtosis-cdk's working
branch over time by design -- see [`tests/devnet/README.md`](tests/devnet/README.md)
for the regenerate-and-bump procedure (dispatch the kurtosis-cdk workflow, download the
new artifact, repoint the compose defaults at the published GHCR tag, bump
`E2E_ERC20_ADDRESS`).

Security and ops notes:

- The E2E private key is injected into the browser runtime for automated signing. Never reuse a real wallet key.
- Keep the E2E wallet balance minimal and treat it as disposable.
- Never deploy with `NEXT_PUBLIC_E2E_ENABLED=true` in any public/shared environment.
- Set only `E2E_PRIVATE_KEY` in `.env.local` for tests. Do not set `NEXT_PUBLIC_E2E_PRIVATE_KEY` directly.
- Testnet-mode spend accumulates over CI runs; periodically top up the E2E wallet.

Required `.env.local` variables for E2E:

- `E2E_PRIVATE_KEY`
- `NEXT_PUBLIC_AGGKIT_PROXY` (devnet mode: written by `scripts/kurtosisDevnetEnv.mjs`)

(`NEXT_PUBLIC_PROJECT_ID` is not used in E2E mode — `app/context/wallet.tsx` skips
`createAppKit` entirely under `NEXT_PUBLIC_E2E_ENABLED`, using a mocked wallet provider instead.)

**2-L2 devnet E2E-specific variables** (both set by `kurtosisDevnetEnv.mjs` for 2-L2 enclaves):

- `E2E_TO_CHAIN_ID` — destination chain ID for L2→L2 tests (e.g., `20202` for L2-2)
- `E2E_L2_CHAIN_IDS` — comma-separated list of all L2 chain IDs (e.g., `20201,20202`)

Devnet mode also runs a Playwright `globalSetup` (`tests/e2e/globalSetup.ts`)
before any spec: it resolves a usable ERC20 for
`tests/bridge/erc20-approve-bridge.spec.ts`, reusing a known-good devnet
token if it's still live on the enclave, or deploying a fresh minimal ERC20
(via `forge create`, dockerized the same way as the host's glibc-incompatible
`cast`/`forge` binaries) otherwise. Set `E2E_ERC20_ADDRESS` to skip this and
use a specific address instead.

`tests/bridge/partial-failure.spec.ts` (the S8 partial-failure notice) is currently
**skipped**: it used to run under a second, isolated Playwright project with its own Next
dev server and an extra bogus network id injected into the now-retired
`NEXT_PUBLIC_AGGKIT_BRIDGE_APIS`. That per-network override was the only mechanism able to
point one specific network at a bad URL while leaving the rest of the mode alone;
`NEXT_PUBLIC_AGGKIT_PROXY`'s single-value fan-out cannot express that. See the spec file's
top comment for the full explanation and follow-up.

### Devnet-Specific Tests

**`tests/bridge/claim-autoclaim.spec.ts`** — L1→L2-1 auto-claim
- Devnet-only (skipped in testnet mode)
- Asserts the deposit reaches Completed (CLAIMED) state via external L1ToL2BridgeDetector
- This devnet's aggkit build auto-claims such deposits within seconds (~67s observed latency)
- See the file's top comment for why autoclaim is expected behavior here

**`tests/bridge/l2-to-l2.spec.ts`** — L2-1→L2-2 auto-claim
- Devnet-only, 2-L2 mode only
- Asserts the deposit reaches Completed (CLAIMED) state via external L2ToLxBridgeDetector
- Timeout budget: `E2E_L2_TO_L2_CLAIM_TIMEOUT_MS` (300s default, see notes on certificate cadence below)
- **Certificate cadence note:** AggKit's aggsender enforces `MinimumNewCertificateInterval: 5m0s` between certificate windows. A deposit submitted just after a window closes can wait up to 5 minutes for the next one. The 300s timeout leaves **zero margin** against unlucky timing. If timeouts occur, budget 7–8 minutes instead, or keep L1 block production fast enough to stay ahead of L2 block height.

**`tests/bridge/manual-claim.spec.ts`** — L2-1→L1 manual claim
- Devnet-only, required for both single-L2 and 2-L2 enclaves
- Now funds its own L1→L2-1 top-up deposit (via `claim-autoclaim.spec.ts` flow) before testing the L2→L1 withdrawal
- This makes the spec independent of run order and other specs' side effects
- Typical latency: ~3.9–8.3 minutes until "Ready to claim" (certificate settlement + L1 info tree sync)
- **Shared wallet state note:** The E2E wallet's balance and the enclave's transaction/certificate history accumulate across test runs on the same enclave. This spec now tops up its own balance, so isolation is preserved; future specs requiring absolute balance assertions should account for this accumulation.

### E2E Specs by Mode

| Spec | Mode | Assertion |
|------|------|-----------|
| smoke | all | Page loads, wallet connects |
| token-selector | all | Token selector shows symbol + balance |
| native-bridge | all | Native token bridge works |
| erc20-approve-bridge | all | ERC20 approval + bridge works |
| claim-autoclaim | devnet | L1→L2 autoclaim reaches Completed |
| l2-to-l2 | devnet (2-L2 only) | L2→L2 autoclaim reaches Completed |
| manual-claim | devnet | L2→L1 manual claim reaches Completed |
| partial-failure | devnet | UI partial-failure notice surfaces |
| preflight | devnet | Chain sync-status, E2E wallet funded |
| tracker | devnet | Bridge tracker progress bar + detail timeline render correctly |

## Bridge Tracking

Each non-`CLAIMED` transaction row polls aggkit's `tracker/v1` API (via the SDK's
`AggkitBridgeAggregator.getBridgeTracking`, `app/hooks/useBridgeTracking.ts`) every 5 seconds and
renders its step-by-step progress:

- **`app/components/transactions/trackerProgressBar.tsx`** — a row of dots + connector lines in
  the activity list, one dot per expected step of that bridge's route: 4 steps for L1→L2, 6 for
  L2→L1, 7 for L2→L2.
- **`app/components/transactions/trackerDetail.tsx`** — the full timeline (same dots, plus label,
  status, start/end dates, and a per-step result detail) shown in the transaction details modal.

**Dot colors** (`DOT_CLASSES` in `trackerProgressBar.tsx`):

| Status | Meaning | Style |
|---|---|---|
| `done` | Step complete | Filled green |
| `inProgress` | Step currently running | Filled blue, pulsing |
| `pending` | Step not started yet | Hollow grey ring |
| `error` | Step failed (tracker retries in the background) | Filled red |

**Render rules:**
- Nothing renders while `all_steps` is `null` — either the tracker hasn't resolved the bridge's
  route yet, or it has given up entirely (see the SDK's `getBridgeTracking` docs for terminal
  semantics).
- Both the progress bar and the detail view have an explicit guard on `transaction.status ===
  'CLAIMED'`: `useBridgeTracking` disables its query once a row is `CLAIMED`, but disabling a
  react-query query doesn't clear already-cached data, so a row that transitions live from
  non-`CLAIMED` → `CLAIMED` while mounted would otherwise keep showing its last-fetched, all-`done`
  steps. The status check is the actual hide signal, not the presence of `data`.
- If the tracker gives up resolving the transaction at all (`tracking_status === 'error'` with
  `bridge_status: null`), the detail view shows a "Tracking unavailable" info alert instead of a
  timeline.
- **The tracker's `WaitingClaim` step and the row's `READY_TO_CLAIM` status (which gates the
  "Claim tokens" button, `AggkitBridgeAggregator.toTransaction`) are driven by different
  pipelines and are NOT synchronized** — see upstream
  [aggkit#1786](https://github.com/agglayer/aggkit/issues/1786) (OPEN); measured live on a
  devnet L2→L1 bridge, the tracker entered `WaitingClaim` at T+18s while the claim proof was not
  actually servable until T+40.5s. The tracker's certificate-settlement resolver reads the settlement tx's
  own L1 receipt directly; the row's status (and the claim mutation's own proof fetch,
  `useClaimExecution.ts`) depend on aggkit's bridge-service completing its own, separate
  L1-info-tree sync. The tracker routinely enters `WaitingClaim` some seconds to tens of seconds
  before a claim is actually possible — this is expected, upstream (aggkit) behavior, not a
  dev-ui bug, and the button's gating on `READY_TO_CLAIM` (not on the tracker step) is
  intentionally the more conservative, correct source of truth. This is why `WaitingClaim`'s copy
  says "Finalizing claim data…" rather than "Ready".

**Step → copy mapping** (`app/utils/trackerSteps.ts`, keyed on the wire's `step_name`):

| `step_name` | Label |
|---|---|
| `WaitingGERUpdate` | Waiting for the global exit root update on L1 |
| `WaitingLERUpdate` | Waiting for the local exit root update on `{source}` |
| `PendingInclusion` | Waiting for inclusion in an agglayer certificate |
| `CertificatePending` | Waiting for the certificate to settle |
| `WaitL1SettledGER` | Waiting for settlement to confirm on L1 |
| `WaitingGERInjection` | Waiting for the exit root to reach `{destination}` |
| `WaitingClaim` | Finalizing claim data for `{destination}` |
| `Claimed` | Claimed |

Tooltips (progress bar) and step labels (detail view) fall back to "the source"/"the destination"
when chain metadata hasn't resolved yet.

**Testids for E2E authors** (`data-test-id`, see `tests/bridge/models/bridge-page.ts`):

- `tracker-progress` — the progress bar container for a transaction row
- `tracker-step-<i>` — one dot in the progress bar (`data-step` = `step_name`, `data-status` =
  step status)
- `tracker-detail` — the tracker section of the transaction details modal
- `tracker-detail-step-<i>` — one timeline entry in the detail view

Covered by `tests/bridge/tracker.spec.ts`.

## Configuration

All app configuration lives in `config.json` at the project root. See [`docs/config.md`](docs/config.md) for the full guide.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

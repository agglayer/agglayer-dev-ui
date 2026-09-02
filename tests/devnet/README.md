# Vendored devnet snapshot (e2e CI backend)

This directory is a **vendored copy** of the anvil-aggkit devnet snapshot
bundle produced by `0xPolygon/kurtosis-cdk`'s `snapshot-devui.yml` workflow
(`.github/workflows/snapshot-devui.yml` in that repo, branch
`feat/aggkit-bridge-ui-backend`). See that repo's [Anvil-Flavor Devnet
Snapshot](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/anvil-devnet-snapshot.md)
doc for the bundle's topology, the `summary.json` field reference, the
compose port table, and the restore hazards (`anvil --load-state` tip-state
semantics, the `settlement_free`/`historical_states` publish gates, the
timestamp seam) that this bundle was produced under. (That doc used to live
at `anvil-devui-snapshot.md`; a stub remains at the old path redirecting
here.)

This directory contains two files taken from that workflow's published
artifact (plus this README). Both are **byte-identical** to what the
publish run produced -- unlike the v1 bundle, `docker-compose.yml` needs no
local edit, because the artifact itself is already pinned at the published
GHCR digests (see "Tag scheme" below).

- `docker-compose.yml` — self-contained (no bind mounts, no volumes); every
  service's chain state, config and keystores are baked into its image.
  `.github/workflows/e2e.yaml` brings it up with
  `docker compose -f tests/devnet/docker-compose.yml up -d --wait`.
- `summary.json` — a machine-readable description of the bundle (chain ids,
  contract addresses, the funded E2E wallet, the seeded ERC20, image names,
  digests and human-readable sizes). Several `E2E_*` values in
  `.github/workflows/e2e.yaml` are copied from it; the workflow's "Assert
  workflow literals match tests/devnet/summary.json" step fails the job if
  they drift. `.erc20_address` in particular is **nonce-dependent** and can
  differ on every regenerated snapshot. `summary.json` does **not** carry
  `historical_states`, so only half of the producer-side publish gate is
  verifiable from the vendored bundle; the other half is enforced in
  kurtosis-cdk's workflow before publishing. Its `compose.image_prefix_env` /
  `compose.image_tag_env` fields (`SNAPSHOT_IMAGE_PREFIX` /
  `SNAPSHOT_IMAGE_TAG`) describe kurtosis-cdk's general compose-variant
  contract, not this specific vendored file -- this copy is hard-pinned by
  digest and has no override env vars (see below).

## Topology (9 services, not 11)

The aggkit bridge is now a **component** of the main aggkit process, not a
separate service: `aggkit-001` and `aggkit-002` each run
`--components=aggsender,aggoracle,autoclaim,bridge`, exposing aggkit RPC
(`5576`), bridge REST (`5577`) and pprof (`6060`) on one container. There is
no `aggkit-00X-bridge` service anymore. `agglayer-dev-ui-002` (the baked
dev-ui itself, `:8557`, "manual use") is inert for CI and sits behind the
`devui` compose profile — a plain `up`/`up -d --wait` never starts it; use
`docker compose -f tests/devnet/docker-compose.yml --profile devui up -d`
to bring it up for local/manual debugging. `agglayer-dev-ui-proxy-002`
(`:8555`, "THE dev-ui CI origin") stays in the default set and is the only
endpoint the suite needs.

## Tag scheme: immutable, digest-pinned

Every `image:` line in `docker-compose.yml` is of the form:

```yaml
image: ghcr.io/0xpolygon/kurtosis-cdk-snapshot-<service>@sha256:<digest>  # <component-version>-<unix-ts>
```

The `@sha256:<digest>` is what Docker actually resolves — immutable, and
independently re-verifiable (`docker buildx imagetools inspect
ghcr.io/0xpolygon/kurtosis-cdk-snapshot-<service>@sha256:<digest>`). The
trailing `# <component-version>-<unix-ts>` comment (e.g.
`0.11.0-rc8-1788360503`) is a human-readable tag carrying the same digest —
provenance for a reader, not something Docker resolves. Re-running
kurtosis-cdk's publish workflow can never silently move what this file
pulls, unlike the old `snapshot-<sha>` tag scheme (a tag containing a commit
sha is still a mutable tag). There is deliberately no
`SNAPSHOT_IMAGE_PREFIX`/`SNAPSHOT_IMAGE_TAG` override anymore — bumping the
bundle means editing this file (step 4 below), not exporting an env var.

## Why vendor instead of pulling live

dev-ui's e2e workflow has no way to bring up a kurtosis enclave itself (no
Kurtosis CLI, no `sequencer_type: anvil` knowledge, etc. — that all lives in
kurtosis-cdk). Vendoring a frozen, self-contained bundle means dev-ui CI only
needs `docker compose` and 9 public GHCR pulls; it never depends on
kurtosis-cdk's toolchain, params files, or CI being green at PR time.

The trade-off: this bundle **drifts** from kurtosis-cdk's `main`/working
branch over time (new aggkit/agglayer releases, contract changes, etc.). Bump
it deliberately using the procedure below — do not let it silently rot for
months, but also do not auto-pull `snapshot-latest-devui` (that tag moves
under you and breaks the "pin exact versions in CI" contract).

## Regenerate-and-bump procedure

1. **Dispatch the kurtosis-cdk snapshot workflow** (needs `publish: true` to
   actually push images — the default is a dry run):

   ```bash
   gh workflow run snapshot-devui.yml \
     --repo 0xPolygon/kurtosis-cdk \
     --ref feat/aggkit-bridge-ui-backend \
     -f publish=true
   ```

2. **Wait for it to go green** (poll, don't use `gh run watch`):

   ```bash
   gh run list --repo 0xPolygon/kurtosis-cdk --workflow snapshot-devui.yml --limit 1 \
     --json databaseId,status,conclusion
   # once status == completed:
   gh run view <run-id> --repo 0xPolygon/kurtosis-cdk --json conclusion,headSha
   ```

3. **Download the artifact.** With the digest-capture step (post-push, added
   alongside the tag scheme above), the published artifact's
   `docker-compose.yml` is already digest-pinned at GHCR — there is no more
   "repoint the compose defaults at the published tag" step:

   ```bash
   gh run download <run-id> --repo 0xPolygon/kurtosis-cdk \
     --name <artifact-name-from-the-run> --dir /tmp/devui-snapshot
   ```

4. **Copy the two files into this directory, verbatim, overwriting what's
   here** — no `sed`, no hand-editing image references:

   ```bash
   cp /tmp/devui-snapshot/docker-compose.yml tests/devnet/docker-compose.yml
   cp /tmp/devui-snapshot/summary.json        tests/devnet/summary.json
   ```

   Then update this file's header-comment provenance line (the
   `b119c76e56bd53f73f2d0da1647ff7b148b74183` / publish-run-URL pair at the
   top of `docker-compose.yml`) to match the new run, and re-confirm every
   `image:` line resolves to `ghcr.io/0xpolygon/kurtosis-cdk-snapshot-<service>@sha256:<digest>`:

   ```bash
   grep -n 'image:' tests/devnet/docker-compose.yml
   ```

5. **Bump `E2E_ERC20_ADDRESS`** in `.github/workflows/e2e.yaml`'s job `env:`
   block to the new `summary.json`'s `.erc20_address`:

   ```bash
   # -e so a missing/null erc20_address fails loudly instead of printing
   # the literal string "null" for you to paste into the workflow.
   jq -er .erc20_address tests/devnet/summary.json
   ```

   This value is nonce-dependent (the ERC20 is deployed fresh by the
   kurtosis-cdk fixture-seeding step every time the enclave is rebuilt) — it
   can change between snapshots. Forgetting this step makes
   `globalSetup.ts`'s `E2E_ERC20_ADDRESS` override check fail fast
   (`erc20-approve-bridge.spec.ts` needs a *usable* — bytecode + non-zero
   balance for the E2E wallet — ERC20 at that address). Also re-check
   `E2E_FROM_CHAIN_ID` / `E2E_TO_CHAIN_ID` / `E2E_L2_CHAIN_IDS` and
   `NEXT_PUBLIC_AGGKIT_PROXY` against `summary.json`'s `.chain_ids` and
   `.aggkit_proxy.rest_url_via_proxy` — the workflow's literals-assertion
   step (below) checks all of these, not just the ERC20 address.

6. **Verify the new bundle pulls anonymously and boots clean**, from this
   repo root:

   ```bash
   docker logout ghcr.io
   docker compose -f tests/devnet/docker-compose.yml pull
   docker compose -f tests/devnet/docker-compose.yml up -d --wait
   node scripts/devnetReady.mjs --timeout-ms 300000
   docker compose -f tests/devnet/docker-compose.yml down -v
   ```

   Also confirm the `devui` profile still opts in the baked dev-ui container
   without breaking the default set:

   ```bash
   docker compose -f tests/devnet/docker-compose.yml --profile devui up -d --wait
   docker compose -f tests/devnet/docker-compose.yml --profile devui down -v
   ```

7. **Run the actual specs locally** against the new bundle before committing
   (at minimum preflight; ideally the full `tests/bridge` suite once — see
   the main README's "Testing" section for the full env var list this
   workflow's `env:` block mirrors). If the built-image path in `e2e.yaml`
   changed too, also rebuild and rerun `tests/container/` locally (see the
   main README/`e2e.yaml` for the `docker build` + `playwright.container.config.ts`
   invocation).

8. **Commit `tests/devnet/docker-compose.yml`, `tests/devnet/summary.json`,
   and the literal bumps in `.github/workflows/e2e.yaml` together, in the
   same commit.** These must never drift independently. The workflow's
   "Assert workflow literals match tests/devnet/summary.json" step is the
   automated backstop: it compares the `E2E_*` literals and the compose
   file's full set of pinned image digests against `summary.json` and fails
   the job on any mismatch, so a half-done bump is caught in CI rather than
   surfacing as an obscure `globalSetup.ts` failure.

## Notes

- All 9 images (`anvil-001`, `l2-anvil-001`, `l2-anvil-002`, `agglayer`,
  `aggkit-001`, `aggkit-002`, `aggkit-proxy-001`, `agglayer-dev-ui-002`,
  `agglayer-dev-ui-proxy-002`) are public on GHCR under
  `ghcr.io/0xpolygon/kurtosis-cdk-snapshot-<service>` and pull with no
  credentials. If a future org policy change makes a new package default
  private, see the "GHCR PACKAGE VISIBILITY" note at the top of
  kurtosis-cdk's `.github/workflows/snapshot-devui.yml` for the one-time fix.
- The bundle is captured **settlement-free** (no bridge/certificate activity
  at capture time — `summary.json`'s `settlement_free: true`); this is a hard
  requirement, not an optimization. agglayer/aggkit's internal databases are
  not part of the snapshot, so restoring chain state that already contains
  in-flight bridge/certificate activity is unsound. Never hand-vendor a
  bundle whose `summary.json` doesn't say `settlement_free: true`.
- Every key in `summary.json` (including `accounts.e2e_wallet.private_key`
  and the funded-account list) is a public, well-known Kurtosis/Foundry
  devnet key. Nothing sensitive is published by vendoring this file.

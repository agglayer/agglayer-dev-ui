# Vendored devnet snapshot (e2e CI backend)

This directory is a **vendored copy** of the anvil-aggkit devnet snapshot
bundle produced by `0xPolygon/kurtosis-cdk`'s `snapshot-devui.yml` workflow
(`.github/workflows/snapshot-devui.yml` in that repo, branch
`feat/aggkit-bridge-ui-backend`). See that repo's [Anvil-Flavor DevUI
Snapshot](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/anvil-devui-snapshot.md)
doc for the bundle's topology, the `summary.json` field reference, the
compose port table, and the restore hazards (`anvil --load-state` tip-state
semantics, the `settlement_free`/`historical_states` publish gates, the
timestamp seam) that this bundle was produced under.

This directory contains exactly two files pulled verbatim from that
workflow's `devui-snapshot-snapshot-<sha>` artifact:

- `docker-compose.yml` — self-contained (no bind mounts, no volumes); every
  service's chain state, config and keystores are baked into its image.
  `.github/workflows/e2e.yaml` brings it up with
  `docker compose -f tests/devnet/docker-compose.yml up -d --wait`.
- `summary.json` — a machine-readable description of the bundle (chain ids,
  contract addresses, the funded E2E wallet, the seeded ERC20, image
  digests/sizes). `E2E_ERC20_ADDRESS` in `.github/workflows/e2e.yaml` is
  copied from this file's `.erc20_address` — it is **nonce-dependent** and
  will differ on every regenerated snapshot.

The one edit made to the vendored `docker-compose.yml` (vs. the raw
artifact) is the default image reference: the artifact's compose file
defaults to the *locally built* tag from the kurtosis-cdk CI run
(`cdk-<timestamp>-<sha>`); here the defaults are repointed at the
**published, pinned GHCR tag** (`snapshot-<sha>`, never
`snapshot-latest-devui` — pin by immutable sha per kurtosis-cdk's decision
D5) so this repo never depends on an image that only ever existed inside
someone else's CI run.

## Why vendor instead of pulling live

dev-ui's e2e workflow has no way to bring up a kurtosis enclave itself (no
Kurtosis CLI, no `sequencer_type: anvil` knowledge, etc. — that all lives in
kurtosis-cdk). Vendoring a frozen, self-contained bundle means dev-ui CI only
needs `docker compose` and 11 public GHCR pulls; it never depends on
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

3. **Download the artifact** (its name is `devui-snapshot-snapshot-<sha>`,
   where `<sha>` is the 12-char short commit SHA the run dispatched against —
   read it off the run, e.g. `headSha` above truncated to 12 chars, or from
   the workflow's "Resolve publish tag" step log):

   ```bash
   gh run download <run-id> --repo 0xPolygon/kurtosis-cdk \
     --name devui-snapshot-snapshot-<sha> --dir /tmp/devui-snapshot-<sha>
   ```

4. **Copy the two files into this directory**, overwriting what's here:

   ```bash
   cp /tmp/devui-snapshot-<sha>/docker-compose.yml tests/devnet/docker-compose.yml
   cp /tmp/devui-snapshot-<sha>/summary.json        tests/devnet/summary.json
   ```

5. **Repoint the compose defaults at the published GHCR tag.** The freshly
   copied `docker-compose.yml` still has the *locally built* tag as its
   default (`SNAPSHOT_IMAGE_TAG:-cdk-<timestamp>-<sha>`) — replace every
   occurrence of that default pair with the published one:

   ```bash
   sed -i \
     -e 's|SNAPSHOT_IMAGE_PREFIX:-snapshot-|SNAPSHOT_IMAGE_PREFIX:-ghcr.io/0xpolygon/kurtosis-cdk-snapshot-|g' \
     -e "s|SNAPSHOT_IMAGE_TAG:-cdk-[0-9]\{8\}-[0-9]\{6\}-[0-9a-f]\{12\}|SNAPSHOT_IMAGE_TAG:-snapshot-<sha>|g" \
     tests/devnet/docker-compose.yml
   ```

   Then update the header comment block (enclave/tag lines) to match, and
   double-check every `image:` line now reads
   `ghcr.io/0xpolygon/kurtosis-cdk-snapshot-<service>:snapshot-<sha>` by
   inspecting the default (no env vars set):

   ```bash
   grep -n 'image:' tests/devnet/docker-compose.yml
   ```

6. **Bump `E2E_ERC20_ADDRESS`** in `.github/workflows/e2e.yaml`'s job `env:`
   block to the new `summary.json`'s `.erc20_address`:

   ```bash
   jq -r .erc20_address tests/devnet/summary.json
   ```

   This value is nonce-dependent (the ERC20 is deployed fresh by the
   kurtosis-cdk fixture-seeding step every time the enclave is rebuilt) — it
   will essentially always change between snapshots. Forgetting this step
   makes `globalSetup.ts`'s `E2E_ERC20_ADDRESS` override check fail fast
   (`erc20-approve-bridge.spec.ts` needs a *usable* — bytecode + non-zero
   balance for the E2E wallet — ERC20 at that address).

7. **Verify the new bundle pulls anonymously and boots clean**, from this
   repo root:

   ```bash
   docker logout ghcr.io
   docker compose -f tests/devnet/docker-compose.yml pull
   docker compose -f tests/devnet/docker-compose.yml up -d --wait
   node scripts/devnetReady.mjs --timeout-ms 300000
   docker compose -f tests/devnet/docker-compose.yml down
   ```

8. **Run the actual specs locally** against the new bundle before committing
   (at minimum preflight; ideally the full `tests/bridge` suite once — see
   the main README's "Testing" section for the full env var list this
   workflow's `env:` block mirrors).

9. **Commit `tests/devnet/docker-compose.yml`, `tests/devnet/summary.json`,
   and the `E2E_ERC20_ADDRESS` bump in `.github/workflows/e2e.yaml` together,
   in the same commit.** These three must never drift independently — a
   compose bump without the matching ERC20 bump (or vice versa) produces a
   bundle whose `globalSetup.ts` check fails, or (worse) silently reuses a
   stale, no-longer-funded address.

## Notes

- All 11 images (`anvil-001`, `l2-anvil-001`, `l2-anvil-002`, `agglayer`,
  `aggkit-001`, `aggkit-001-bridge`, `aggkit-002`, `aggkit-002-bridge`,
  `aggkit-proxy-001`, `agglayer-dev-ui-proxy-002`, `agglayer-dev-ui-002`) are
  public on GHCR under `ghcr.io/0xpolygon/kurtosis-cdk-snapshot-<service>`
  and pull with no credentials. If a future org policy change makes a new
  package default private, see the "GHCR PACKAGE VISIBILITY" note at the top
  of kurtosis-cdk's `.github/workflows/snapshot-devui.yml` for the one-time
  fix.
- The bundle is captured **settlement-free** (no bridge/certificate activity
  at capture time — `summary.json`'s `settlement_free: true`); this is a hard
  requirement, not an optimization. agglayer/aggkit's internal databases are
  not part of the snapshot, so restoring chain state that already contains
  in-flight bridge/certificate activity is unsound. Never hand-vendor a
  bundle whose `summary.json` doesn't say `settlement_free: true`.
- Every key in `summary.json` (including `accounts.e2e_wallet.private_key`
  and the funded-account list) is a public, well-known Kurtosis/Foundry
  devnet key. Nothing sensitive is published by vendoring this file.

# Deploying the Bridge UI + aggkit-proxy (with bridge tracker)

DevOps-facing guide. Each step links to the authoritative doc instead of restating it; only deployment-specific glue and known gotchas are spelled out here.

**Component picture** — one `aggkit-proxy` per environment fans out to the per-chain aggkit bridge services and the agglayer gRPC endpoint; the Bridge UI is a Next.js app that talks only to the proxy through your reverse proxy, on a single origin:

```
browser → reverse proxy (TLS, single origin)
            ├── /            → bridge UI (Next.js)
            └── /aggkitapi/*  → aggkit-proxy :5577
                                  ├── PROXY   component → per-chain aggkit bridge services (REST)
                                  └── TRACKER component → agglayer gRPC + L1/L2 RPCs
```

Versions this guide is validated against: aggkit `v0.11.0-rc5` (image `ghcr.io/agglayer/aggkit:0.11.0-rc5`), dev-ui `feat/aggkit-backend`, sdk `feat/aggkit-bridge-client`.

---

## 1. Prerequisites

- Running aggkit stack (one aggkit node with `BRIDGE` component per L2, agglayer with gRPC exposed). Start here if you don't have one: [aggkit getting started](https://github.com/agglayer/aggkit/blob/v0.11.0-rc5/docs/getting_started.md), [bridge service component](https://github.com/agglayer/aggkit/blob/v0.11.0-rc5/docs/bridge_service.md).
- L1 + L2 RPC endpoints, the agglayer gRPC URL, and the **L1 GlobalExitRoot contract address** for your deployment (see the gotcha in step 2 below).
- Node 24 + pnpm for building the UI.

## 2. Deploy aggkit-proxy (PROXY + TRACKER)

Run the `aggkit-proxy` binary from the same image/release as your aggkit nodes:

```
aggkit-proxy run --cfg=/etc/aggkit-proxy/config.toml --components=proxy,tracker
```

Configuration — do not write it from scratch; adapt one of these:

- Concepts + full `[Tracker]` key reference: [bridgetracker/API.md](https://github.com/agglayer/aggkit/blob/v0.11.0-rc5/docs/bridgetracker/API.md) and [common REST config](https://github.com/agglayer/aggkit/blob/v0.11.0-rc5/docs/common_config.md). (`docs/bridgetracker.md` does not exist in aggkit — `docs/bridgetracker/API.md` is the only tracker doc.)
- aggkit's own reference recipe (env-var driven): [`proxy/scripts/configuration_based_on_kurtosis.sh`](https://github.com/agglayer/aggkit/blob/v0.11.0-rc5/proxy/scripts/configuration_based_on_kurtosis.sh).
- A known-good, deployed template with comments explaining every choice: [kurtosis-cdk `aggkit-proxy/config.toml`](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/static_files/additional_services/aggkit-proxy/config.toml) (rendered by [`aggkit_proxy.star`](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/src/additional_services/aggkit_proxy.star)).

**Gotchas:**

1. `[Tracker].L1GlobalExitRootAddress` is **required; rc5 fails fast at startup if unset** (a zero/unset address now hard-errors at boot instead of silently stalling every L1→L2 bridge's tracking at its first step). Details: [agglayer/aggkit#1782](https://github.com/agglayer/aggkit/issues/1782) (fixed in rc5).
2. `[REST].MaxRequestsPerIPAndSecond` is **unenforced by design as of rc5, default 0** — don't size infra around it, and don't rely on it for protection; rate-limit at your reverse proxy instead. Details: [agglayer/aggkit#1783](https://github.com/agglayer/aggkit/issues/1783).

Retention note: the tracker forgets terminal bridges after `RetentionPeriod` (default 10m) and re-registers them from scratch if queried again; raise it (the linked kurtosis template uses 30m) if humans will inspect finished bridges.

## 3. Reverse-proxy routing

The UI expects the proxy under a single path on the same origin (default `/aggkitapi`). Route `path_prefix /aggkitapi` → aggkit-proxy REST port, stripping nothing (the proxy serves `/bridge/v1/*` and `/tracker/v1/*` under it). Working haproxy example: the [kurtosis-cdk 2-L2 guide, HAProxy routes section](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/aggkit-2l2-with-bridge-ui.md). WebSocket (`/tracker/v1/ws`) is not used by the UI — no `timeout tunnel`/upgrade config needed.

## 4. Deploy the Bridge UI

Repo: [agglayer/agglayer-dev-ui](https://github.com/agglayer/agglayer-dev-ui/tree/feat/aggkit-backend). It consumes the proxy via [`@agglayer/sdk`](https://github.com/agglayer/sdk/tree/feat/aggkit-bridge-client) (`getBridgeTracking` et al.) — no direct chain indexing of its own beyond RPCs.

Two deployment paths exist. Pick one:

- **Container image** (recommended for self-hosting): `docker run` the published image
  with your `config.json` bind-mounted. See [`docs/docker.md`](./docker.md) for the full
  image contract, tags, and a copy-pasteable `docker run` example — including
  `walletConnect.projectId`, the prod-required WalletConnect/Reown value, which (unlike
  `NEXT_PUBLIC_AGGKIT_PROXY`) is read from the mounted `config.json` at runtime and can be
  set per deployment with no rebuild. See that document's Status section for which tags
  currently exist.
- **Cloudflare Workers**: the steps below.

### Cloudflare Workers path

1. Build/run: see [README §Quickstart](https://github.com/agglayer/agglayer-dev-ui/blob/feat/aggkit-backend/README.md#quickstart) (standard Next.js: `pnpm install && pnpm build && pnpm start`, Node 24).
2. Configure `config.json` — full schema: [docs/config.md](https://github.com/agglayer/agglayer-dev-ui/blob/feat/aggkit-backend/docs/config.md). The essentials per environment: chain list (RPC URLs, bridge contract addresses) and the mode's `aggkitProxy` set to your reverse proxy's `/aggkitapi` origin (this guide's whole component picture is one `aggkit-proxy` per environment — that is exactly what the single-URL `aggkitProxy` field models).
3. What the tracker UI does and how it polls (5s per pending row, stops on terminal states — relevant for capacity planning): [README §Bridge Tracking](https://github.com/agglayer/agglayer-dev-ui/blob/feat/aggkit-backend/README.md#bridge-tracking).

### Container path

1. Mount your `config.json` and run the image — see
   [`docs/docker.md`](./docker.md#copy-pasteable-example) for the exact command. Config
   schema is the same [docs/config.md](./config.md) either way; only the delivery
   mechanism (bind-mount vs. Next.js env/build) differs.
2. The image serves the aggkit proxy configuration exactly as configured in the mounted
   `config.json`'s `aggkitProxy` — point it at your reverse proxy's `/aggkitapi`
   origin the same way you would for the Cloudflare Workers path, either as an absolute
   URL or (if the container is itself behind a single-origin reverse proxy) an
   origin-relative path like `/aggkitapi` (see [docs/config.md](./config.md#relative-aggkitproxy-urls)).

## 5. Smoke test

```bash
# proxy up, right version, tracker component live
curl -s https://<origin>/aggkitapi/tracker/v1/health

# bridge services reachable through the proxy (per network id)
curl -s "https://<origin>/aggkitapi/bridge/v1/sync-status?network_id=1"

# register + track a real bridge tx (source network id + its creating tx hash)
curl -s https://<origin>/aggkitapi/tracker/v1/network/<id>/tx/<hash>
```

Expected response shapes: [bridgetracker API.md](https://github.com/agglayer/aggkit/blob/v0.11.0-rc5/docs/bridgetracker/API.md) — API.md was corrected in rc5 ([agglayer/aggkit#1781](https://github.com/agglayer/aggkit/issues/1781)); sdk [`src/aggkit/types.ts`](https://github.com/agglayer/sdk/blob/feat/aggkit-bridge-client/src/aggkit/types.ts) matches the wire format it documents.

Functional check: send one bridge per direction you support and watch the row's progress bar complete (L1→L2 and L2→L2 autoclaim; L2→L1 parks at "Ready to claim" until claimed — note upstream [agglayer/aggkit#1786](https://github.com/agglayer/aggkit/issues/1786) (OPEN): the tracker's `WaitingClaim` step routinely precedes actual claimability by seconds to tens of seconds, so the UI intentionally gates the Claim button on its own `READY_TO_CLAIM` status rather than on the tracker step).

## 6. Reference deployment (end-to-end, reproducible)

The kurtosis-cdk 2-L2 devnet deploys this whole stack (aggkit rc5, proxy+tracker, haproxy, UI wiring) from one command and is the fastest way to see a working configuration to diff yours against: [aggkit 2-L2 with bridge UI guide](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/aggkit-2l2-with-bridge-ui.md). That guide's Troubleshooting section also covers enclave reset/wallet-nonce recovery and tracker failure-mode diagnosis (including #1786 above).

## 7. Rollback

Nothing here has a one-command in-place downgrade; each layer rolls back independently.

- **aggkit-proxy / enclave (kurtosis-cdk)**: repin `aggkit_image` to the previous tag in both params files and recreate the enclave (`kurtosis enclave rm -f cdk` + the 2-run bring-up recipe) — enclave state is disposable by design, so there is no in-place downgrade. rc5→rc4 note: config is backward-compatible (rc5 changed only defaults/validation, not schema), so the committed `config.toml` template works unchanged on either version.
- **sdk**: not yet published for this feature (release is a manual `workflow_dispatch`, never automatic on merge). Rollback pre-merge is simply reverting the branch commits; rollback post-publish is `npm dist-tag`-ing the previous beta back to the consumer-facing tag, or pinning the previous version number in consumers directly.
- **dev-ui (Cloudflare Workers path)**: deployed via `wrangler deploy` on push-to-`main`. Rollback is `wrangler rollback` (reverts to the previously deployed Worker version) or redeploying the previous commit's build — the app is a static export with no server-side data migrations, so there is no data-compatibility concern either direction.
- **dev-ui (container image path)**: rollback is pinning a prior tag. Image tags are
  immutable per publish (a given `X.Y.Z` is written once, at that release), so
  redeploying with the previous version's tag — e.g. changing
  `ghcr.io/agglayer/agglayer-dev-ui:X.Y.Z` to `:X.Y.Z-1` in whatever orchestrator/compose
  file references it — is the entire rollback. No data migration concern either
  direction: the container is stateless and the mounted `config.json` is reused
  unchanged. See [`docs/docker.md`](./docker.md#rollback).

---

*Branch links (`feat/aggkit-bridge-ui-backend`, `feat/aggkit-backend`, `feat/aggkit-bridge-client`) are pre-merge as of 2026-08-10; swap to `main` once the phase PRs land. aggkit links are pinned to tag `v0.11.0-rc5`.*

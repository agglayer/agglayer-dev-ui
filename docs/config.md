# Configuration Guide

This app is configured through `config.json` at the project root. The app fetches
`/config.json` **at runtime**, once per page load — it is not imported as a module or
bundled into the JS at build time. This is what lets a single built app (in particular, a
single Docker image — see [`docs/docker.md`](./docker.md)) be repointed at different
configuration without a rebuild.

The dev server does **not** hot-reload changes to `config.json` — it never watches the
file, because nothing imports it anymore. The actual workflow is cheaper than the old
Next-rebuild-on-import behavior: after editing the root `config.json`, run

```bash
node ./scripts/syncPublicConfig.mjs
```

in a second terminal (this validates the file and byte-copies it to the gitignored
`public/config.json`, which the dev server serves as a static file), then reload the
browser tab. No Next build/recompile is involved. `pnpm run dev` and `pnpm run build`
both already run this sync automatically before starting/building — you only need to run
it manually mid-session, after an edit, without restarting the dev server.

**Devnet corollary:** `scripts/kurtosisDevnetEnv.mjs` writes the **root** `config.json`
only. `public/config.json` — and therefore what the dev server actually serves — stays
stale until the next `pnpm run dev` (which re-syncs on start) or a manual
`node ./scripts/syncPublicConfig.mjs`. If you already have `pnpm run dev` running when
you re-run `kurtosisDevnetEnv.mjs`, re-sync (or restart `pnpm run dev`) before reloading
the browser.

**Config is read once per page load — there is no live reconfiguration.** The app fetches
`/config.json` a single time when it mounts (plus once per explicit user "Retry" after a
failed fetch), and never polls or re-fetches it afterward. To pick up a new
`config.json`, reload the page after the new file is being served (dev: after a sync;
container: after a restart with a different mount — see
[`docs/docker.md`](./docker.md)). This is a deliberate design constraint, not a gap:
`@agglayer/sdk`'s chain registry is an append-only singleton with no reset/clear method,
so silently re-initializing the app in place against different config (without a reload)
could leave stale chain data resident from the previous config.

Supporting files:
- `config/configSchema.mjs` — shared Zod schema (single source of truth)
- `config/configValidator.mjs` — schema + validator used by CLI and app startup
- `config/configLoader.mjs` — shared browser-safe validate-and-normalize path (also resolves relative `aggkitProxy`/`aggkitBridgeApis` URLs — see below)
- `config/configLoaderNode.mjs` — Node-side loader (CLI scripts, `scripts/syncPublicConfig.mjs`)
- `app/configLoader.ts` — browser `fetch` adapter, used by the app's startup gate
- `app/config.ts` — transforms JSON into typed objects
- `app/types/config.ts` — type definitions
- `app/utils/config.ts` — config utilities

## Aggkit Bridge APIs: `aggkitProxy` vs. `aggkitBridgeApis`

Each app mode's aggkit backend is configured with **exactly one** of two mutually
exclusive fields — never both, and the validator rejects a mode declaring both (see
[Validation](#validation) below):

| Field | Shape | Use when |
|---|---|---|
| `aggkitProxy` | A single URL (or origin-relative path) | One `aggkit-proxy` instance (PROXY + TRACKER components, see [`docs/deployment.md`](./deployment.md)) fronts **every** network in the mode, multiplexing by the `network_id` query parameter. This is every shipped mode's shape — `mainnet`, `testnet`, and `devnet` all use `aggkitProxy` in the committed `config.json`. |
| `aggkitBridgeApis` | An object mapping L2 network IDs (as strings) to aggkit REST base URLs | The mode's networks are served by **distinct** per-network aggkit backends — no single proxy in front of all of them. No shipped mode currently uses this shape, but the schema keeps accepting it: it is how an externally-generated `config.json` may still configure a mode (see the per-network example below), and kurtosis-cdk's generated dev-ui config template still emits it today. |

Bridge API and proxy are not the same thing: a bridge API is one aggkit REST backend for
one network, while a proxy is a superset that also fronts the tracker and multiplexes
every network behind one URL. The app appends `/bridge/v1` to whichever URL(s) it
resolves for a mode when making bridge API requests.

### `aggkitProxy` — one proxy for every network

```json
{
  "appModes": {
    "configs": {
      "devnet": {
        "aggkitProxy": "http://127.0.0.1:33460/aggkitapi"
      }
    }
  }
}
```

This is the correct shape whenever one `aggkit-proxy` instance multiplexes every network
in the mode (any number of L2s, including just one) — routing happens server-side, keyed
off the `network_id` query parameter, so the URL itself never varies per chain. Internally,
the app fans this single value out to every non-L1 chain's network ID before handing it to
the SDK, so downstream code sees the same per-network shape either way (see `aggkitBridgeApis`
below) — `aggkitProxy` only changes what you write in `config.json`, not how the app calls
aggkit.

Prior to this field existing, a multi-L2 devnet had to hand-duplicate the same URL under
every network ID in an `aggkitBridgeApis` map (e.g. `{"1": url, "2": url}`) to get this
same multiplexing behavior — `aggkitProxy` says the same thing with one value instead of
one per network, and removes the class of bug where a newly-added L2's key is forgotten.

### `aggkitBridgeApis` — distinct per-network backends

Use this instead when a mode's networks are **not** behind one shared proxy — for
example a deployment where each L2 has its own standalone aggkit REST service:

```json
{
  "mainnet": {
    "aggkitBridgeApis": {
      "20": "https://katana-aggkit.example.com",
      "22": "https://forknet-aggkit.example.com"
    }
  }
}
```

No mode in this repo's committed `config.json` uses this shape today — `mainnet`,
`testnet`, and `devnet` all use a single `aggkitProxy` (mainnet/testnet's are
`PLACEHOLDER-*` values, since no real backend is deployed yet). The map form remains
fully supported by the schema for **externally-generated** configs, most notably
kurtosis-cdk's dev-ui config template (`static_files/additional_services/bridge-ui/aggkit-dev-ui-config.json.tmpl`),
which still emits `aggkitBridgeApis` and is unaffected by this repo's shipped shape.

`aggkitBridgeApis` may also be `{}`, or omitted entirely, to mark a mode "not yet
configured" — see [Validation](#validation) below. That escape hatch exists for a mode
using the map form whose real backend URLs don't exist yet (this repo's own mainnet/testnet
used it before switching to `aggkitProxy` placeholders — see the note above).

### Environment overrides

If set, `NEXT_PUBLIC_AGGKIT_PROXY` (a bare URL string) overrides a mode's `aggkitProxy`
value, and `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` (a JSON string) overrides a mode's
`aggkitBridgeApis` map, both for that build environment.

**Precedence, stated explicitly:** the served `config.json` is always the base.
- `NEXT_PUBLIC_AGGKIT_PROXY`, if set, is fanned out over every non-L1 network ID in every
  app mode, exactly like a mode's own `aggkitProxy` field would be.
- `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS`, if set, is then shallow-merged on top (per network-id
  key), applied identically to every app mode — so it still wins per-key even over a
  fanned-out `NEXT_PUBLIC_AGGKIT_PROXY` value, and remains the right tool for overriding
  one specific network's URL.

Both merges happen at page-load time, inside the app's config bootstrap — not at build
time — but the *value* of each variable is still fixed at build time, because Next.js
inlines `NEXT_PUBLIC_*` variables into the JS bundle when it builds.

**These overrides are build-time only and have no effect in a prebuilt container image.**
A published Docker image (see [`docs/docker.md`](./docker.md)) is built with neither
variable set, so the merge is a structural no-op there — the mounted `config.json` is
the *only* configuration mechanism in a container. Both variables remain useful for local
dev and Cloudflare Workers builds (see the Kurtosis setup below, and `.env.example`),
where they are genuinely evaluated at each build.

### Relative `aggkitProxy` and `aggkitBridgeApis` URLs

Each `aggkitProxy` value, and each `aggkitBridgeApis` entry, may be an absolute URL, or a
single origin-relative path (exactly one leading slash, e.g. `/aggkitapi`). A relative
value is resolved against the page's own origin (`window.location.origin` in the browser)
the moment the config is loaded, so every consumer downstream — the SDK, the tracker
preflight check — only ever sees an absolute URL. Protocol-relative values (`//host`) are
deliberately rejected: they would change origin, reintroducing the cross-origin surface
that relative URLs exist to remove. This is the single-origin reverse-proxy path described
in [`docs/deployment.md`](./deployment.md) (`/aggkitapi/* → aggkit-proxy`).

Relative URLs are **only** accepted for `aggkitProxy` and `aggkitBridgeApis`. `rpcUrl`,
`explorerUrl`, and `iconUrl` on a chain, and every `externalLinks` value, remain
absolute-URL-only — wallets require an absolute RPC URL, and explorer/icon/external links
are inherently cross-origin.

### Kurtosis / Local Devnet Setup

When running agglayer against a Kurtosis enclave (local devnet), the aggkit service is accessed through an enclave proxy. The proxy routes RPC calls by path and aggkit bridge calls by network ID query parameter.

**Automated setup (recommended):**

```bash
cd /path/to/agglayer-dev-ui

# Run this after bringing up the enclave
node scripts/kurtosisDevnetEnv.mjs --enclave cdk [--l2-suffixes 001,002] [--proxy-service <name>]
```

This script automatically:
1. Discovers L2 suffixes from the enclave (defaults to `[001, 002]`, or override with `--l2-suffixes`)
2. Resolves all RPC URLs (L1 and both L2s)
3. Discovers the haproxy proxy service name (defaults to automatic discovery, or override with `--proxy-service`)
4. Writes `config.json` with `chains.DEVNET_L1`, `chains.DEVNET_L2_001`, `chains.DEVNET_L2_002`, and `appModes.configs.devnet.aggkitProxy` set to the enclave's live proxy URL
5. Writes `.env.local` with `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` pointing every discovered L2 network ID at that same proxy URL, as a fallback override that takes effect at runtime (`app/config.ts` resolves either the map or `aggkitProxy` form to the identical shape, so this override still applies correctly regardless of which form `config.json` uses — see [Environment overrides](#environment-overrides) above)

**Manual setup:**

1. Get the proxy port:
```bash
kurtosis port print cdk agglayer-dev-ui-proxy-002 http
# Example output: 127.0.0.1:33460
```

2. Set `NEXT_PUBLIC_AGGKIT_PROXY` to the proxy URL (the simplest override, matching `config.json`'s own `aggkitProxy` field):
```bash
export NEXT_PUBLIC_AGGKIT_PROXY='http://127.0.0.1:33460/aggkitapi'
```
`NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` (all L2 network IDs pointing to the same proxy URL) still
works too, and is what the automated setup above writes:
```bash
export NEXT_PUBLIC_AGGKIT_BRIDGE_APIS='{"1":"http://127.0.0.1:33460/aggkitapi","2":"http://127.0.0.1:33460/aggkitapi"}'
```

3. Ensure `config.json` has matching `chainKeys` for all configured networks.

### RPC URL Semantics

The haproxy proxy (`agglayer-dev-ui-proxy-00X`) routes RPC calls by path:

| Path | Chain | RPC Endpoint |
|------|-------|--------------|
| `/l1rpc` | L1 | L1 EL RPC |
| `/l2rpc` | L2-1 | L2-1 RPC (back-compat alias, never "current") |
| `/l2rpc-001` | L2-1 | L2-1 RPC |
| `/l2rpc-002` | L2-2 | L2-2 RPC |
| `/aggkitapi` | All (via `?network_id=`) | AggKit proxy multiplexer |

The dev-ui app automatically constructs these paths from the configured chains and `appModes.configs.devnet.chainKeys`; no manual URL construction is needed.

## External Links

```json
{
  "externalLinks": {
    "privacyPolicy": "https://example.com/privacy",
    "termsOfUse": "https://example.com/terms",
    "contactSupport": "https://example.com/support"
  }
}
```

Set any link to an empty string to hide it in the UI.

## Chains

Chains are defined in the `chains` object, keyed by an uppercase identifier:

```json
{
  "chains": {
    "MY_CHAIN": {
      "id": 42,
      "name": "My Chain",
      "rpcUrl": "https://rpc.my-chain.org",
      "explorerUrl": "https://explorer.my-chain.org",
      "currency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
      "iconUrl": "https://example.com/icons/my-chain.svg",
      "networkId": 10,
      "isTestnet": true,
      "eta": 120
    }
  }
}
```

### Chain fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Chain ID (e.g. `1` for Ethereum mainnet) |
| `name` | Yes | Display name |
| `rpcUrl` | Yes | RPC endpoint URL |
| `explorerUrl` | Yes | Block explorer URL |
| `currency` | Yes | Native currency `{ name, symbol, decimals }` |
| `iconUrl` | Yes | URL for the chain/native token icon shown in the UI |
| `networkId` | Yes | AggLayer network ID |
| `isTestnet` | Yes | Whether this is a test network |
| `eta` | Yes | Estimated bridging time in minutes |

## App Modes

Supported modes are fixed: `mainnet`, `testnet`, `devnet`. Do not add new modes.

A mode is **enabled** only if `chainKeys` has at least two entries (bridging requires a source and destination chain). Disabled modes are hidden from the UI mode switcher.

```json
{
  "appModes": {
    "default": "devnet",
    "configs": {
      "mainnet": {
        "label": "Mainnet",
        "bridgeAddress": "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe",
        "aggkitProxy": "https://mainnet-aggkit-proxy.example.com",
        "chainKeys": ["MAINNET", "KATANA", "FORKNET"],
        "defaultFromChainKey": "MAINNET",
        "defaultToChainKey": "KATANA"
      }
    }
  }
}
```

(This mirrors the committed `config.json`'s shape, minus the real values — its `mainnet`
and `testnet` `aggkitProxy` are `PLACEHOLDER-*` URLs, since no real aggkit-proxy is
deployed for them yet. See [`aggkitProxy` vs. `aggkitBridgeApis`](#aggkit-bridge-apis-aggkitproxy-vs-aggkitbridgeapis)
above for the `aggkitBridgeApis` map-form shape, still fully supported by the schema.)

### Mode config fields

| Field | Required | Description |
|-------|----------|-------------|
| `label` | Yes | Display label in the mode switcher |
| `bridgeAddress` | Yes | Bridge contract address |
| `aggkitProxy` | Conditional | A single URL fronting every network in this mode via one multiplexing aggkit-proxy. Mutually exclusive with `aggkitBridgeApis` — declare one or neither, never both (see [Validation](#validation)). |
| `aggkitBridgeApis` | Conditional | Object mapping L2 networkId (string keys) to aggkit REST base URLs (without `/bridge/v1` suffix), for a mode with distinct per-network backends. Mutually exclusive with `aggkitProxy`. May be `{}` or omitted as the "not yet configured" escape hatch. |
| `chainKeys` | Yes | Array of chain keys from `chains` (need >= 2 to enable) |
| `defaultFromChainKey` | No | Default source chain (defaults to first in `chainKeys`) |
| `defaultToChainKey` | No | Default destination chain (defaults to second in `chainKeys`) |

### Testing Default: appModes.default

The committed `config.json` ships with `appModes.default` set to `"testnet"`. Devnet
mode is opt-in: CI copies `config/config.ci.devnet.json` over it (see below), and
`scripts/kurtosisDevnetEnv.mjs` rewrites it in place for a live Kurtosis enclave.
Never commit a `config.json` left in `"devnet"` mode.

### `config/config.ci.devnet.json` — the CI fixture

`config/config.ci.devnet.json` is a **fixed-port** sibling of the committed `config.json`, used only by `.github/workflows/e2e.yaml`'s "Configure devnet fixture" step:

```bash
cp config/config.ci.devnet.json config.json
pnpm run validate:config
```

It is **byte-identical to the committed `config.json` except for a single key**:
`appModes.default` is `"devnet"` instead of `"testnet"`. Everything else it relies on
is already in the committed file:

- `chains` already carries the three fixed-URL entries — `DEVNET_L1` (chain id `271828`), `DEVNET_L2_001` (`20201`), `DEVNET_L2_002` (`20202`) — with `rpcUrl` pointed at `http://127.0.0.1:8555/l1rpc`, `/l2rpc-001`, `/l2rpc-002` respectively. `8555` is the vendored compose bundle's fixed haproxy port (`DEVNET_PROXY_PORT`, see [`tests/devnet/README.md`](../tests/devnet/README.md) and kurtosis-cdk's [Anvil-Flavor DevUI Snapshot](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/anvil-devui-snapshot.md#the-bundle-contract) doc), never an ephemeral `kurtosis port print` value — this file is only valid against the fixed-port compose bundle, not a live Kurtosis enclave (use `scripts/kurtosisDevnetEnv.mjs` for that instead, which writes the committed `config.json` directly).
- `appModes.configs.devnet.chainKeys` is already `["DEVNET_L1", "DEVNET_L2_001", "DEVNET_L2_002"]`, `bridgeAddress` is the deterministic devnet bridge address `0xC8cbEBf950B9Df44d987c8619f092beA980fF038`, and `aggkitProxy` is `http://127.0.0.1:8555/aggkitapi` — the single aggkit-proxy origin fronting both L2s, selected per-network server-side via `?network_id=`.

This file is committed and never overwrites `config.json` in git — the workflow copies it over the working tree's `config.json` inside the CI job only, and no step ever commits the result. Run `pnpm run validate:config -- config/config.ci.devnet.json` to validate it directly without copying it over `config.json` first.

## Tokens

On first load, the UI shows **only the native gas token** for each configured chain. Users can import additional tokens via the UI. Imported tokens are stored in local storage and can be removed.

## Environment Variables

Required: none.

Optional:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_PROJECT_ID` | WalletConnect project ID; optional, placeholder → graceful degradation (see README) |
| `NEXT_PUBLIC_AGGKIT_PROXY` | Bare URL (or origin-relative path); fanned out over every non-L1 network ID in every app mode, overriding `aggkitProxy` (and, for a map-form mode, acting as if it declared `aggkitProxy` too). Used for ephemeral devnet proxies. **Build-time only — has no effect in a prebuilt container image** (see [`docs/docker.md`](./docker.md)); the mounted `config.json` is the only configuration mechanism there. |
| `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` | JSON string (`{"networkId":"url"}`); shallow-merged over the active mode's resolved per-network map, applied identically to every app mode. Used for ephemeral devnet proxies, or to override one specific network's URL. **Build-time only — has no effect in a prebuilt container image** (see [`docs/docker.md`](./docker.md)); the mounted `config.json` is the only configuration mechanism there. |

Set them in `.env.local`:
```bash
cp .env.example .env.local
# Optionally set NEXT_PUBLIC_PROJECT_ID (see README for degraded-mode behavior)
# Optionally set NEXT_PUBLIC_AGGKIT_PROXY or NEXT_PUBLIC_AGGKIT_BRIDGE_APIS for devnet/kurtosis setups
```

## Migration from Bridge Hub API (Old Config)

If you have an older `config.json` using `bridgeHubApiBaseUrl` and `proofApiSuffix`, update it to the new `aggkitBridgeApis` format:

**Old format (no longer supported):**
```json
{
  "bridgeHubApiBaseUrl": "http://localhost:8080",
  "appModes": {
    "configs": {
      "mainnet": {
        "proofApiSuffix": "mainnet"
      }
    }
  }
}
```

**New format:**
```json
{
  "appModes": {
    "configs": {
      "mainnet": {
        "aggkitBridgeApis": {
          "20": "http://localhost:8080"
        }
      }
    }
  }
}
```

The validator will reject the old format with a clear error message pointing you to the new fields.

## Validation

Run config validation locally before opening a PR:

```bash
pnpm run validate:config
```

To vet a config file that is not the repo-root `config.json` — for example a candidate
file you are about to mount into the Docker image (see [`docs/docker.md`](./docker.md)) —
pass its path:

```bash
pnpm run validate:config -- /path/to/your/config.json
```

CI also runs this command before deployment. The app also validates config at startup through `config/configValidator.mjs`.

All absolute URLs in `config.json` must use the `http` or `https` scheme. Other schemes
(`javascript:`, `data:`, `file:`, …) are rejected: `externalLinks.*` and `explorerUrl`
are rendered into links and passed to `window.open`, so a non-http(s) scheme there would
be script execution in the app's origin.

Beyond the schema, the validator enforces one rule that applies to every mode regardless
of which field it uses, plus three cross-field rules that apply only to a mode using
`aggkitBridgeApis` (the per-network map form):

| Rule | Applies to | Rejected when |
|---|---|---|
| `aggkitProxy` / `aggkitBridgeApis` are mutually exclusive | Every mode | A mode declares both a non-empty `aggkitProxy` and a non-empty `aggkitBridgeApis` |
| Every non-L1 chain has a backend | `aggkitBridgeApis` only | A chain in `chainKeys` with `networkId !== 0` has no `aggkitBridgeApis` entry for that networkId |
| Every backend has a chain | `aggkitBridgeApis` only | An `aggkitBridgeApis` key matches no `networkId` among the mode's `chainKeys` |
| networkIds are unique | `aggkitBridgeApis` only | Two chains in `chainKeys` share a `networkId` (L1 chains, `networkId 0`, are exempt) |

The last three rules don't apply to a mode using `aggkitProxy`: one proxy fronts every
network in the mode by construction, so per-chain key agreement is meaningless for it —
this is exactly why a multi-L2 devnet used to hand-duplicate one URL under every network
ID in an `aggkitBridgeApis` map before `aggkitProxy` existed. The "networkIds are unique"
rule matters for the map form because `networkId` — not the chain id — is what keys
`aggkitBridgeApis` and what the SDK keys its per-network clients by. Two chains sharing a
networkId would collapse onto one backend and merge one chain's transactions into the
other's, while still satisfying the first two map-form rules.

**Since every shipped mode (`mainnet`, `testnet`, `devnet`) now uses `aggkitProxy`, none of
these three map-form checks currently guard the committed `config.json` at all** — that is
an inherent, by-design consequence of the single-proxy model, not a gap: with one backend
fronting every network in a mode, there is no per-chain key agreement left to check. The
checks remain fully active for any mode that *does* use the map form — in particular an
externally-generated `config.json` (e.g. kurtosis-cdk's, which still emits
`aggkitBridgeApis`) — where a genuine per-network wiring mistake is still possible and
still caught.

Setting a mode's `aggkitBridgeApis` to `{}`, or omitting it (and `aggkitProxy`) entirely,
marks that mode "not yet configured" and exempts it from all three map-form rules. This
repo's own `mainnet`/`testnet` used to rely on that escape hatch before switching to
`aggkitProxy` placeholders (`PLACEHOLDER-mainnet-aggkit-proxy`, `PLACEHOLDER-testnet-aggkit-proxy`);
the escape hatch itself remains available for any map-form mode without a real backend yet.

If validation fails with errors like `Unrecognized key: "proofApiSuffix"` or `Unrecognized key: "bridgeHubApiBaseUrl"`, see the "Migration from Bridge Hub API" section above.

## Checklist: add a chain

1. Add the chain entry to `chains` in `config.json`.
2. Add the chain key to the desired mode's `chainKeys` array in `config.json`.

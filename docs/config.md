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
- `config/configLoader.mjs` — shared browser-safe validate-and-normalize path (also resolves a relative `aggkitProxy` URL — see below)
- `config/configLoaderNode.mjs` — Node-side loader (CLI scripts, `scripts/syncPublicConfig.mjs`)
- `app/configLoader.ts` — browser `fetch` adapter, used by the app's startup gate
- `app/config.ts` — transforms JSON into typed objects
- `app/types/config.ts` — type definitions
- `app/utils/config.ts` — config utilities

## Aggkit Bridge APIs: `aggkitProxy`

Each app mode's aggkit backend is configured with a single field:

| Field | Shape | Use when |
|---|---|---|
| `aggkitProxy` | A single URL (or origin-relative path) | One `aggkit-proxy` instance (PROXY + TRACKER components, see [`docs/deployment.md`](./deployment.md)) fronts **every** network in the mode, multiplexing by the `network_id` query parameter. This is every shipped mode's shape — `mainnet`, `testnet`, and `devnet` all use `aggkitProxy` in the committed `config.json`. |

The app appends `/bridge/v1` to whichever URL it resolves for a mode when making bridge
API requests.

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
the SDK, so every downstream consumer (the SDK aggregator, `app/utils/appMode.ts`) still
sees one URL per network — `aggkitProxy` only changes what you write in `config.json`, not
how the app calls aggkit.

`aggkitProxy` may be omitted entirely to mark a mode "not yet configured" — see
[Validation](#validation) below.

### Removed: the per-network `aggkitBridgeApis` map

Earlier versions of this schema also accepted `aggkitBridgeApis` — an object mapping L2
network IDs to distinct per-network aggkit REST base URLs, for a mode whose networks were
**not** behind one shared proxy — mutually exclusive with `aggkitProxy`. That field has
been **removed from the schema entirely** (`config/configSchema.mjs`'s `.strict()` check
now rejects it as an unrecognized key): every mode this app ships now goes through one
aggkit-proxy, so the per-network map no longer models anything this repo's own
`config.json` needs, and keeping a second, unused form around was pure surface area.

**This is a deliberate, temporary, tracked cross-repo skew, not an oversight:**
kurtosis-cdk's dev-ui config template
(`static_files/additional_services/bridge-ui/aggkit-dev-ui-config.json.tmpl`) still
generates the old `aggkitBridgeApis` field as of this writing. A config produced by that
template will fail this schema's validation (`Unrecognized key: "aggkitBridgeApis"`)
until that template is migrated to emit `aggkitProxy` instead — a follow-up tracked
separately, kurtosis-cdk-side.

If you have an existing `config.json` using `aggkitBridgeApis`, convert each entry to a
single `aggkitProxy` per mode. If a mode's networks genuinely have distinct, non-proxied
backends, there is currently no supported way to express that in this schema — front them
with an aggkit-proxy instance first (see [`docs/deployment.md`](./deployment.md)).

### Environment overrides

If set, `NEXT_PUBLIC_AGGKIT_PROXY` (a bare URL string) overrides every mode's `aggkitProxy`
value for that build environment: it is fanned out over every non-L1 network ID in every
app mode, exactly like a mode's own `aggkitProxy` field would be, and wins over the served
config.json when both are present.

This merge happens at page-load time, inside the app's config bootstrap — not at build
time — but the *value* of the variable is still fixed at build time, because Next.js
inlines `NEXT_PUBLIC_*` variables into the JS bundle when it builds.

**This override is build-time only and has no effect in a prebuilt container image.**
A published Docker image (see [`docs/docker.md`](./docker.md)) is built with it unset, so
the override is a structural no-op there — the mounted `config.json` is the *only*
configuration mechanism in a container. It remains useful for local dev and Cloudflare
Workers builds (see the Kurtosis setup below, and `.env.example`), where it is genuinely
evaluated at each build.

### Relative `aggkitProxy` URLs

An `aggkitProxy` value may be an absolute URL, or a single origin-relative path (exactly
one leading slash, e.g. `/aggkitapi`). A relative value is resolved against the page's own
origin (`window.location.origin` in the browser) the moment the config is loaded, so every
consumer downstream — the SDK, the tracker preflight check — only ever sees an absolute
URL. Protocol-relative values (`//host`) are deliberately rejected: they would change
origin, reintroducing the cross-origin surface that relative URLs exist to remove. This is
the single-origin reverse-proxy path described in [`docs/deployment.md`](./deployment.md)
(`/aggkitapi/* → aggkit-proxy`).

A relative URL is **only** accepted for `aggkitProxy`. `rpcUrl`, `explorerUrl`, and
`iconUrl` on a chain, and every `externalLinks` value, remain absolute-URL-only — wallets
require an absolute RPC URL, and explorer/icon/external links are inherently cross-origin.

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
5. Writes `.env.local` with `NEXT_PUBLIC_AGGKIT_PROXY` set to that same proxy URL, as a fallback override that takes effect at runtime (see [Environment overrides](#environment-overrides) above)

**Manual setup:**

1. Get the proxy port:
```bash
kurtosis port print cdk agglayer-dev-ui-proxy-002 http
# Example output: 127.0.0.1:33460
```

2. Set `NEXT_PUBLIC_AGGKIT_PROXY` to the proxy URL (matching `config.json`'s own `aggkitProxy` field, and what the automated setup above writes):
```bash
export NEXT_PUBLIC_AGGKIT_PROXY='http://127.0.0.1:33460/aggkitapi'
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
deployed for them yet. See [Aggkit Bridge APIs](#aggkit-bridge-apis-aggkitproxy) above.)

### Mode config fields

| Field | Required | Description |
|-------|----------|-------------|
| `label` | Yes | Display label in the mode switcher |
| `bridgeAddress` | Yes | Bridge contract address |
| `aggkitProxy` | Conditional | A single URL fronting every network in this mode via one multiplexing aggkit-proxy. May be omitted as the "not yet configured" escape hatch (see [Validation](#validation)). |
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
| `NEXT_PUBLIC_AGGKIT_PROXY` | Bare URL (or origin-relative path); fanned out over every non-L1 network ID in every app mode, overriding `aggkitProxy`. Used for ephemeral devnet proxies. **Build-time only — has no effect in a prebuilt container image** (see [`docs/docker.md`](./docker.md)); the mounted `config.json` is the only configuration mechanism there. |

Set them in `.env.local`:
```bash
cp .env.example .env.local
# Optionally set NEXT_PUBLIC_PROJECT_ID (see README for degraded-mode behavior)
# Optionally set NEXT_PUBLIC_AGGKIT_PROXY for devnet/kurtosis setups
```

## Migration from Bridge Hub API (Old Config)

If you have an older `config.json` using `bridgeHubApiBaseUrl` and `proofApiSuffix`, update it to the current `aggkitProxy` format:

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

**Current format:**
```json
{
  "appModes": {
    "configs": {
      "mainnet": {
        "aggkitProxy": "http://localhost:8080"
      }
    }
  }
}
```

The validator will reject the old format with a clear error message pointing you to the current field. If your `config.json` instead uses the intermediate per-network `aggkitBridgeApis` map (from a version of this app between the Bridge Hub API era and this one), see [Removed: the per-network `aggkitBridgeApis` map](#removed-the-per-network-aggkitbridgeapis-map) above.

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

### History: the retired per-network cross-field checks

Before the per-network `aggkitBridgeApis` map was removed from the schema (see
[Removed: the per-network `aggkitBridgeApis` map](#removed-the-per-network-aggkitbridgeapis-map)
above), the validator enforced three cross-field rules that applied only to a mode using
that map form:

| Retired rule | Rejected when |
|---|---|
| Every non-L1 chain has a backend | A chain in `chainKeys` with `networkId !== 0` had no `aggkitBridgeApis` entry for that networkId |
| Every backend has a chain | An `aggkitBridgeApis` key matched no `networkId` among the mode's `chainKeys` |
| networkIds are unique | Two chains in `chainKeys` shared a `networkId` (L1 chains, `networkId 0`, were exempt) |

These rules never applied to a mode using `aggkitProxy`: one proxy fronts every network in
the mode by construction, so per-chain key agreement is meaningless for it — this is
exactly why a multi-L2 devnet used to hand-duplicate one URL under every network ID in an
`aggkitBridgeApis` map before `aggkitProxy` existed. The "networkIds are unique" rule
mattered for the map form specifically because `networkId` — not the chain id — is what
keyed `aggkitBridgeApis` and what the SDK keys its per-network clients by; two chains
sharing a networkId would have collapsed onto one backend and merged one chain's
transactions into the other's, while still satisfying the other two map-form rules.

**With every shipped mode (`mainnet`, `testnet`, `devnet`) now on `aggkitProxy`, and the map
form removed from the schema entirely, this validator no longer performs any per-chain
networkId-agreement check at all** — that is an inherent, by-design consequence of the
single-proxy model, not a gap: with one backend fronting every network in a mode, there is
no per-chain key agreement left to check. There is currently no equivalent check for
`aggkitProxy` mode, and none is planned — inventing a replacement would be checking
something that structurally cannot go wrong for a single shared proxy.

If validation fails with errors like `Unrecognized key: "proofApiSuffix"`,
`Unrecognized key: "bridgeHubApiBaseUrl"`, or `Unrecognized key: "aggkitBridgeApis"`, see
the "Migration from Bridge Hub API" section above.

## Checklist: add a chain

1. Add the chain entry to `chains` in `config.json`.
2. Add the chain key to the desired mode's `chainKeys` array in `config.json`.

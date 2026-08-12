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
- `config/configLoader.mjs` — shared browser-safe validate-and-normalize path (also resolves relative `aggkitBridgeApis` URLs — see below)
- `config/configLoaderNode.mjs` — Node-side loader (CLI scripts, `scripts/syncPublicConfig.mjs`)
- `app/configLoader.ts` — browser `fetch` adapter, used by the app's startup gate
- `app/config.ts` — transforms JSON into typed objects
- `app/types/config.ts` — type definitions
- `app/utils/config.ts` — config utilities

## Aggkit Bridge APIs

The `aggkitBridgeApis` object in each app mode maps L2 network IDs (as strings) to aggkit REST base URLs. The app appends `/bridge/v1` to these URLs when making API requests.

```json
{
  "appModes": {
    "configs": {
      "devnet": {
        "aggkitBridgeApis": {
          "1": "http://127.0.0.1:33460/aggkitapi",
          "2": "http://127.0.0.1:33460/aggkitapi"
        }
      }
    }
  }
}
```

**Important:** In a multi-L2 devnet (2 L2s or more), the `aggkitBridgeApis` map can have **identical URLs for multiple network IDs**. This is correct and necessary — the URL points to the AggKit proxy, which multiplexes all networks via the `network_id` query parameter. The URL itself does not change per chain; the routing happens server-side based on the query parameter.

For mainnet/testnet modes with distinct per-network bridge services, use distinct URLs per network:
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

If set, the `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` environment variable (a JSON string) overrides the active mode's `aggkitBridgeApis` for that build environment.

**Precedence, stated explicitly:** the served `config.json` is always the base. If
`NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` is set, it is shallow-merged over the active mode's
`aggkitBridgeApis` (per network-id key), applied identically to every app mode. This
merge happens at page-load time, inside the app's config bootstrap — not at build time —
but the *value* of `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` itself is still fixed at build time,
because Next.js inlines `NEXT_PUBLIC_*` variables into the JS bundle when it builds.

**This override is build-time only and has no effect in a prebuilt container image.** A
published Docker image (see [`docs/docker.md`](./docker.md)) is built with
`NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` unset, so the merge is a structural no-op there — the
mounted `config.json` is the *only* configuration mechanism in a container. This variable
remains useful for local dev and Cloudflare Workers builds (see the Kurtosis setup below,
and `.env.example`), where it is genuinely evaluated at each build.

### Relative `aggkitBridgeApis` URLs

Each `aggkitBridgeApis` value may be an absolute URL, or a single origin-relative path
(exactly one leading slash, e.g. `/aggkitapi`). A relative value is resolved against the
page's own origin (`window.location.origin` in the browser) the moment the config is
loaded, so every consumer downstream — the SDK, the tracker preflight check — only ever
sees an absolute URL. Protocol-relative values (`//host`) are deliberately rejected: they
would change origin, reintroducing the cross-origin surface that relative URLs exist to
remove. This is the single-origin reverse-proxy path described in
[`docs/deployment.md`](./deployment.md) (`/aggkitapi/* → aggkit-proxy`).

Relative URLs are **only** accepted for `aggkitBridgeApis`. `rpcUrl`, `explorerUrl`, and
`iconUrl` on a chain, and every `externalLinks` value, remain absolute-URL-only —
wallets require an absolute RPC URL, and explorer/icon/external links are inherently
cross-origin.

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
4. Writes `config.json` with `chains.DEVNET_L1`, `chains.DEVNET_L2_001`, `chains.DEVNET_L2_002`
5. Writes `.env.local` with `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` pointing to `{1, 2}` under the same proxy URL

**Manual setup:**

1. Get the proxy port:
```bash
kurtosis port print cdk agglayer-dev-ui-proxy-002 http
# Example output: 127.0.0.1:33460
```

2. Set `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` with all L2 network IDs pointing to the same proxy URL:
```bash
# For a 2-L2 devnet (both under the same proxy):
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
        "aggkitBridgeApis": {
          "20": "https://katana-aggkit.example.com",
          "22": "https://forknet-aggkit.example.com"
        },
        "chainKeys": ["MAINNET", "KATANA", "FORKNET"],
        "defaultFromChainKey": "MAINNET",
        "defaultToChainKey": "KATANA"
      }
    }
  }
}
```

### Mode config fields

| Field | Required | Description |
|-------|----------|-------------|
| `label` | Yes | Display label in the mode switcher |
| `bridgeAddress` | Yes | Bridge contract address |
| `aggkitBridgeApis` | Yes | Object mapping L2 networkId (string keys) to aggkit REST base URLs (without `/bridge/v1` suffix) |
| `chainKeys` | Yes | Array of chain keys from `chains` (need >= 2 to enable) |
| `defaultFromChainKey` | No | Default source chain (defaults to first in `chainKeys`) |
| `defaultToChainKey` | No | Default destination chain (defaults to second in `chainKeys`) |

### Testing Default: appModes.default = "devnet"

**IMPORTANT:** The current `config.json` has `appModes.default` set to `"devnet"` for **testing convenience only**. This must be reverted to a production-appropriate default (e.g., `"mainnet"` or `"testnet"`) before any production release. See the release checklist (step S15) for details.

### `config/config.ci.devnet.json` — the CI fixture

`config/config.ci.devnet.json` is a **fixed-port** sibling of the committed `config.json`, used only by `.github/workflows/e2e.yaml`'s "Configure devnet fixture" step:

```bash
cp config/config.ci.devnet.json config.json
pnpm run validate:config
```

It differs from the committed `config.json` in exactly the ways CI needs:

- `appModes.default` is `"devnet"` (the committed file defaults to `"testnet"` — see above).
- `chains` adds three fixed-URL entries — `DEVNET_L1` (chain id `271828`), `DEVNET_L2_001` (`20201`), `DEVNET_L2_002` (`20202`) — with `rpcUrl` pointed at `http://127.0.0.1:8555/l1rpc`, `/l2rpc-001`, `/l2rpc-002` respectively. `8555` is the vendored compose bundle's fixed haproxy port (`DEVNET_PROXY_PORT`, see [`tests/devnet/README.md`](../tests/devnet/README.md) and kurtosis-cdk's [Anvil-Flavor DevUI Snapshot](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/anvil-devui-snapshot.md#the-bundle-contract) doc), never an ephemeral `kurtosis port print` value — this file is only valid against the fixed-port compose bundle, not a live Kurtosis enclave (use `scripts/kurtosisDevnetEnv.mjs` for that instead, which writes the committed `config.json` directly).
- `appModes.configs.devnet.chainKeys` is `["DEVNET_L1", "DEVNET_L2_001", "DEVNET_L2_002"]`, `bridgeAddress` is the deterministic devnet bridge address `0xC8cbEBf950B9Df44d987c8619f092beA980fF038`, and `aggkitBridgeApis` maps both L2 network ids (`1`, `2`) to `http://127.0.0.1:8555/aggkitapi` (the single aggkit-proxy origin, selected per-network via `?network_id=`).

This file is committed and never overwrites `config.json` in git — the workflow copies it over the working tree's `config.json` inside the CI job only, and no step ever commits the result. Run `pnpm run validate:config -- config/config.ci.devnet.json` to validate it directly without copying it over `config.json` first.

## Tokens

On first load, the UI shows **only the native gas token** for each configured chain. Users can import additional tokens via the UI. Imported tokens are stored in local storage and can be removed.

## Environment Variables

Required: none.

Optional:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_PROJECT_ID` | WalletConnect project ID; optional, placeholder → graceful degradation (see README) |
| `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` | JSON string (`{"networkId":"url"}`); overrides the active mode's `aggkitBridgeApis` from `config.json`. Used for ephemeral devnet proxies. **Build-time only — has no effect in a prebuilt container image** (see [`docs/docker.md`](./docker.md)); the mounted `config.json` is the only configuration mechanism there. |

Set them in `.env.local`:
```bash
cp .env.example .env.local
# Optionally set NEXT_PUBLIC_PROJECT_ID (see README for degraded-mode behavior)
# Optionally set NEXT_PUBLIC_AGGKIT_BRIDGE_APIS for devnet/kurtosis setups
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

Beyond the schema, the validator enforces three cross-field rules per app mode so a
mis-generated devnet config cannot silently drop a chain's data:

| Rule | Rejected when |
|---|---|
| Every non-L1 chain has a backend | A chain in `chainKeys` with `networkId !== 0` has no `aggkitBridgeApis` entry for that networkId |
| Every backend has a chain | An `aggkitBridgeApis` key matches no `networkId` among the mode's `chainKeys` |
| networkIds are unique | Two chains in `chainKeys` share a `networkId` (L1 chains, `networkId 0`, are exempt) |

The third rule matters because `networkId` — not the chain id — is what keys
`aggkitBridgeApis` and what the SDK keys its per-network clients by. Two chains sharing a
networkId would collapse onto one backend and merge one chain's transactions into the
other's, while still satisfying the first two rules.

Setting a mode's `aggkitBridgeApis` to `{}` marks it "not yet configured" and exempts it
from all three rules. That is how the mainnet/testnet placeholder modes stay valid before
real proxy URLs exist.

If validation fails with errors like `Unrecognized key: "proofApiSuffix"` or `Unrecognized key: "bridgeHubApiBaseUrl"`, see the "Migration from Bridge Hub API" section above.

## Checklist: add a chain

1. Add the chain entry to `chains` in `config.json`.
2. Add the chain key to the desired mode's `chainKeys` array in `config.json`.

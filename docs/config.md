# Configuration Guide

This app is configured through `config.json` at the project root. The JSON file is imported at build time and bundled with the app. The dev server hot-reloads changes to `config.json`.

Supporting files:
- `config/configSchema.mjs` — shared Zod schema (single source of truth)
- `config/configValidator.mjs` — schema + validator used by CLI and app startup
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

## Tokens

On first load, the UI shows **only the native gas token** for each configured chain. Users can import additional tokens via the UI. Imported tokens are stored in local storage and can be removed.

## Environment Variables

Required:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_PROJECT_ID` | WalletConnect project ID |

Optional:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` | JSON string (`{"networkId":"url"}`); overrides the active mode's `aggkitBridgeApis` from `config.json`. Used for ephemeral devnet proxies. |

Set them in `.env.local`:
```bash
cp .env.example .env.local
# Edit .env.local and set NEXT_PUBLIC_PROJECT_ID
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

CI also runs this command before deployment. The app also validates config at startup through `config/configValidator.mjs`.

If validation fails with errors like `Unrecognized key: "proofApiSuffix"` or `Unrecognized key: "bridgeHubApiBaseUrl"`, see the "Migration from Bridge Hub API" section above.

## Checklist: add a chain

1. Add the chain entry to `chains` in `config.json`.
2. Add the chain key to the desired mode's `chainKeys` array in `config.json`.

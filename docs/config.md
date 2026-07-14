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
          "1": "http://127.0.0.1:33460"
        }
      }
    }
  }
}
```

If set, the `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` environment variable (a JSON string) overrides the active mode's `aggkitBridgeApis` for that build environment.

### Kurtosis / Local Devnet Setup

When running agglayer against a Kurtosis enclave (local devnet), the aggkit service is accessed through an enclave proxy. Use the proxy's HTTP port and append `/aggkitapi`:

1. Get the proxy port from the enclave:
```bash
kurtosis port print cdk agglayer-dev-ui-proxy-001 http
# Example output: 127.0.0.1:33460
```

2. Set `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` with the L2 networkId as key:
```bash
# For a devnet L2 with networkId=1:
export NEXT_PUBLIC_AGGKIT_BRIDGE_APIS='{"1":"http://127.0.0.1:33460/aggkitapi"}'
```

3. (For **mainnet/testnet modes**: ensure the mode's `aggkitBridgeApis` in `config.json` contains the correct per-network URLs; the env override above only affects the active mode.)

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

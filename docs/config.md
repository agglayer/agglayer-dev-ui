# Configuration Guide

This app is configured through `config.json` at the project root. The JSON file is imported at build time and bundled with the app. The dev server hot-reloads changes to `config.json`.

Supporting files:
- `config/configSchema.mjs` — shared Zod schema (single source of truth)
- `config/configValidator.mjs` — schema + validator used by CLI and app startup
- `app/config.ts` — transforms JSON into typed objects
- `app/types/config.ts` — type definitions
- `app/utils/config.ts` — config utilities

## Bridge Hub API

Set `bridgeHubApiBaseUrl` in `config.json`. The app appends `/{proofApiSuffix}/` per mode when building API requests.

```json
{
  "bridgeHubApiBaseUrl": "http://localhost:8080"
}
```

If set, `NEXT_PUBLIC_BRIDGE_HUB_API` overrides `bridgeHubApiBaseUrl` for that build environment.

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
    "default": "testnet",
    "configs": {
      "mainnet": {
        "label": "Mainnet",
        "bridgeAddress": "0x...",
        "proofApiSuffix": "mainnet",
        "chainKeys": ["MAINNET", "KATANA"],
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
| `proofApiSuffix` | Yes | Path suffix appended to `bridgeHubApiBaseUrl` |
| `chainKeys` | Yes | Array of chain keys from `chains` (need >= 2 to enable) |
| `defaultFromChainKey` | No | Default source chain (defaults to first in `chainKeys`) |
| `defaultToChainKey` | No | Default destination chain (defaults to second in `chainKeys`) |

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
| `NEXT_PUBLIC_BRIDGE_HUB_API` | Overrides `bridgeHubApiBaseUrl` from `config.json` for the active environment |

Set it in `.env.local`:
```bash
cp .env.example .env.local
```

## Validation

Run config validation locally before opening a PR:

```bash
npm run validate:config
```

CI also runs this command before deployment. The app also validates config at startup through `config/configValidator.mjs`.

## Checklist: add a chain

1. Add the chain entry to `chains` in `config.json`.
2. Add the chain key to the desired mode's `chainKeys` array in `config.json`.

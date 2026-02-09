# Configuration Guide

This app is configured primarily through `app/config.ts`. Types and helpers live in:
- `app/types/config.ts`
- `app/utils/config.ts`
- `app/constants/bridge.ts`

The goal is to keep `app/config.ts` as the single, user-editable source of truth.

## App Modes

Supported modes are fixed: `mainnet`, `testnet`, `devnet`.
Do not add new modes.

A mode is **enabled** only if `chains` has at least two entries (bridging requires a from + to chain). Disabled modes are filtered from the mode switcher.

Defaults:
- `DEFAULT_APP_MODE` is used only if it is enabled.
- If `defaultFromChainId` / `defaultToChainId` are omitted, the first two chains in the mode are used.

## Chains

All chains must be represented in `CHAIN_REGISTRY`. It powers:
- `ALL_WAGMI_CHAINS` for wallet/connectivity
- `APP_MODE_CONFIG.*.chains` for the UI + SDK

Add a chain with `createChainEntry`:

```ts
const MY_CHAIN = createChainEntry({
  wagmi: myWagmiChain,
  icon: 'https://example.com/my-chain-icon.svg',
  networkId: 42,
  isTestnet: true,
  eta: 120,
  rpcUrl: 'https://rpc.my-chain.org', // optional override
  explorer: 'https://explorer.my-chain.org', // optional override
  nativeLogoURI: ICONS.myToken, // optional override
});
```

Then include it:
```ts
const CHAIN_REGISTRY = { ... , MY_CHAIN };
```

### ChainEntryParams (summary)
- `wagmi`: Wagmi `Chain` object (use built-ins or define a custom one)
- `icon`: chain icon URL
- `networkId`: AggLayer network id
- `isTestnet`: boolean
- `eta`: estimated bridging time in minutes
- `rpcUrl` (optional): override for the app’s RPC URL
- `explorer` (optional): override block explorer URL
- `nativeLogoURI` (optional): override native token logo

### Custom chains + RPCs

If a chain is not available in `wagmi/chains`, define a custom wagmi chain and pass it to `createChainEntry`.

`customRpcUrls` is used by the wallet adapter. It maps CAIP-2 chain ids (e.g. `eip155:1101`) to RPC endpoints for any chain.

Example:
```ts
export const customRpcUrls = {
  'eip155:1101': [{ url: 'https://rpc.example.org' }],
};
```

## External Links

`EXTERNAL_LINKS` live in `app/config.ts`. Supported keys:
- `PRIVACY_POLICY`
- `TERMS_OF_USE`
- `CONTACT_SUPPORT`

Any link can be set to an empty string to hide it in the UI.

## Tokens

On first load, the UI is seeded with **only the native gas token** for each configured chain.
Users can import additional tokens via the UI. Imported tokens are stored in local storage.
Custom tokens can also be removed from the UI.

## SDK + Bridge Hub API

Bridging is powered by the AggLayer SDK. Proof generation and transaction data come from the [Bridge Hub API](https://github.com/agglayer/agglayer-bridge-hub-api).

Set `NEXT_PUBLIC_BRIDGE_HUB_API` in your environment.

The app appends `/{mode}` (`mainnet`, `testnet`, `devnet`) when building API requests, so the base URL should not include the mode segment.

Examples:
```bash
# local dev
NEXT_PUBLIC_BRIDGE_HUB_API=http://localhost:8080
```

## Checklist: add a chain

1) Add or import the wagmi chain (with RPCs if needed).
2) Create a `ChainEntry` via `createChainEntry`.
3) Register it in `CHAIN_REGISTRY`.
4) Include it in the desired `APP_MODE_CONFIG.*.chains` arrays.

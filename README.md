# Agglayer Dev UI

> [!WARNING]
> **This service is deprecated and being retired alongside agglayer-ui.**
>
> Per the 2026-07-23 Apps Team product review, this developer/debug UI for
> AggLayer is being wound down as the AggLayer surface moves to Trails
> (Sequence team, Taylan Pince).
>
> No new features should be added here. This repository will be archived once
> agglayer-ui's migration to Trails is complete.

The Agglayer Dev UI is a configurable, self-hosted bridging interface powered by the [Agglayer SDK](https://github.com/agglayer/sdk) and the [Bridge Hub API](https://github.com/agglayer/agglayer-bridge-hub-api).

## Quickstart

1) Install dependencies:

```bash
pnpm install
```

2) Configure the app:

Edit `config.json` at the project root to set chains, app modes, Bridge Hub API URL, and external links. See [`docs/config.md`](docs/config.md) for the full guide.

Set `NEXT_PUBLIC_PROJECT_ID` (WalletConnect project ID) in `.env.local`.
Optionally set `NEXT_PUBLIC_BRIDGE_HUB_API` to override `config.json` per environment:

```bash
cp .env.example .env.local
```

3) Run the dev server:

```bash
pnpm run dev
```

Open `http://localhost:3000`.

## Scripts

- `pnpm run dev` — start dev server
- `pnpm run build` — production build
- `pnpm run start` — run production server
- `pnpm run lint` — lint
- `pnpm run validate:config` — validate `config.json`
- `pnpm run typecheck` — TypeScript checks
- `pnpm run test` — unit tests (Vitest)
- `pnpm run test:e2e` — end-to-end tests (Playwright)

## Testing

Playwright E2E runs against real testnet infrastructure using a funded E2E wallet.

Security and ops notes:

- The E2E private key is injected into the browser runtime for automated signing. Never reuse a real wallet key.
- Keep the E2E wallet balance minimal and treat it as disposable.
- Never deploy with `NEXT_PUBLIC_E2E_ENABLED=true` in any public/shared environment.
- Set only `E2E_PRIVATE_KEY` in `.env.local` for tests. Do not set `NEXT_PUBLIC_E2E_PRIVATE_KEY` directly.
- Testnet spend accumulates over CI runs; periodically top up the E2E wallet.

Required `.env.local` variables for E2E:

- `E2E_PRIVATE_KEY`
- `NEXT_PUBLIC_PROJECT_ID`
- `NEXT_PUBLIC_BRIDGE_HUB_API`

Hardcoded E2E test constants:

- from chain: Sepolia (`11155111`)
- to chain: Bokuto (`737373`)
- ERC20 address: Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`)
- ERC20 metadata (symbol, name, decimals) is fetched on-chain from the contract
- native bridge amount: `0.00001`
- ERC20 bridge amount: `0.01`

## Configuration

All app configuration lives in `config.json` at the project root. See [`docs/config.md`](docs/config.md) for the full guide.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

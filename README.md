# Agglayer Dev UI

The Agglayer Dev UI is a configurable, self-hosted bridging interface powered by the [Agglayer SDK](https://github.com/agglayer/sdk) and the [Bridge Hub API](https://github.com/agglayer/agglayer-bridge-hub-api).

## Quickstart

1) Install dependencies:

```bash
npm install
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
npm run dev
```

Open `http://localhost:3000`.

## Scripts

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run start` — run production server
- `npm run lint` — lint
- `npm run validate:config` — validate `config.json`
- `npm run typecheck` — TypeScript checks
- `npm run test` — end-to-end tests (Playwright)
- `npm run test:e2e` — end-to-end tests (Playwright)

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
- `NEXT_PUBLIC_E2E_WALLET_ADDRESS`
- `NEXT_PUBLIC_PROJECT_ID`
- `NEXT_PUBLIC_BRIDGE_HUB_API`

Hardcoded E2E test constants:

- from chain: Sepolia (`11155111`)
- to chain: Bokuto (`737373`)
- ERC20 address: Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`)
- ERC20 metadata: `USDC` / `USD Coin` / `6`
- native bridge amount: `0.00001`
- ERC20 bridge amount: `0.01`

## Configuration

All app configuration lives in `config.json` at the project root. See [`docs/config.md`](docs/config.md) for the full guide.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

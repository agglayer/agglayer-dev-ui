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

## Configuration

All app configuration lives in `config.json` at the project root. See [`docs/config.md`](docs/config.md) for the full guide.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

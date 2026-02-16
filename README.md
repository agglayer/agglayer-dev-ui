# Agglayer Dev UI

The Agglayer Dev UI is a configurable, self-hosted bridging interface powered by the [Agglayer SDK](https://github.com/agglayer/sdk) and the [Bridge Hub API](https://github.com/agglayer/agglayer-bridge-hub-api).

## Quickstart

1) Install dependencies:

```bash
npm install
```

2) Configure environment variables:

```bash
cp .env.example .env.local
```

Set `NEXT_PUBLIC_PROJECT_ID` (WalletConnect project ID) and `NEXT_PUBLIC_BRIDGE_HUB_API` (Bridge Hub API base URL, required) in `.env.local`.

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
- `npm run typecheck` — TypeScript checks
- `npm run test` — end-to-end tests (Playwright)
- `npm run test:e2e` — end-to-end tests (Playwright)

## Docker

Run the image with a custom chain configuration by mounting your own `config.json`:

```bash
docker run -p 8080:80 -v ./config.json:/usr/share/nginx/html/config.json:ro ghcr.io/agglayer/agglayer-dev-ui:<tag>
```

See `public/config.json` for the expected format.

## Configuration

All app configuration lives in `public/config.json` and is loaded at runtime. See [`docs/config.md`](docs/config.md) for the full guide.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.

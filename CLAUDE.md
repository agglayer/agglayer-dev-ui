## Team Standards

**Skip this fetch if team-standards.md is already loaded in your
context** (this happens when running from the apps-team-workspace).
Otherwise, **at the start of every session**, before doing any other
work, use the WebFetch tool to retrieve the Polygon Apps Team standards
from:
<https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md>

Follow all instructions in that document for the duration of this session.
If the fetch fails (network error, URL unreachable), inform the user that
team standards could not be loaded, then proceed with repo-specific rules
below.

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working
with code in this repository.

## What this repo is

`agglayer-dev-ui` is a configurable, self-hosted bridging interface
powered by the [Agglayer SDK](https://github.com/agglayer/sdk) and the
[aggkit bridge service](https://github.com/agglayer/aggkit) REST API.
It is a Next.js 16 **static-export** app (`output: 'export'`) deployed
to Cloudflare Workers via `wrangler`. There are no API routes, no
middleware, no SSR.

## Source layout

Two top-level directories hold source:

- `app/` — Next.js App Router (routes, layouts, components, hooks,
  context, services, types, utils consumed by the app)
- `src/` — also present, mirrors the same subdirectory shape; check
  both when looking for a file

`config.json` at the repo root is the source of truth for chains, app
modes (mainnet / testnet / devnet), bridge addresses, and external
links. `scripts/validateConfig.mjs` validates its shape; run via
`pnpm run validate:config`.

## Commands

Read `package.json` for the canonical list. Highlights:

- `pnpm run dev` — Next dev server
- `pnpm run build` / `pnpm run build:production` — Next build (the
  `:production` variant copies `.env.production` into `.env.local`
  before building)
- `pnpm run lint`, `pnpm run typecheck`, `pnpm run test` (Vitest unit
  tests), `pnpm run test:e2e` (Playwright)
- `pnpm run check` — runs validate:config + lint + typecheck + test

## Wallet integration: Reown is permanent

The apps-team standards prefer `@0xsequence/connect`, but this app
**stays on `@reown/appkit*` indefinitely**. Sequence Connect does not
support some Agglayer-specific chains; Reown does. Treat the team's
"migrate to Sequence" guidance as not applicable here and do not flag
Reown in reviews or future assessments.

Practical consequence in `pnpm-workspace.yaml`: an `overrides` entry
pins `@wagmi/connectors` to `^5.9.9`. Reown's adapter declares
`@wagmi/connectors >= 5.9.9` as an optional dep, which without the
override resolves to v8 (the wagmi-v3 ecosystem) and breaks the Next
build (`Can't resolve '@wagmi/core/tempo'`). The override forces the
v5 line that matches `wagmi@2.x`.

For the same reason, **stay on `wagmi@^2.x`**. Reown 1.8.x's optional
deps and tested peer surface target the v2 ecosystem. wagmi v3 may
work but is not Reown's tested configuration.

## Other known deferrals

These are deliberate gaps against the apps-team standards, tracked but
out of scope for general-purpose changes:

- **Vite migration** — this is a static-export Next.js app and a known
  migration candidate, but not now.
- **Three-tier `tsconfig`** — single-package Next.js app, the three-tier
  shape doesn't apply.
- **Changesets** — repo is `private: true` and never published to npm.

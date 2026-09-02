# syntax=docker/dockerfile:1
#
# Multi-stage build for agglayer-dev-ui: Node/pnpm build -> static export ->
# nginx:alpine runtime. Runtime-configurable via a mounted config.json (see
# entrypoint.sh) -- no Node, pnpm, source, or node_modules ship in the final
# image.
#
# Build from the repo root, identically locally and in CI:
#   docker build -t agglayer-dev-ui .

# =============================================================================
# Stage: app-builder
# =============================================================================
FROM node:24-slim AS app-builder

# Pin to pnpm 10.30.3 per package.json's packageManager field, on Node 24 per
# .nvmrc / package.json engines.node -- do not mirror whatever Node version
# happens to run the local shell.
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy only the manifests needed to resolve the dependency graph first, so
# this (expensive) layer is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Proven (D-1/D-2) to cleanly skip the `prepare` script's git-hooks install --
# there is no .git directory in this build context, so husky would otherwise
# fail with ".git can't be found" noise.
ENV HUSKY=0
RUN pnpm install --frozen-lockfile

COPY . .

# A-1 §6.3(a) binding constraint: the builder must NOT set or forward
# NEXT_PUBLIC_AGGKIT_PROXY. It is a build-time-only affordance for local dev /
# Cloudflare Workers builds (baked into the JS bundle by Next at build time);
# in a container the mounted config.json is the only configuration mechanism
# (see entrypoint.sh). build:production also copies .env.production over
# .env.local and deletes .env.staging -- .env.production is deliberately
# empty of NEXT_PUBLIC_* values (see its own header comment), so this build
# never bakes in a WalletConnect/Reown project id, an aggkit-proxy override,
# or any E2E value. The project id is a RUNTIME value instead: it comes from
# the mounted config.json's `walletConnect.projectId` field (see
# entrypoint.sh's structural validation and docs/config.md), settable per
# container instance with no rebuild. A container run with no real project
# id mounted (or the baked default's placeholder) runs Reown AppKit in the
# documented degraded `basic: true` mode -- see app/context/wallet.tsx.
RUN pnpm run build:production

# =============================================================================
# Stage: runtime
# =============================================================================
FROM nginx:alpine AS runtime

# jq is used by entrypoint.sh for a structural (non-schema) validation check
# of a mounted config.json. This runtime image has no Node, so the app's own
# Zod schema (config/configSchema.mjs) cannot run here -- see entrypoint.sh's
# header comment for the explicit limitations of the jq-based check.
RUN apk add --no-cache jq

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=app-builder /app/out /usr/share/nginx/html
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# See nginx.conf for the listen directive this matches.
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]

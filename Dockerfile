# syntax=docker/dockerfile:1
#
# Multi-stage build for agglayer-dev-ui: Node/pnpm build -> static export ->
# nginx:alpine runtime. Runtime-configurable via a mounted config.json (see
# entrypoint.sh) -- no Node, pnpm, source, or node_modules ship in the final
# image.
#
# Build from the repo root, identically locally and in CI:
#   docker build -t agglayer-dev-ui .
#
# Locally, .sdk-src/ must be populated first (see scripts/stage-sdk-src.sh
# and plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §4.1):
#   scripts/stage-sdk-src.sh
#   docker build -t agglayer-dev-ui .

# =============================================================================
# Stage: sdk-builder
# TEMPORARY -- remove per plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §5
#
# @agglayer/sdk's aggkit bridge APIs are not published yet (dev-ui's
# pnpm-workspace.yaml overrides '@agglayer/sdk' to 'file:../sdk'). This stage
# builds the sdk from tracked source staged at .sdk-src/ (git-archive'd from a
# sibling checkout locally, or a second actions/checkout in CI -- see the ADR)
# so that `pnpm install --frozen-lockfile` in the app-builder stage below can
# resolve that file: override without any sibling directory existing on the
# host/runner. Retire this stage entirely once a published @agglayer/sdk
# version above 1.0.0-beta.30 carries the aggkit APIs (ADR §5).
# =============================================================================
FROM oven/bun:1 AS sdk-builder

WORKDIR /sdk
COPY .sdk-src/ ./
# Same reason as the app-builder stage below: agglayer/sdk also declares a
# husky `prepare` script. Set here too so this stage behaves identically
# whether or not a .git happened to reach the context.
ENV HUSKY=0
RUN bun install --frozen-lockfile && bun run build

# =============================================================================
# Stage: app-builder
# =============================================================================
FROM node:24-slim AS app-builder

# Pin to pnpm 10.30.3 per package.json's packageManager field, on Node 24 per
# .nvmrc / package.json engines.node -- do not mirror whatever Node version
# happens to run the local shell.
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# TEMPORARY -- remove per plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §5
# Container-side path /sdk is the load-bearing invariant: pnpm resolves the
# pnpm-workspace.yaml `'@agglayer/sdk': 'file:../sdk'` override relative to
# WORKDIR (/app below), so the built sdk must land one level up, at /sdk.
COPY --from=sdk-builder /sdk /sdk

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

# TEMPORARY -- remove per plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §5
# Records which unreleased @agglayer/sdk commit is embedded in this image, so
# a published digest is self-describing. Fed via --build-arg SDK_REF=<sha>:
# in CI (W-1), the pinned SDK_REF workflow env; locally, the SHA printed by
# scripts/stage-sdk-src.sh. Declared here (not just in the runtime stage)
# purely for documentation proximity to the sdk-builder stage; the LABEL
# instruction that actually stamps the final image lives in the runtime
# stage below, since labels on intermediate build stages are not carried
# into the final image.
ARG SDK_REF=unknown

# A-1 §6.3(a) binding constraint: the builder must NOT set or forward
# NEXT_PUBLIC_AGGKIT_BRIDGE_APIS. That variable is a build-time-only
# affordance for local dev / Cloudflare Workers builds (baked into the JS
# bundle by Next at build time); in a container the mounted config.json is
# the only configuration mechanism (see entrypoint.sh). build:production
# also copies .env.production over .env.local and deletes .env.staging --
# .env.production contains only a NEXT_PUBLIC_PROJECT_ID placeholder, so
# this image runs Reown AppKit in the documented degraded `basic: true` mode.
RUN pnpm run build:production

# =============================================================================
# Stage: runtime
# =============================================================================
FROM nginx:alpine AS runtime

# TEMPORARY -- remove per plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §5
ARG SDK_REF=unknown
LABEL org.agglayer.sdk.revision="${SDK_REF}"

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

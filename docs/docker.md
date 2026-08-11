# Docker Image

This is the consumption contract for the `agglayer-dev-ui` container image: what it is,
how to configure it, and how a new build gets published. It is written to stand alone —
you should not need any other document in this repo to run the image.

## Status: no image is published yet

**As of this writing, no image has ever been pushed to GHCR.** The publish workflow
(`.github/workflows/docker-publish.yaml`) exists and builds successfully in isolated
verification runs, but it has not yet executed as a real, triggered GitHub Actions run
in this repository, and the GHCR package does not exist. Do not attempt to `docker pull`
the reference below yet.

Once the first image is published (by a `release: published` event or a manual
`workflow_dispatch` run), the GHCR package will start out **private**, matching this
repo's visibility. An organization admin must explicitly flip the package's visibility
to public/internal before `docker pull` will work for anyone outside the org, even
after a successful publish.

## Image reference

```
ghcr.io/agglayer/agglayer-dev-ui:<tag>
```

### Tag scheme

Tags are computed by the "Compute image tags" step in
`.github/workflows/docker-publish.yaml:129-189`:

| Trigger | Tags produced |
|---|---|
| GitHub Release, non-prerelease, semver `X.Y.Z` (or `vX.Y.Z`) | `X.Y.Z`, `X.Y`, `latest` |
| GitHub Release, prerelease (either the GitHub "prerelease" flag, or a semver `-suffix` such as `1.2.3-rc.1`) | `X.Y.Z` (or `X.Y.Z-suffix`) only — never `X.Y`, never `latest` |
| `workflow_dispatch` | `dispatch-<sanitized-ref>-<short-sha>-<run-id>` |

Every dispatch tag carries the literal `dispatch-` prefix, which cannot collide with a
semver tag or with `latest` — see the workflow's header comment
(`.github/workflows/docker-publish.yaml:29-44`) for why this is a structural guarantee,
not just a runtime check (the workflow also asserts it at runtime as defense in depth).

## Ports

The container listens on port **80** (`Dockerfile:111` `EXPOSE 80`, matching
`nginx.conf:4` `listen 80;`).

```bash
docker run -p 8080:80 ghcr.io/agglayer/agglayer-dev-ui:<tag>
```

## Configuration: mounting `config.json`

The image is configured entirely through a single JSON file, bind-mounted at:

```
/etc/agglayer-dev-ui/config.json
```

(`entrypoint.sh:36` `MOUNTED_CONFIG="/etc/agglayer-dev-ui/config.json"`.) The schema is
documented in [`docs/config.md`](./config.md).

### Copy-pasteable example

```bash
docker run -d \
  --name agglayer-dev-ui \
  -p 8080:80 \
  -v /path/to/your/config.json:/etc/agglayer-dev-ui/config.json:ro \
  ghcr.io/agglayer/agglayer-dev-ui:<tag>
```

Then open `http://localhost:8080`.

### Mounting is effectively mandatory

The image ships with a **baked-in default config** — the repo's own committed root
`config.json`, copied into the webroot at build time (`Dockerfile:106`
`COPY --from=app-builder /app/out /usr/share/nginx/html`). That default's `mainnet` and
`testnet` app modes point `aggkitBridgeApis` at placeholder hosts
(`https://PLACEHOLDER-katana-aggkit`, `https://PLACEHOLDER-forknet-aggkit`,
`https://PLACEHOLDER-bokuto-aggkit`) that do not resolve. The baked default **passes
validation and starts the container, but does not work end-to-end** for any mode that
talks to a real aggkit backend. If you run the image with no `-v` mount, the entrypoint
prints a loud warning to this effect (`entrypoint.sh:89-97`) and serves the baked default
anyway — it does not refuse to start. Treat mounting a real `config.json` as a required
step, not an optional override.

Separately, because `NEXT_PUBLIC_PROJECT_ID` (the Reown/WalletConnect project ID) is
baked into the JS bundle at build time and the image is built from `.env.production`
(which contains only a placeholder value — see `Dockerfile:80-88`), **the published
image always runs Reown AppKit in degraded `basic: true` mode**: injected-wallet connect
works, but WalletConnect-cloud features (wallet directory images, remote config) are
skipped. This is not something a mounted `config.json` can change — `config.json` has no
field for it, and there is currently no way to set a real project ID in a prebuilt image.

### Precedence: mounted file vs. baked default

There are exactly two states, decided once at container start by `entrypoint.sh:72-98`:

1. **A regular file exists at `/etc/agglayer-dev-ui/config.json`.** It is validated
   (see below). If valid, it is copied over the webroot's `config.json`
   (`entrypoint.sh:78` `cp "$MOUNTED_CONFIG" "$WEBROOT_CONFIG"`) and served from then on.
   If invalid, the container **exits immediately with a non-zero status** and never
   starts nginx (`entrypoint.sh:75-77`).
2. **Nothing is mounted.** The baked-in default (the webroot's own `config.json`, copied
   in at build time) is served unmodified, after printing the warning described above.

There is no merge of the two, and no environment-variable-based configuration mechanism
at all in the container — the entrypoint does **not** read `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS`
or any other env var to synthesize or override config (see
[`docs/config.md`](./config.md#environment-variables) for why that variable has no
effect here). The mounted file (or the baked default, if nothing is mounted) is the
single, only source of configuration.

If the host path passed to `-v` does not exist, Docker creates an empty directory at the
container-side mount point rather than failing the `docker run` — this is a classic typo
failure mode. The entrypoint detects that case specifically (a path that exists but is
not a regular file) and fails loudly with a dedicated message rather than silently
falling through to the baked default (`entrypoint.sh:80-88`).

### Validation is structural only — not a substitute for the app's schema

The runtime (`nginx:alpine`) stage has no Node.js, so the app's real validator
(`config/configValidator.mjs`, a Zod schema) cannot run inside the container. The
entrypoint instead runs a **`jq`-based structural check** (`entrypoint.sh:44-70`), which
verifies only:

1. The file is well-formed JSON (`jq empty`).
2. A small set of required top-level fields exist and have the right JSON *type*:
   - `chains` is a non-empty object
   - `appModes.default` is a string
   - `appModes.configs` is a non-empty object **containing the key named by
     `appModes.default`**
   - `autoclaim` is an object
   - `externalLinks` is an object

**This check does not validate:** URL formats or reachability, individual chain object
shapes, `chainKeys` entries referencing chains that don't exist, `autoclaim`/`currency`
field types, or duplicate `networkId`s across chains — any of the semantic rules that
`config/configValidator.mjs` enforces. A config that is well-formed JSON with the right
top-level shape can pass this check and container startup, and then **fail at the
browser**, where the app's real Zod validation runs (behind `AppConfigGate`, rendering
its `data-test-id="app-config-error"` screen). Always run the repo's real validator
against a candidate `config.json` before mounting it — from a dev-ui checkout:

```bash
pnpm run validate:config -- /path/to/your/config.json
```

(with no argument it validates the repo-root `config.json`). See
[`docs/config.md`](./config.md#validation).

## Cache semantics

Verified response headers from a running container (see
`plans/dev-ui-docker-ghcr/c2-runtime-config-proof.md` §2–3):

| Path | `Cache-Control` | Why |
|---|---|---|
| `/config.json` | `no-store` | `nginx.conf:17-20`. A container restart with a different mounted `config.json` must be reflected on the very next request — nothing may cache a stale config, in the browser or in an intermediary proxy. Belt-and-braces with the app's own `fetch(..., { cache: 'no-store' })` (`app/configLoader.ts:27`). |
| `/_next/static/*` | `public, max-age=31536000, immutable` | `nginx.conf:25-28`. Next's static export content-hashes every asset under this path, so the path itself changes whenever the content does — safe to cache forever. |

## Runtime config is read once per page load

The app fetches `/config.json` exactly once, when it mounts, plus once per explicit user
"Retry" click after a failed fetch. There is no polling, no automatic re-fetch, and no
way to push new configuration into an already-loaded page. To apply a new
`config.json`, either restart the container (after replacing the mounted file) or simply
reload the browser tab if the container is already serving the new file. See
`plans/dev-ui-docker-ghcr/a1-runtime-config-design.md` §8 for the full rationale
(in short: `@agglayer/sdk`'s chain registry is an append-only singleton with no reset
path, so re-initializing the app in place without a reload/restart could leave stale
chain data resident).

## Image size and startup time

Measured (see `plans/dev-ui-docker-ghcr-plan.md:432`): image size **106MB** (29MB
compressed), and **286ms** from container start to the first HTTP 200 response. These
numbers are for the specific verification build described in that plan step and are not
re-measured on every publish; expect them to be representative, not exact, for any given
tag.

## Building the image locally

### Prerequisite: `.sdk-src/`

**Temporary, until `@agglayer/sdk`'s aggkit bridge APIs are published to npm** — tracked
by `plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md` §5. This repo currently
depends on an unreleased `@agglayer/sdk` commit via a `file:../sdk` workspace override
(`pnpm-workspace.yaml`), which only works if a source tree exists at `../sdk` relative to
this repo, or — for Docker builds — staged into this repo's build context at
`./.sdk-src/`. In CI, that staging happens automatically via a second `actions/checkout`
of `agglayer/sdk` pinned to a commit SHA. Locally, you must populate it yourself before
`docker build` will work:

```bash
scripts/stage-sdk-src.sh [path-to-sdk-checkout]   # defaults to ../sdk
```

This copies only the **tracked** files from a sibling `agglayer/sdk` git checkout (via
`git archive`, not `cp -r`) into `.sdk-src/`, gitignored and rebuilt inside the image by
the Dockerfile's `sdk-builder` stage (`Dockerfile:29-37`). See `scripts/stage-sdk-src.sh`
for the exact mechanics and `plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md` §4
for why this shape was chosen over the alternatives.

**Removal trigger:** once a published `@agglayer/sdk` version above `1.0.0-beta.30`
carries the aggkit APIs, this entire prerequisite goes away. The exact 9-row edit
checklist — updating `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, deleting
the `sdk-builder` Dockerfile stage, the `.gitignore`/`.dockerignore` entries, the CI
checkout step, and the corresponding section of this document — is spelled out verbatim
in `plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md` §5.2. Every artifact this
prerequisite touches carries an inline `# TEMPORARY` comment pointing back at that
section, so `grep -rn "TEMPORARY -- remove per"` finds all of them.

### Build

```bash
scripts/stage-sdk-src.sh
docker build -t agglayer-dev-ui .
```

The build context is this repo's root — the same `docker build .` invocation works
identically locally and in CI (`plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md`
§4.2). No parent-directory context, no `-f` flag.

## Release process

### Cutting a release (the normal path)

Publishing `ghcr.io/agglayer/agglayer-dev-ui:<tag>` happens automatically when a GitHub
Release is published against this repo (`release: published` in
`.github/workflows/docker-publish.yaml:47-49`). Cut a release the usual way (tag a
commit `vX.Y.Z` or `X.Y.Z`, publish a GitHub Release against it) and the workflow builds
and pushes the image with the tag set described above. Mark the release as a GitHub
"prerelease" (or use a semver `-suffix`, e.g. `1.2.3-rc.1`) if it should not move
`latest` or the `X.Y` tag.

### Building an arbitrary branch via dispatch

You can also build and publish an image from any branch, tag, or full commit SHA that is
**already reachable in the repository** by running the workflow via
`workflow_dispatch`, passing the desired revision as the `ref` input.

**Documented limitation: `workflow_dispatch` cannot target a bare commit SHA.** The ref
you pick when firing the dispatch event itself (the branch selector in the "Run workflow"
button, or `--ref` on `gh workflow run` / the REST API) must be an existing branch or
tag — GitHub uses that ref to decide which version of the workflow file to run, and its
API rejects a bare SHA there. This is a separate thing from the workflow's own `ref`
input, which **is** just a string forwarded to `actions/checkout` and does accept a full
commit SHA (the checkout uses `fetch-depth: 0` so an arbitrary SHA is resolvable). See
`.github/workflows/docker-publish.yaml:9-19` for the full explanation.

**Net effect:** to publish an unreleased commit that has no branch or tag yet, push it to
a branch (or tag it) first, then dispatch the workflow against that branch/tag, passing
whichever revision you actually want built (branch name, tag, or full SHA) as the `ref`
input.

```bash
git push origin HEAD:my-temp-branch
gh workflow run docker-publish.yaml --ref my-temp-branch -f ref=my-temp-branch
```

Dispatch builds are tagged `dispatch-<ref>-<sha>-<run_id>` and can never collide with a
semver tag or move `latest` (see "Tag scheme" above).

## Rollback

Because tags are immutable per publish (a given `X.Y.Z` is only ever written once, at
that release), rolling back is pinning a previous tag:

```bash
docker run -d -p 8080:80 \
  -v /path/to/config.json:/etc/agglayer-dev-ui/config.json:ro \
  ghcr.io/agglayer/agglayer-dev-ui:X.Y.Z-1
```

For a running deployment, this typically means changing the image tag in whatever
orchestrator/compose file references it and redeploying — there is no in-image rollback
mechanism, and none is needed: the container has no persistent state, so replacing the
image and reusing the same mounted `config.json` is sufficient. See
[`docs/deployment.md`](./deployment.md) for this alongside the Cloudflare Worker rollback
path.

## The generated `public/config.json` artifact (background, for context)

The image's webroot `config.json` ultimately comes from this repo's root `config.json`
via a generated, gitignored intermediate file, `public/config.json`, produced by
`node scripts/syncPublicConfig.mjs` and consumed by `next build`'s static-asset copy.
This is a build-time mechanism, not something the running container does — see
[`docs/config.md`](./config.md) for the full explanation of that pipeline and its
implications for local development.

## Known deviations from `docs/team-standards.md`

This image and its publish workflow deliberately diverge from a few conventions in
`docs/team-standards.md`. Recorded here per that document's expectation that deviations
be explained, not silently made:

- **GHCR instead of GCP Artifact Registry** (`docs/team-standards.md:114,168,210`). The
  team standard's Dockerfile/release conventions route through the shared
  `docker-release-trigger.yml` → `apps-docker-release.yml` pipeline, which publishes to
  GCP Artifact Registry as part of the dry-dock/Kargo deployment path. This repo instead
  publishes directly to `ghcr.io/agglayer/agglayer-dev-ui` via its own
  `.github/workflows/docker-publish.yaml`. Rationale: `agglayer-dev-ui` is a
  self-hosted, operator-run artifact (like `ghcr.io/agglayer/aggkit`), not a GCP-deployed
  Polygon Labs backend service — there is no dry-dock stage or Kargo project for it, and
  GHCR is where its sibling `agglayer/*` images already live.
- **No `.changeset`** (`docs/team-standards.md:80-90`). This repo is `private: true` and
  never published to npm (see `CLAUDE.md`'s "Other known deferrals"), so the changeset
  machinery the team standard requires for workspace-package PRs and Docker release tags
  does not apply here — there is no npm package whose version a changeset would bump, and
  the image tag is instead derived directly from the GitHub Release tag (see "Tag
  scheme" above).
- **Workflow logic inline, not under `.github/scripts/`** (deviates from
  `docs/team-standards.md:105-109`, "Keep workflow YAML thin"). The tag-computation and
  smoke-test logic in `docker-publish.yaml` lives inline in `run:` steps rather than in a
  separate script file. Accepted as a one-workflow-file exception; the logic is under 70
  lines total and heavily commented in place.
- **`concurrency.cancel-in-progress: false`**, unlike this repo's `deploy.yaml`/
  `e2e.yaml` (`.github/workflows/docker-publish.yaml:62-70`). A cancelled build mid-push
  could leave a partially-written manifest or tag in GHCR; overlapping runs (e.g. a
  release publish racing a manual dispatch) queue and run strictly serially instead.

<!--
  Vendored from https://gist.github.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef
  Retrieved: 2026-08-10
  Gist revision: 8a356d52f61b67bd26aa78f3076a4134aac4e3b3
  Update by re-vendoring deliberately (fetch + review + replace this file) — do not fetch live.
-->

# Polygon Apps Team Standards

## Reference Implementation

`apps-team-ts-template` is the canonical reference for all dev tooling
config. When setting up or reviewing any repo, diff its config files
against the template's equivalents.

## Code Quality

- **Named exports only** — `export const` / `export function`. Never
  `export default`. Exceptions: `.tsx` files and config files requiring
  default export (`eslint.config.js`, `vite.config.ts`,
  `commitlint.config.js`, etc.).

- **No non-null assertions (`!`)** — narrow the type instead (`if` guard,
  `?? fallback`, destructuring default). Applies to test files too.

- **No type escape hatches in production code** — `as any`, `: any`,
  `as unknown as X`, `// @ts-ignore`, `// @ts-expect-error`, or
  `/* eslint-disable @typescript-eslint/no-explicit-any */` in any file
  under `src/`. If the type system seems wrong, the type is the bug:
  fix the upstream signature, or refactor so the call site has the
  information it needs. Cast chains hide real type-system tension —
  exactly the kind of tension that catches bugs before runtime. Test
  files have a small allowance for mocking ergonomics (stub helpers,
  spy wrappers), but any production-code `any` is a review-blocker.
  If a third-party library forces a cast, isolate it in a single
  helper at the boundary with a precise typed wrapper above it.
  - **Narrow `unknown` by validating, not casting.** Untyped data —
    `JSON.parse()` output, request bodies, external API responses — is
    `unknown`; reach for a `as MyType` cast and you assert a shape the
    runtime never checked. Parse it with a Zod schema instead: validation
    and the typed result come from the same call (`schema.parse(raw)`
    returns `MyType`), so there is no cast and no unchecked assumption.
    This is the sanctioned way out of an `as` — see Validation, Parsing,
    and Coercion, and `apps-team-ops/docs/best-practices/type-safety.md`.

- **Chai assertion style** — Vitest's `expect` is Chai. Strip no-op
  chains (`.to`, `.be`, `.is`, `.that`, `.and`, `.at`, `.with`, `.have`,
  `.has`). Use `.property()` / `.nested.property()` for object fields —
  never dereference directly. Don't prefix `.greaterThan()`, `.least()`,
  `.below()` etc. with `.a('number')` — they already validate the type.
  See `apps-team-ops/docs/best-practices/testing.md`.

- **Params objects over positional arguments** — for any function with
  two or more parameters, especially when one is optional or boolean,
  prefer `fn({ a, b, c })` over `fn(a, b, c)`. Single-parameter
  functions, framework-imposed signatures, and well-established two-arg
  conventions (Node-style `(err, result)` callbacks, `(prev, curr)`
  reducers, `(a, b) => number` comparators) keep positional args. See
  `apps-team-ops/docs/best-practices/function-signatures.md`.

## Git and GitHub

- **Never open a pull request without explicit user permission.** Do not run
  `gh pr create` unless the user has specifically asked for it.
- **Always create PRs in draft mode.** Use `gh pr create --draft`. After
  CI checks pass, mark the PR ready with `gh pr ready`. This avoids
  spamming CODEOWNERS with review requests before checks are green.
- **Never commit without explicit user permission.** Do not run `git commit`
  unless the user has specifically asked for it.
- **Keep PR descriptions current.** When new commits are pushed to a branch
  that already has an open PR, update the PR description to reflect what was
  added. A PR description that no longer matches the branch content misleads
  reviewers and makes the merge history untrustworthy. This applies after
  every push — not just the first one.
- **Maintain linear history — never merge trunk into feature branches.**
  When a feature branch falls behind `main`, rebase it (`git rebase
  origin/main`) rather than merging `main` into it. If a rebase conflict
  is genuinely complex, discuss with the team before merging trunk as a
  last resort.
- **Include a changeset whenever a PR touches workspace package files**
  in a changeset-managed repo (check for `.changeset/config.json`). The
  CI gate runs `pnpm exec changeset status` and only fails when a file
  inside a workspace package directory has changed without a covering
  changeset; files outside every package — `.github/`, root configs,
  top-level docs — pass without one. `pnpm exec changeset add` for
  shippable changes; `--empty` for non-shippable changes inside a
  package (chore in a published package, intermediate refactor with no
  consumer impact). Commit the changeset in the same commit as the code
  — the changelog records that commit's hash. See
  `apps-team-ops/docs/best-practices/changesets.md`.

## GitHub Repository Settings

- **Auto-delete branch on merge** — All repositories must have
  "Automatically delete head branches" enabled.
- **Branch protection on `main`** — All repositories must have branch
  protection enabled on `main` requiring at least one approving review
  and code owner reviews. `enforce_admins` should be `false` so the
  team lead can push directly when needed.
- **CODEOWNERS** — All repositories must have a `.github/CODEOWNERS`
  file defining the team as required reviewers.

## GitHub Actions

- **Keep workflow YAML thin — put logic in scripts.** Any non-trivial
  shell logic (more than a single command) must live under
  `.github/scripts/` or `.github/actions/<name>/` so it can be run and
  debugged locally. YAML steps are just invocations. Never split logic
  across many steps sharing state via `$GITHUB_OUTPUT`.

- **Explicit secrets on reusable workflow calls.** Never
  `secrets: inherit` — always pass by name so it's clear what credentials
  are granted. Reference:
  `apps-team-ts-template/.github/workflows/docker-release-trigger.yml`.
- **Delete superseded workflows in the same PR.** There is no such thing
  as a "disabled for now" workflow file — if it exists, it fires.
- **Always define explicit `permissions` on every workflow.** Never rely
  on default token permissions. Least privilege at workflow level (or
  per-job if jobs need different scopes). `permissions: {}` if the
  workflow needs no repo access.
- All repositories must have a CI workflow on PRs to `main` running at minimum `pnpm run lint`, plus tests if a test suite exists.
- **CI uses the shared composite action.** `ci-trigger.yml` calls
  `0xPolygon/pipelines/.github/actions/ci@main` in a
  `runs-on: ubuntu-latest` job. Env vars composed from secrets in the
  trigger's `job.env:` block reach `pnpm test` automatically — no
  extra passing mechanism. See
  `apps-team-ts-template/.github/workflows/ci-trigger.yml`.
- **Prefer `actions/github-script` over shell for GitHub API calls.**
  Inline `gh api | jq` is brittle. Use `actions/github-script` with a
  `.cjs` helper under `.github/scripts/` — authenticated Octokit,
  `github.paginate()`, testable locally. Exception: composite actions
  called cross-repo must compile the helper with `ncc` into a committed
  `dist/` bundle, since raw `.github/scripts/` isn't accessible from the
  calling repo's workspace.

## Shared Workflows

All team repositories consume shared GitHub Actions workflows from
**`0xPolygon/pipelines`** rather than maintaining inline copies. Apps Team
workflows carry an `apps-` prefix on the filename to namespace them
alongside other pipelines hosted there (`gcp_pipeline_release_image.yaml`,
`ecs_deploy_docker_taskdef.yaml`); composite action names are unprefixed.
`pipelines` is public, so private and public consumers both call it
directly.

Consuming repos have thin **trigger files** (`<name>-trigger.yml`) that
call the shared workflow
(`uses: 0xPolygon/pipelines/.github/workflows/apps-<name>.yml@main`) or
composite action (`uses: 0xPolygon/pipelines/.github/actions/<name>@main`).
Canonical trigger files live in `apps-team-ts-template/.github/workflows/`
— copy when setting up a new repo.

### Trigger file permissions

A trigger file's top-level `permissions:` must be a superset of every scope
the called workflow's jobs declare. Mismatches produce `startup_failure` at
workflow start before any step runs. Check the called workflow's job-level
`permissions:` block and mirror in the trigger. Canonical trigger files
have the correct permissions already.

### Required workflows

| Condition | Trigger file | Shared workflow |
|-----------|-------------|-----------------|
| All repos | `ci-trigger.yml` | `.github/actions/ci` composite action |
| All repos | `changeset-check-trigger.yml` | `apps-changeset-check.yml` |
| Repos using changesets | `npm-release-trigger.yml` | `apps-npm-release.yml` |
| Repos with a Dockerfile | `docker-release-trigger.yml` | `apps-docker-release.yml` |
| All repos | `claude-code-review-trigger.yml` | `apps-claude-code-review.yml` |
| All repos | `claude-trigger.yml` | `apps-claude.yml` |
| Repos with Slack notifications | `pr-notifications-trigger.yml` | `apps-pr-labeler.yml` + `apps-slack-merge-notify.yml` |

## Node.js

- **Never create RPC clients or provider objects inside request handlers
  or retry loops.** Create once, reuse for the process lifetime. Per-request
  creation causes OOMKill under load as socket buffers and libuv handles
  outpace the GC. Use a process-level singleton or a cache keyed by
  connection parameters. Cache `Promise<Client>` (not the resolved value) so
  concurrent callers share a single in-flight initialisation; evict on
  failure so the next caller retries:
  ```ts
  const cache = new Map<string, Promise<Client>>();
  function getClient(url: string): Promise<Client> {
    let p = cache.get(url);
    if (!p) {
      p = createClient(url).catch(err => { cache.delete(url); throw err; });
      cache.set(url, p);
    }
    return p;
  }
  ```
  See `apps-team-ops/docs/best-practices/backend.md`.

- **Use a static provider for services that never subscribe to events or
  filters.** No block-polling timer, no cached chain state — safe as a
  long-lived singleton regardless of call volume (one-off or polling
  `getLogs` in a loop). The qualifier is the absence of
  filters/subscriptions, not call frequency.
  - ethers v5: `new StaticJsonRpcProvider(url)`
  - ethers v6: `new JsonRpcProvider(url, Network.from(chainId), { staticNetwork: true })`

  See `apps-team-ops/docs/best-practices/backend.md`.

- **Never sleep between retries that switch to a different endpoint.**
  Back-off before retrying the *same* endpoint is fine; sleeping before
  trying a different healthy endpoint holds in-flight request objects in
  memory for no reason.

## Dockerfile

All repositories that ship a Docker image must follow these conventions.

- **Base image**: Use `node:<version>-bookworm-slim` where `<version>` matches
  `.nvmrc`. Prefer `bookworm-slim` over `alpine` for glibc compatibility with
  native modules.
- **Non-root user**: The container must not run as root. Create a system user
  and switch before `ENTRYPOINT`.
- **apt-get hygiene**: Never silence `apt-get update` with `|| :` — let it fail
  hard. Always pass `--no-install-recommends` and clean up package lists in the
  same `RUN` layer.
- **`pnpm deploy` for the runtime bundle** — single-package and monorepos
  both. Never hand-copy `node_modules`, `src/`, or `package.json` into the
  runtime stage. Use `--ignore-scripts` on install; if a dependency truly
  needs a postinstall (native addon), add it to `onlyBuiltDependencies`
  in `pnpm-workspace.yaml` rather than dropping `--ignore-scripts`.
- **Docker integration test at release** — trigger file has `test` (via
  the `docker-test` composite action) and `release (needs: test)` jobs.
  Services with runtime env vars declare them in `job.env:` and pass names
  via `test_vars`. See
  `apps-team-ts-template/packages/example-rest-api/Dockerfile`.

## Infrastructure

- Deployment config for all services lives in the **dry-dock** repository
  (Kargo/Argo CD pipelines, k8s YAMLs).
- Production env vars for GCP-deployed services are the canonical source for
  service-to-service wiring:
  `dry-dock/source/web-apps/common/stages/production/<service>.yaml`
  (`applications/web-apps/` contains ArgoCD ApplicationSet templates, not env vars)
- Services span three GitHub orgs: **0xPolygon**, **AggLayer**, **maticnetwork**
- **OIDC registration for new deployable repos** — every repo deploying
  via the Docker release pipeline must be added to the `github_repos`
  list for `shared-prod-oidc-sa` in
  `polygon-infrastructure/google-cloud/landing-zone/service_accounts.tf`.
  Without it, the Docker release workflow can't authenticate to GCP
  Artifact Registry. Open the PR before the first release of any new
  service.
- **`gcpHealthCheckRequestPath` is required whenever a dry-dock stage
  enables `access.internal` or `access.external`.** The common chart's
  `HealthCheckPolicy` template gates on this value; if absent, no
  policy renders, GCP LB falls back to a TCP probe on Service port 80
  (nothing listens), every pod is marked unhealthy, and the gateway
  returns `no healthy upstream` for every request. Set it to the
  service's liveness path (typically `/health-check`) in the same
  commit that adds the `access.*` block — the two are not independent.
  Has bitten us twice (dry-dock#975 l2-spol-rebalancer,
  dry-dock#989 lst-indexer). See
  `apps-team-ops/docs/best-practices/ci-cd/service-deployment.md`.

## Monitoring

- **`/service-status` for Datadog Synthetics** — Services that expose operational
  metrics for Datadog Synthetics monitoring must name that endpoint `/service-status`.
  Use `/health-check` for the Kubernetes liveness probe only; never repurpose it for
  operational metrics. See `apps-team-ops/docs/best-practices/service-health-monitoring.md`.

## Release Verification

Post-release rollout verification is driven by the workspace `verify-release`
skill, backed by one profile per deployed service at
`apps-team-ops/docs/runbooks/<service>/verify-release.md` (endpoints, version
probe, health and `/service-status` body shapes, smoke command, quirks).

- **Keep the verify-release profile current with the service.** When a change
  alters a service's deployment surface — `/health-check` or `/service-status`
  response shape, routes or endpoints, version-probe path, runtime env or
  secrets, or smoke command — update that service's profile in the same PR. A
  stale profile makes release verification confidently wrong. If a deployed
  service has no profile yet, add one (use an existing profile as the template).
- **Don't restate promotion topology in the profile.** Whether a service is
  dev-auto/manual-prod or direct-to-prod is discovered from its dry-dock Kargo
  project (`kargo/projects/web-apps/<service>.yaml`, via the registry node's
  `deployment.k8sGcp.releasePipelines`) — the profile points at it, never
  copies it.

## Secrets Management

- **Use GCP Secret Manager** for all service secrets, injected via External
  Secrets Operator (`secretsFrom` + templated `extraEnv` in dry-dock stage
  files). See
  `apps-team-ops/docs/runbooks/1password-to-gcp-secrets-migration.md`.
- **RPC URLs by cluster:**
  - Production (`prj-polygonlabs-webapps-prod`): internal eRPC proxy
    `http://erpc.erpc.svc.cluster.local/internal/evm/<chainId>?token=<token>`
  - Development (`prj-polygonlabs-webapps-dev`): public endpoint
    `https://rpc.polygon.tools/internal/evm/<chainId>?token=<token>` (dev
    cluster has no access to the internal service)
- **Secret naming**: `<service-name>-<env-var-name-lowercased-with-dashes>`
  (e.g. `proof-generation-api-ethereum-rpc` for `ETHEREUM_RPC`).

## Frontend Architecture

- **New frontends: Vite.** Only use Next.js if there is a concrete,
  documented need for SSR or Next.js-specific features (ISR, middleware,
  API routes). "Might need SSR later" is not sufficient.
- **Existing Next.js apps** — don't rewrite working apps to adopt Vite.
  Static-export (`output: 'export'`) Next.js apps with no SSR/API routes
  are migration candidates when the next significant change lands.
- Reference: `apps-team-ts-template/packages/example-frontend/`.

## Wallet Integration

New Polygon frontends requiring wallet connectivity use
**`@0xsequence/connect`** (Sequence Connect / Trails Ecosystem Wallet).

- Use wagmi hooks directly (`useConnection`, `useBalance`,
  `useSwitchChain`) — don't wrap them in a custom wallet context.
- **Don't use Reown (AppKit/WalletConnect)** for new projects. Existing
  `@reown/appkit` apps migrate when the next significant frontend change
  lands.
- Sequence env vars use the `VITE_SEQUENCE_*` prefix and are validated in
  `src/env.ts` via `@t3-oss/env-core`.
- **Wallet adapter peer deps** — wagmi requires an explicit peer dep for
  each adapter enabled in Sequence Connect config. Missing peers cause
  silent runtime connection failures. Follow
  `apps-team-ts-template/packages/example-frontend`.
- **Sequence v3 provider config** — on connect, detect
  `connector.id === 'sequence-v3-wallet'` and call
  `setUseWalletTransactionForSend(true)` on the provider. Use wagmi's
  `useConnectionEffect` and a type guard — never `(provider as any)`.
- **SCW UX gating for Sequence v3** — Sequence v3 deploys bytecode but
  behaves like an EOA for transaction submission. SCW-specific UX
  (informational modals, "please verify execution" messages) must
  exclude it:
  `if (isSmartContractWallet && !isSequenceWallet) { /* SCW UX */ }`.
  Also exclude EIP-7702 delegated EOAs (bytecode starting `0xef0100`).
- **Permit flow exception** — `eth_signTypedData_v4` from Sequence v3
  returns an ERC-1271 signature; OpenZeppelin's `ERC20Permit` reverts
  via `ecrecover`. Route Sequence v3 *and* all SCWs through `approve` +
  direct call:
  `if (isSmartContractWallet || isSequenceWallet) { /* approve flow */ }`.
  (OR, not AND — Sequence needs the approve path unconditionally.)
- Reference: `apps-team-ts-template/packages/example-frontend/`.
  Rationale and common mistakes:
  `apps-team-ops/docs/best-practices/wallet-integration.md`.

## Documentation

All written documentation — READMEs, code comments, CLAUDE.md files, PR
descriptions, inline JSDoc — answers **why**, not just **what**.

- **Explain motivation, not mechanics.** Readers can see what the code
  does; they can't see the constraint that shaped it, the alternative
  rejected, or the problem it solves.
- **No shadow documentation.** Comments that restate the signature are
  worse than nothing — they drift silently. Delete them.
- **AI-drafted docs need human review.** LLMs default to summarising
  *what*. Add the context the model can't infer: design decisions,
  failure modes, historical constraints.
- **Useful "why" includes:** the problem and who has it, alternatives
  considered, non-obvious constraints, ordering requirements, why a
  config value is what it is.

See `apps-team-ops/docs/best-practices/documentation.md`.

## CLAUDE.md Authoring

**Never duplicate sources of truth.** If information can be read from
a file, discovered by searching the repo, or derived from code, do not
copy it into CLAUDE.md. Copies drift and become silently wrong.

This includes but is not limited to:
- File and directory listings (use glob to discover them)
- Environment variable names or values (read the env schema)
- Route paths or API endpoints (read the route definitions)
- Script names and flags (read `package.json`)
- Dependency lists (read `package.json` or lock files)
- Configuration values (read the config files)

Instead, tell Claude _where_ to look — not _what it will find there_.
Reference the file or directory path; never enumerate its contents.

## Testing

All repos use **Vitest** for backend and frontend. `expect()` is Chai — the
assertion rules in Code Quality apply.

- Import `describe`/`it`/`expect`/`beforeAll`/`afterAll`/`beforeEach`/
  `afterEach` from `"vitest"`. Never install `chai` separately.
- Shared state: `let foo!: Type` in `describe` scope; assign in `beforeAll()`.
- Cleanup in `afterAll()` — not `process.on("exit")`, which breaks teardown
  ordering on failure.
- Timeouts via options on `describe`/`it`:
  `describe('name', { timeout: 30000 }, () => { ... })`. Never in config
  files or CLI flags.
- Every repo with tests has `vitest.config.ts` at the right level (repo
  root, or per-package in a monorepo).

## Validation, Parsing, and Coercion

- **Prefer Zod** for all data validation, parsing, and coercion. Use
  Zod schemas for request/response bodies, configuration, external API
  responses, and any data crossing a trust boundary.
- **REST APIs — OpenAPI-first design**: Define Zod schemas first, then
  derive OpenAPI specs from them using `@asteasolutions/zod-to-openapi`.
  The Zod schema is the source of truth; the OpenAPI spec is generated,
  not hand-written. Serve interactive API docs using
  `@scalar/express-api-reference` mounted at `/docs`.
- **Client codegen**: generated REST clients use
  [`@hey-api/openapi-ts`](https://heyapi.dev/openapi-ts) with the
  registry-driven [`@polygonlabs/zod-to-openapi-heyapi`][heyapi-plugin]
  plugin. The plugin emits
  `import { <RegisteredName> } from '<schemasFrom>'` per schema and a
  `parseAsync` response transformer per operation, so the client imports
  the **actual** Zod runtime values the backend validates against —
  codecs (off-the-wire-format ↔ runtime-type pairs from
  [`@polygonlabs/zod-codecs`][zod-codecs]) round-trip end-to-end. Schema
  exports must be named exports whose binding equals the registry name —
  the plugin's codegen-time audit fails the build on mismatches. See
  `apps-team-ts-template/packages/example-client` for the canonical
  implementation; the plugin README documents `schemasFrom` resolution
  and the package.json `imports` alias pattern.
- **Don't use orval, openapi-typescript, or `@hey-api/zod`** for new
  clients. They re-derive types from the OpenAPI spec, which loses
  codecs, refinements, and branded types — the client validates a
  superset of what the backend accepts and the two copies drift the
  moment a constraint changes.
- Don't use Zod to re-implement constraints that a host framework
  already provides (e.g., yargs `type: "number"`, yargs `choices`).
  Use Zod for validation the framework can't express natively.

[heyapi-plugin]: https://www.npmjs.com/package/@polygonlabs/zod-to-openapi-heyapi
[zod-codecs]: https://www.npmjs.com/package/@polygonlabs/zod-codecs

## Environment Validation

All services validate env vars at startup using `@t3-oss/env-core` with Zod.
Define the schema in `src/env.ts` and import from there — never read
`process.env` directly elsewhere.

- **Lazy `getEnv()` pattern** — wrap `createEnv()` in `buildEnv()`, export
  a memoised `getEnv()`. Never `export const env = createEnv(...)` at
  module scope. Deferring validation lets test suites using `TEST_BASE_URL`
  import the app graph without every service env var set.
- **`emptyStringAsUndefined: true`** in `createEnv()`. Treats `FOO=` as
  missing rather than the empty string.
- **Boolean env vars** — use `BooleanOrBooleanStringSchema` from the
  canonical
  [`src/env.ts`](https://github.com/0xPolygon/apps-team-ts-template/blob/main/packages/example-rest-api/src/env.ts).
  Never `.transform((v) => v === 'true')` — accepts only the literal
  `"true"` and silently treats `"1"` / `"yes"` / `"on"` as false.
- **`dotenvx` for local dev only** — `"dev": "dotenvx run -- node src/index.ts"`.
  Don't add `dotenv` to runtime `dependencies` or call `import 'dotenv/config'`
  in source — production env vars come from External Secrets Operator.
- **`NODE_ENV=production` for every deployed service**, including the dev
  cluster. Libraries (React, Express, webpack) check `=== 'production'`
  exactly; arbitrary values silently opt out of production hardening. For
  environment-specific behaviour use purpose-specific vars (`LOG_LEVEL`,
  `SENTRY_ENVIRONMENT`). Locally, `NODE_ENV` may be `development` or `test`
  per the runner.

## ESLint

All repos use **`@polygonlabs/apps-team-lint`** (`eslint@^10.0.0` is a
required peer dep). Keep both in sync with `apps-team-ts-template`.
`eslint.config.js` wraps its config array with `defineConfig` from
`'eslint/config'` and composes:

| Export | Purpose | Options |
|--------|---------|---------|
| `recommended(options?)` | Ignores, parser, import sorting, import-x, core rules, Prettier compat | `{ globals?: 'node' \| 'browser' \| Record<string, boolean> }` |
| `typescript(options?)` | TS-ESLint rules, type-aware linting, TS resolver | `{ tsconfigRootDir?: string }` — required in monorepo per-package configs (pass `import.meta.dirname`); omit for single-package repos |
| `frontend()` | `.tsx` default-export exemption, React/JSX rules | None (browser globals now via `recommended({ globals: 'browser' })`) |

`javascript()` has been removed — do not import or call it. Repo-specific
overrides (extra ignores, file patterns) go in the same file.

### `lint` and `lint:ts` script conventions

Repos running multiple linters (ESLint, markdownlint, Prettier) via
`concurrently`:

- **`lint:ts` is raw `eslint .`** — no `&& tsc --noEmit`. Typecheck is the
  `typecheck` script.
- **`lint` invokes `lint:ts`** (directly or via `concurrently`) so ESLint
  always runs as part of the top-level lint gate.

Single-linter repos use `"lint": "eslint ."`. Never use
`pnpm -r run lint` (monorepo recursion silently skips packages) or omit
ESLint.

### Monorepo ESLint structure

Each workspace package has its own `eslint.config.js`. The root
`eslint.config.js` is a thin safety net for root-level files. All configs
use the same `defineConfig` pattern. Root `package.json` lint script is
`"lint": "eslint ."` — per-file config discovery handles packages.

### TypeScript project references — three-tier `tsconfig`

TypeScript monorepos follow the Nx three-tier `tsconfig` pattern:

- **`tsconfig.base.json`** at the repo root owns every shared
  `compilerOptions` entry — extends `@tsconfig/node24` + `@tsconfig/node-ts`
  and adds `composite: true`, `declarationMap`, `emitDeclarationOnly`,
  `customConditions: ["@polygonlabs/source"]`, `noUncheckedSideEffectImports`.
  Any repo-wide strictness tightening lands here once.
- **Root `tsconfig.json`** is a solution-style hub: `extends`
  `./tsconfig.base.json`, sets `files: []`, and lists `references`
  pointing at each package directory.
- **Per-package hub `tsconfig.json`** carries only `references` to
  `./tsconfig.lib.json` and `./tsconfig.spec.json`, with `files: []`
  and `include: []`.
- **Per-package `tsconfig.lib.json`** owns source build / typecheck:
  `rootDir: src`, `outDir: dist`, `emitDeclarationOnly: false`,
  `include: ["src/**/*.ts"]`. Published library packages override
  `customConditions: []` so build-time resolution of workspace deps
  goes through the depended-upon package's published `dist/.d.ts`
  rather than the source condition. Cross-package `references` point
  at the depended-upon package's `tsconfig.lib.json` (not its hub).
- **Per-package `tsconfig.spec.json`** owns tests and non-source files
  (vitest configs, codegen configs, top-level scripts). Adds vitest
  types, references `./tsconfig.lib.json`, sets
  `rewriteRelativeImportExtensions: false` +
  `allowImportingTsExtensions: true` so tests can keep reaching the
  package's own `src/` via relative `.ts` imports without TS2878 —
  the spec's `outDir` (`out-tsc/`) is throwaway and never consumed at
  runtime.

Per-package `package.json` scripts use `tsc -b`:

- `"typecheck": "tsc -b"` walks the hub graph; emits to gitignored
  `dist/` and `out-tsc/` directories. (`tsc -b --noEmit` is incompatible
  with composite project references — TS6310 — so emit-and-discard is
  the supported flow.)
- Library builds use `tsc -b tsconfig.lib.json` so the build emits only
  the library payload, not the spec output.

**Tests reach internals via relative paths, not via `exports`.** Don't
add subpath `exports` entries to a package solely so a test can import
an internal — the published surface is for consumers, and the spec
config's rewrite override is what lets test code keep using
`from '../src/foo.ts'`. Cross-PACKAGE imports (between different npm
packages) must still go through public `exports` — that rule is
unchanged.

Composite-mode declaration emit surfaces a TS2742 / TS7056 class of
portability diagnostic on any exported value whose inferred type isn't
portably nameable via its source package's public surface — Express
factories, viem `Client.extend(actions)` intersections, and
`defineConfig`-style default exports from tsup-bundled packages have
all hit this. The fix is the same every time: name the type explicitly
at the consumer boundary so TS doesn't have to discover a portable
name through the producer's internal chain; don't reach for `any` when
the producer ships a helper type that satisfies the annotation.
Catalogue with the canonical fix for each case lives in
`apps-team-ops/docs/best-practices/build-tooling.md` under "Failure
mode 3"; re-check it whenever a new three-tier rollout surfaces a
fresh hit.

Each per-package `eslint.config.js` still passes
`tsconfigRootDir: import.meta.dirname` to `typescript()` so
`typescript-eslint` finds the right tsconfig when ESLint runs from the
repo root. It also adds `{ ignores: ['out-tsc/**'] }` — under flat-config
rules the per-package config overrides the root config's ignores,
so the entry must be repeated per package.

#### Library build scripts: `build` / `build:clean` / `prepublishOnly`

Every published library declares the same three-script split:

```jsonc
{
  "build":          "pnpm run typecheck && tsc -b tsconfig.lib.json",
  "build:clean":    "pnpm run typecheck && rm -rf dist out-tsc *.tsbuildinfo && tsc -b tsconfig.lib.json",
  "prepublishOnly": "pnpm run build"
}
```

- `build` is the dev-iteration path and the publish path.
- `build:clean` exists for local recovery only (interrupted publish,
  `git stash pop`, `src/` rename leaving orphan `dist/` outputs, etc.).
  **Do not** point `prepublishOnly` at `build:clean` — the `rm` step
  races with parallel `prepublishOnly` typechecks during `changesets
  publish` and breaks the wave with `TS2307` errors. CI publishes run
  on fresh checkouts so the rm has nothing to clean anyway.
- `tsc -b --force` is **not** a substitute for `build:clean` — it
  re-emits but doesn't remove orphaned outputs without a `src/`
  counterpart.
- `tsup`-emit packages are exempt — `clean: true` already wipes `dist/`.

Rationale (failure modes, publish-incident history, publish-wave
race): see `apps-team-ops/docs/best-practices/build-tooling.md`.

`tsconfig.build.json` no longer exists in the migrated shape; replace
it with `tsconfig.lib.json` whenever you encounter it.

## Prettier

All repos use identical Prettier settings matching the template's
`.prettierrc.json`. No per-repo overrides.

## Tooling

- **Runtime: Node.js** — All repositories use Node as the runtime.
  Do not use Bun.
- **Node 24 runs TypeScript natively.** No transpiler, no `ts-node`, no
  `tsx`. `node src/index.ts` directly. `@tsconfig/node-ts` enforces
  `erasableSyntaxOnly: true` (no `enum`, no namespaces, no constructor
  parameter properties). Don't add `--experimental-strip-types`.
- **`noUncheckedSideEffectImports: true` in `tsconfig.base.json`.**
  With `moduleResolution: "bundler"`, a missing side-effect import
  (`import './sentry'`) goes undetected until the Docker build fails.
  Set once in the repo-root `tsconfig.base.json` so every package's
  `tsconfig.lib.json` / `tsconfig.spec.json` inherits it. Bundler-style
  frontend lib configs that extend the base still inherit this — no
  per-package override needed.
- **Package manager: pnpm.** Every `package.json` declares
  `"packageManager": "pnpm@<version>"` so corepack pins it. Lockfile is
  `pnpm-lock.yaml` — never commit `package-lock.json` or `bun.lockb`.
- **Use pnpm scripts** (`pnpm run lint`, `pnpm run format`), not
  prettier/eslint directly.
- **CLI argument parsing: `yargs`** using its idiomatic builder/handler
  API. `choices` for enums. Zod in `coerce` for constraints yargs can't
  express natively (`.positive()`, `.url()`). Let yargs handle type
  coercion (`type: "number"`) — don't re-wrap in `z.coerce`.
- **Interactive prompts: `inquirer`.** Exception: `readline.prompt()` for
  one-line prompts in utility scripts.

## Logging

- **Use `@polygonlabs/logger`** for all services. Never
  `@polygonlabs/servercore`'s `Logger` class.
- **`src/logger.ts` exports the factory, not a singleton.** Re-export
  `createLogger` and `Logger` from `@polygonlabs/logger`. Nothing at module
  load — no top-level `await`, no `getEnv()` call, no mutable binding.
- **Create the logger at the entry point, inject it.** Call `await createLogger()`
  once in `startServer.ts` / `index.ts`; pass into services via constructor
  arguments. Never `createLogger()` at module scope outside an entrypoint.
- **HTTP services: use `@polygonlabs/express`.** Mount `setupLogger(logger)`
  before any route. Call `getLogger()` to reach the request-scoped logger —
  never `req.log`, never `declare module 'express-serve-static-core'`, never
  thread `logger` through route factories. See
  `apps-team-ts-template/packages/example-rest-api/src/index.ts`. The
  `getLogger()` priming gotcha for test files that never mount Express is
  documented in `@polygonlabs/express`'s README.
- **Ethers fetch errors are sanitised automatically.** `@polygonlabs/logger`
  v2.1+ strips RPC tokens from every `{ err }` log call — handlers, cron
  ticks, `unhandledRejection`, startup. No per-call code change needed.
- **Test helpers are entrypoints.** A test helper calling `await createLogger()`
  at module scope is the test suite's entrypoint — `.env.test` is already
  loaded before Vitest imports it. This is the one sanctioned exception to
  the entrypoint rule.
- **Expose `PRETTY_LOGS`** via `BooleanSchema.default(false)` in `env.ts`,
  pass to `createLogger` at the entry point. `PRETTY_LOGS=true` in local
  `.env`.
- **`logger.warn` for retried failures; `logger.error` for terminal failures.**
  `warn` doesn't reach Sentry; `error` does. Decide at the outermost retry
  boundary (cron catch, `setError` action, consumer restart) — never at the
  inner throw site.
- **Log levels:**
  - `debug` — periodic polling, every-tick state reads
  - `info` — meaningful actions (TX submitted/confirmed, service started)
  - `warn` — transient failures that will be retried
  - `error` — terminal failures; Sentry fires
- **Flat context, no nesting.** Pass context directly in the merge object.
  Never under `data`. No `location` / `function` fields — the message
  identifies the call site.
- **Pass errors as `{ err }`** — not `{ error }`, not `err.message`. The
  pino serialiser activates only on the `err` key.
- **Log once — never log before rethrowing.** If a function rethrows, it
  must not log. Wrap with `VError` to attach inner-scope context as `info`;
  the outer boundary logs once.

See `apps-team-ops/docs/best-practices/logging.md`.

## Error Handling

- **Use `@polygonlabs/verror`** for all cross-boundary error wrapping.
- **Constructor: message first.**
  ```ts
  throw new VError('Human-readable description', { cause: originalError, info?: { ...context } });
  ```
  The message describes what the code was attempting; `cause` carries the
  original error.
- **Wrap, don't log, inside handlers.** Functions calling external systems
  (RPC, Firestore, HTTP) wrap caught errors with `VError` and rethrow.
  Never log before rethrowing — the log happens once at the boundary.
- **`info` only when non-empty.** Include when there are values a developer
  needs for investigation (tx hashes, block numbers). Omit — don't pass
  `info: {}` — when there's no useful context.
- **`serializeError(err)` for persistence.** Use from `@polygonlabs/verror`.
  Store `{ ...serializeError(err), stack: err.stack }`.
- **Persist error fields as records, not strings.** Schema:
  `z.record(z.string(), z.unknown()).nullable()`. Coerce pre-existing
  string values with a `.transform` for backward compatibility.

- **VError info is extracted automatically.** Don't manually spread
  `VError.info(err)` into the merge object — `@polygonlabs/logger` v2 merges
  the full cause-chain info into `err.info` when `{ err }` is passed.
  Datadog: `@err.info.<key>`. The old `@error_info.*` queries no longer
  match.
- **Use `WError` at REST API boundaries.** `WError` hides the cause chain
  from the client's message while preserving it for logs. `VError` inside
  the service; switch to `WError` at the outermost HTTP layer.
- **Use `createErrorHandler()` and `notFoundHandler` from `@polygonlabs/express`**
  as the global 404 and error middleware. The handler respects the author's
  wrapper choice (VError/WError/HTTPError) and only URL-strips the message
  via `sanitiseEthersFetchError` before responding. Never hand-roll
  per-service equivalents.

See `apps-team-ops/docs/best-practices/error-handling.md`.

## Release Management

- **Changeset bodies are user-facing changelog entries.** Markdown — headers,
  bullets, inline code. Lead with user-visible outcome, not implementation
  mechanism. No commit-type prefixes (`feat:`, `fix:`). See
  `apps-team-ops/docs/best-practices/changesets.md`.
- **First line of a changeset body must be plain prose, not a heading.**
  Changesets prefixes each entry with `- <commit-hash>:`; a heading renders
  as `- abc1234: ## My heading` (broken). Write a plain-text opener,
  headings from line 2:
  ```markdown
  Add /ready readiness probe and fix staleness detection in /service-status

  ## Breaking changes

  `networks[name].lastUpdateMs` renamed to `lastPollMs` ...
  ```
- **Preferred tool: `@changesets/cli`.** Reference:
  `apps-team-ts-template`.
- **Legacy: Lerna.** Migrate to changesets when opportunity arises — not
  an immediate requirement.
- **No default publish access.** Never set `access` in
  `.changeset/config.json`. Every published package declares its own
  `"publishConfig": { "access": "public" }` (or `"restricted"`).
- **Include `MIGRATION.md` in published packages.** Every `package.json`
  with `"publishConfig": { "access": "public" }` lists `"MIGRATION.md"`
  in `"files"` — npm only publishes files explicitly listed (plus a
  small default set).
- **Changelogs and tags for all packages** — `privatePackages.version: true`
  and `privatePackages.tag: true` in `.changeset/config.json`. Tags mark
  the exact commit deployed; essential for rollbacks and CD triggers.
- **Replace workspace protocol at release** — set
  `bumpVersionsWithWorkspaceProtocolOnly: false` in
  `.changeset/config.json` so `workspace:*` deps are replaced with real
  semver at Version Packages time. Required for Docker builds at release
  tags to install the npm-published version. See Monorepo Structure.
- **Signed release commits** — `release.yml` uses `commitMode: github-api`
  so version-bump commits are signed by GitHub's GPG key (required by
  branch protection).
- **PR gate** — `changeset-check.yml` runs
  `pnpm exec changeset status --since=origin/main` and comments when no
  changeset is found. Skips `changeset-release/*` branches.
- **`ci:publish` script** — `pnpm exec changeset publish` (publishes
  public packages and tags private ones). Never `pnpm publish` directly —
  fails on private packages and lacks the tagging needed to trigger the
  Docker release pipeline.
- **Docker release pipeline** — Any repo with a `Dockerfile` has a
  `docker-release-trigger.yml` triggering on changeset version tags
  (`<service>@[0-9]*`), with `test` (via `docker-test` composite action)
  and `release (needs: test)` jobs. Push-triggered deploys must migrate;
  delete the old workflow in the same PR. Reference:
  `apps-team-ts-template`.

## Supply Chain Security

Every repository must enable pnpm's built-in supply chain protections in
`pnpm-workspace.yaml` — the template's version has the exact required values.
At minimum, configure:

- **`blockExoticSubdeps`** — prevent transitive dependencies from
  non-registry sources (git URLs, tarballs)
- **`minimumReleaseAge`** — refuse to install packages published too
  recently (protects against malicious publications)
- **`minimumReleaseAgeExclude`** — exempt internal npm scopes so
  newly published internal packages can be installed immediately.
  The excluded scopes must match the ESLint internal import pattern
  (`internalPattern` in `@polygonlabs/apps-team-lint`):
  `@polygonlabs/*`, `@maticnetwork/*`, `@agglayer/*`,
  `@0xsequence/*`, `@0xtrails/*`
- **`trustPolicy`** — prevent trust-level downgrades between versions

Repos that need specific packages to run build scripts should use
`onlyBuiltDependencies` (allowlist) or `ignoredBuiltDependencies`
(suppress warnings) in the same file.

## Monorepo Structure

Multi-package repos use **pnpm workspaces**:

- Workspace packages declared in `pnpm-workspace.yaml`, not `package.json`.
  Root `package.json` must NOT have a `"workspaces"` field.
- Root `package.json` contains only `devDependencies` for repo-level
  tooling (linting, TypeScript, Husky). No root `dependencies`.
- Each package has its own `package.json` declaring all its deps
  explicitly. Never rely on hoisting — each package must work installed
  in isolation.
- No nested `package.json` outside the root and individual workspace
  packages.

### Workspace dependency resolution for Docker builds

Monorepos with deployable services must ensure Docker builds at a release
tag install the **npm-published** version of workspace library packages —
not local source with unreleased changes.

- **Root `.npmrc`** — `link-workspace-packages=false`. Only `workspace:*`
  protocol deps are linked locally; semver ranges resolve from npm.
- **`.changeset/config.json`** — `"bumpVersionsWithWorkspaceProtocolOnly": false`.
  Changesets replaces `workspace:*` with real semver in the Version
  Packages PR.

Lifecycle: `workspace:*` during dev → changesets replaces with `^x.y.z`
at release → Docker build at the release tag uses
`pnpm install --frozen-lockfile` against npm.

Developer convention: `workspace:*` when co-developing packages in the
same PR; leave as semver otherwise.

### Workspace library exports — build-free local development

Workspace library packages consumed by services in the same monorepo use
the `@polygonlabs/source` custom-condition export pattern:

```json
"exports": {
  ".": {
    "@polygonlabs/source": "./src/index.ts",
    "types":  "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

- `tsconfig.base.json`: `"customConditions": ["@polygonlabs/source"]`
  (inherited by every package's `tsconfig.lib.json` / `tsconfig.spec.json`).
  Library `tsconfig.lib.json` overrides `customConditions: []` so build-time
  resolution of workspace deps reads their published `dist/.d.ts`.
- Service `dev` scripts: `node --conditions @polygonlabs/source --watch src/index.ts`
- Dockerfile: `pnpm run build` before `pnpm deploy`
- Root `build` script: `pnpm -r --if-present run build` (topological
  order handles library → service build order automatically)
- Service packages must not have a `build` script unless they emit
  compiled output — `build: "tsc --noEmit"` is a fake build; put it in
  `typecheck`. Don't add `prelint` / `pretypecheck` / `predev` hooks.
- `publishConfig.exports` omits the `@polygonlabs/source` condition so
  published npm packages don't expose internal source.

See `apps-team-ops/docs/best-practices/docker.md`.

## Repository Conventions

- **`.nvmrc`** — matches the template version.
- **Conventional commits** — `type(optional-scope): description`, enforced
  by `@commitlint/config-conventional` (via `@polygonlabs/apps-team-lint`)
  through a Husky `commit-msg` hook. Claude uses this format too. Valid
  types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
  `refactor`, `release`, `revert`, `style`, `test`.
- **Pre-commit hook** — Husky + `lint-staged` (not `pnpm run format`) so
  only staged files are formatted and re-staged. Config in
  `.lintstagedrc.js` matching the template. Never `--no-verify`.
- **Pre-push hook** — changeset repos have `.husky/pre-push` matching the
  template. Runs `changeset status --since=origin/<baseBranch>` to catch
  a missing changeset before CI does. Skips `changeset-release/*` and the
  base branch.

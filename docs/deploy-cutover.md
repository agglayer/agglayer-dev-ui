# Cloudflare Cutover Runbook: `bridge-hub-ui-production` → `agglayer-dev-ui`

One-time runbook for the first production deploy of this repo's `wrangler.toml`
(worker name `agglayer-dev-ui`, route `dev-ui.agglayer.dev` via
`env.production.routes[0].custom_domain = true`). That domain is currently served by
an older worker, `bridge-hub-ui-production`, which this repo does not manage and
`wrangler deploy` will never touch. Follow this runbook once, in order, before merging
the PR that introduces the new worker config. After the cutover is verified complete,
this document has no further purpose — it is not part of the steady-state deploy flow
(that's [`docs/deployment.md`](./deployment.md)).

## Why this runbook exists

Two review comments on the PR that renamed the worker (`wrangler.toml`'s
`name = "bridge-hub-ui"` → `name = "agglayer-dev-ui"`) identified failure modes that a
plain `wrangler deploy` does not handle on its own:

1. **Orphaned old worker.** *"I think you'll have to get the SPEC team to manually
   delete the existing worker after this deploys — this will build a new worker and
   point the existing DNS at it, but it will never tear down the existing CF worker."*
   `wrangler deploy` only ever creates/updates the worker named in `wrangler.toml`
   (`agglayer-dev-ui`); it has no knowledge of, and will never delete,
   `bridge-hub-ui-production`.
2. **Custom-domain attach conflict + merge timing.** *"Two more angles on this beyond
   the orphaned worker: (1) `custom_domain = true` on `dev-ui.agglayer.dev` while
   `bridge-hub-ui-production` still owns that domain — a custom domain binds to one
   worker, so the first deploy either errors on the attach or steals the domain out
   from under the live site; (2) deploy.yaml fires on push to main, so whatever the
   cutover plan is, it executes the moment this merges. I'd like the sequencing written
   down (SPEC coordination included) before this leaves draft."* A Cloudflare custom
   domain can only be bound to one worker at a time, and this repo's deploy trigger
   (push to `main`, or `workflow_dispatch` — see `.github/workflows/deploy.yaml`) gives
   no pause between merge and the live attach attempt. Whether Cloudflare errors out or
   silently reassigns the domain on that first attach is exactly the ambiguity this
   runbook removes, by having the domain detached from the old worker *before* the new
   worker's first deploy runs, on a schedule a human is watching.

Every step below exists to close one of these two comments. Section 1 closes the
"SPEC must act before this merges" half of both; Section 3 closes the "domain must
actually be re-pointed and old worker actually gone" half of both; Section 4 exists
because comment 2 explicitly asked for the sequencing, worst case included, to be
written down.

## 1. Pre-merge checklist

Complete every item below before merging the PR that ships `wrangler.toml`'s new
`name = "agglayer-dev-ui"` / `custom_domain` route to `main`. None of this can happen
after the merge — `deploy.yaml` fires on push to `main` with no manual gate in
between (see Section 2).

- [ ] **Create the `NEXT_PUBLIC_AGGKIT_PROXY` secret** in the `production` GitHub
      environment (alongside the existing `CF_WORKER_ACCOUNT_ID`,
      `CF_WORKER_API_TOKEN`, `NEXT_PUBLIC_PROJECT_ID`). This is a **build-time** value —
      Next.js inlines `NEXT_PUBLIC_*` vars at build, per `wrangler.toml`'s
      `[build] command = "pnpm run build:production"` — consumed by
      `resolveAggkitProxyOverride()` (`app/config.ts:64-78`), which returns `undefined`
      when the var is empty and lets the app fall back to `config.json`'s literal
      `https://PLACEHOLDER-mainnet-aggkit-proxy` / `https://PLACEHOLDER-testnet-aggkit-proxy`
      (`config.json` lines 149, 159 — only `devnet`, line 169, has a real value, and
      that value is `http://127.0.0.1:8555/aggkitapi`, unusable once deployed).
      **Skip this and the deploy does not silently ship the placeholder** — the
      workflow's `Assert NEXT_PUBLIC_AGGKIT_PROXY secret is set` step
      (`.github/workflows/deploy.yaml`) hard-fails with an `::error::` before
      `wrangler deploy` runs. That guard exists precisely so a missed secret shows up
      as a red CI run, not a live broken proxy — but it only helps if someone is
      watching the run (Section 2) and treats a red run as "cutover did not happen,"
      not as background noise to retry later.
- [ ] **Identify the SPEC contact** who owns `bridge-hub-ui-production` and the
      `dev-ui.agglayer.dev` DNS/custom-domain binding: `<SPEC contact — fill in name/handle before merging>`.
- [ ] **Agree the cutover window with that contact**, and get their explicit
      confirmation of two actions, timed as below (not done ad hoc):
      - **Immediately before the merge**, they detach the `dev-ui.agglayer.dev` custom
        domain from `bridge-hub-ui-production` (Cloudflare dashboard: Workers & Pages →
        `bridge-hub-ui-production` → Settings → Domains & Routes → remove the custom
        domain; or the equivalent API call). Doing this ahead of the new worker's first
        deploy — rather than letting `wrangler deploy` attempt to attach a domain still
        bound elsewhere — is what removes the "errors on the attach or steals the
        domain" ambiguity from comment 2: the attach in Section 3 then targets an
        unbound domain, a well-defined operation.
      - **Only after Section 3's post-deploy verification passes** (not before, and
        not automatically on merge), they delete the `bridge-hub-ui-production` worker.
        Leaving it undeleted until verification passes is deliberate: it is this
        runbook's rollback path (Section 4). Deleting it early forecloses that path for
        no benefit.
- [ ] Confirm who from the dev-ui side will watch the `main` push and the resulting
      `deploy.yaml` run live (Section 2) — the same person or someone in the same
      coordinated window as the SPEC contact above, not someone who checks in later.

## 2. Merge-time sequencing

The moment the PR merges to `main`, `.github/workflows/deploy.yaml`'s
`push: branches: [main]` trigger fires — there is no manual approval gate before the
`build-and-deploy` job starts (`environment: production` restricts which secrets are
available, but does not itself pause the run). In order, that job:

1. Checks out, installs, runs `pnpm run validate:config`.
2. Runs the `Assert NEXT_PUBLIC_AGGKIT_PROXY secret is set` guard. If the Section 1
   checklist was skipped, this is where it fails — loudly, before anything is deployed.
3. Runs `wrangler deploy --env production`, which creates/updates the
   `agglayer-dev-ui` worker and (per `env.production.routes` in `wrangler.toml`)
   attempts to attach `dev-ui.agglayer.dev` to it as a custom domain.

Because step 3 is the domain attach discussed in Section 1, **the person watching this
run must be online and watching at the moment of merge**, not discover the run
afterward — the whole point of pre-detaching the domain (Section 1) is to make step 3
land cleanly, and if it doesn't (the domain was not actually detached in time, the
attach errors for an unrelated reason, etc.), the sooner it's caught the smaller the
live-site gap. Watch the run at
`https://github.com/agglayer/agglayer-dev-ui/actions/workflows/deploy.yaml`. If the
guard step fails, no domain change happened — reopen the PR issue, fix the secret,
and re-run via `workflow_dispatch` once fixed (no need to re-merge).

## 3. Post-deploy verification

Once `deploy.yaml` finishes green, before telling the SPEC contact to delete the old
worker:

- [ ] **The domain serves the new worker.** `curl -sI https://dev-ui.agglayer.dev/`
      loads (not a Cloudflare "no route" / 522 / error page), and the Cloudflare
      dashboard's Workers & Pages → Custom Domains view shows `dev-ui.agglayer.dev`
      bound to `agglayer-dev-ui`, not `bridge-hub-ui-production`.
- [ ] **The app actually works end-to-end**, not just "a page loads" — exercise
      whatever this environment's smoke test is (see [`docs/deployment.md`](./deployment.md#5-smoke-test)
      for the aggkit-proxy-side checks); in particular confirm the deployed build is
      not silently talking to a placeholder `aggkitProxy` host, since that would load
      fine and fail invisibly (the exact failure mode Section 1's secret guard exists
      to prevent).
- [ ] **Only then**, confirm with the SPEC contact that `bridge-hub-ui-production` has
      been deleted, and that no DNS/route still points at it. Until this step is
      confirmed, treat the cutover as incomplete even if the site appears to work.

## 4. Rollback path

The rollback path differs depending on how far the cutover got:

- **Guard step failed (Section 2, step 2).** Nothing was deployed and the domain was
  never touched. No rollback needed — fix the secret and re-run.
- **Deploy succeeded but the new worker is broken, and `bridge-hub-ui-production`
  still exists** (i.e., verification in Section 3 failed before the old worker was
  deleted). This is the fallback Section 1 is built around: ask the SPEC contact to
  re-attach `dev-ui.agglayer.dev` to `bridge-hub-ui-production` (reversing the detach
  from Section 1), restoring the previously-live site while the new worker is fixed
  offline. This is why the old worker must not be deleted until Section 3 passes.
- **Deploy succeeded, verification passed, and a regression surfaces later** (i.e.,
  `bridge-hub-ui-production` is already gone). At this point rollback is scoped to
  `agglayer-dev-ui` itself, the same as any later dev-ui deploy — see
  [`docs/deployment.md`](./deployment.md#7-rollback)'s "dev-ui (Cloudflare Workers
  path)" entry (`wrangler rollback --env production`, or redeploying the previous
  commit). There is no path back to `bridge-hub-ui-production` once it's deleted.

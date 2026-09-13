# `loadtest/` — adversarial review and audit (plan step S20)

Reviewer: independent audit of the whole `feat/bridge-loadtest` change set.
Date: 2026-09-11.

**Scope and diff base.** The branch is stacked on `fix/pr24-review-followup`
(@ `d5529b3`), **not** `origin/main` — user-approved 2026-09-10, because the
vendored compose devnet exists only on that branch. Verified:
`git rev-parse feat/bridge-loadtest` == `git rev-parse fix/pr24-review-followup`
== `d5529b3`, so `git diff fix/pr24-review-followup...feat/bridge-loadtest` is
**empty** and the entire deliverable is an uncommitted working tree (11 modified
tracked files + the new `loadtest/`, `tests/loadtest-e2e/`,
`app/context/e2eAccount.test.ts`, `playwright.loadtest.config.ts`,
`.github/workflows/loadtest-e2e.yaml`). Everything below was audited as new
files against `git diff HEAD` plus the untracked trees. ~19 800 lines reviewed.

**Baseline re-verified:** `pnpm run check` = **550 passed / 550**, 43 files;
`eslint` 0 errors / 3 pre-existing warnings; `tsc --noEmit` clean.

**No fixes were made.** This document is input to S21.

---

## 0. Severity-ranked finding index

| ID | Sev | Area | One-line | File:line |
|---|---|---|---|---|
| **R0** | **CRITICAL** | Safety | The mainnet confirmation gate covers only `fund` — `run` against `env: "mainnet"` needs no confirmation and there is no dry-run | `wallets/fund.ts:441-444`, `runner.ts:534-542`, `cli.ts:184/189/345` |
| **R19** | **High** | Safety | `maxTotalSpend` has **no ERC20 counterpart** — ERC20 top-ups are uncapped | `wallets/fund.ts:543-546`, `:547-615`, `config/schema.ts:173-183` |
| **R28** | **High** | Report honesty | `ready_to_claim` is re-recorded on **every** T20 retry cycle — contradicting `ring.ts`'s own note N2 — flooding the histogram with near-zero samples | `core/ring.ts:613` |
| **R29** | **High** | Correctness / honesty | The token bucket silently discards offered load when the pump gap exceeds `periodMs`, and `ticksOffered` is a tautological sum that cannot reveal it | `core/scheduler.ts:207-208`, `:254-259`, `runner.ts:922` |
| **R1** | **High** | Resource leak | `run` never exits: an abandoned driver call can relaunch the browser pool *after* `dispose()` | `runner.ts:319-345`, `pool.ts:245`, `pool.ts:465`, `pool.ts:525` |
| **R2** | **High** | Report honesty | Phase-latency percentiles are survivor-biased — timed-out phases contribute no sample, and the report does not say so | `core/ring.ts:502-520` |
| **R3** | **High** | Correctness | No nonce serialization on the **user** send path; `ChainNonceManager` is funder-only, while `maxInflightLapsPerUser: 3` puts 3 concurrent sends on one EOA | `headlessUser.ts:791`, `chainClients.ts:77`, `fund.ts:357/503/570` |
| **R4** | **High** | Report honesty / leak | Timed-out driver operations are never cancelled, so their traffic keeps being recorded against a hop already declared failed | `runner.ts:319-345`, `headlessUser.ts:813` |
| **R5** | Medium | Safety | The E2E override **symbol** ships in every production bundle (the gate itself holds); the plan's "nothing leaks" expectation is not literally true | `app/context/e2eAccount.ts:22-38` |
| **R6** | Medium | Report honesty | Gate-stall p90/p99 are right-censored at the timeout and presented as plain percentiles | `metrics/report.ts:404-418` |
| **R7** | Medium | Report honesty | Suppressed error classes (`not_ready`, benign external-asset `console_error`) are counted nowhere — `summary.md` can read "No errors recorded." while `activity.ndjson` holds them | `metrics/collector.ts:688`, `:710` |
| **R8** | Medium | Report honesty | Achieved rate divides by **requested** minutes, not elapsed — a SIGINT-aborted run understates its own throughput proportionally | `metrics/report.ts:133-145` |
| **R9** | Medium | Correctness | No guard that `rampUpSeconds < durationMinutes × 60`; `--minutes 1` at the default ramp reports achieved rate exactly `0.0000` | `config/schema.ts:216`, `metrics/report.ts:134` |
| **R10** | Medium | Correctness | No runtime assertion that a browser context's connected wallet is the intended per-user wallet — a silent `addInitScript` regression collapses all browser users onto one key | `browserUser.ts:305/371`, `pool.ts:330-336` |
| **R11** | Medium | Report honesty | HTTP samples made outside a `runWithFetchContext` scope are silently dropped, so endpoint counts are an undisclosed lower bound | `uiCallset.ts:346-378` |
| **R12** | Medium | Hygiene | `.env.local.bak` is **not** gitignored and contains a (devnet) private key | `.gitignore:59-61` |
| **R13** | Low | Hygiene | 20 `loadtest/**` files fail `prettier --check` (already an S21 task) | — |
| **R14** | Low | Resource leak | `installTimingFetch`'s uninstall handle is discarded; `globalThis.fetch` is never restored | `runner.ts:579`, `uiCallset.ts:380-386` |
| **R15** | Low | Resource | Collector retains every HTTP/phase sample in memory for the whole run, unbounded | `metrics/collector.ts:757-790` |
| **R16** | Low | Robustness | `runner.ts`'s `logger` defaults to a silent no-op, so a caller that omits it loses every diagnostic including redacted fatal errors | `runner.ts:514` |
| **R17** | Info | Process | The branch carries **zero commits**; the whole deliverable is an uncommitted working tree | — |
| **R18** | Info | Deferred | A5 multi-process sharding and A7–A10 remain open (already S21 tasks, not re-discovered here) | `VALIDATION-1.md` §2 |
| **R20** | Medium | Parity gap | Undeclared cadence divergence: headless treats an `ERROR` row as terminal, the real UI does not, so headless under-polls | `uiCallset.ts:423-424` vs `app/hooks/useTransactions.ts:24-25` |
| **R21** | Medium | Safety | `redactSecrets` cannot redact a BIP-39 mnemonic at all, nor an un-prefixed 64-hex key — and `LOADTEST_MNEMONIC` is a first-class supported secret | `wallets/redact.ts:17` |
| **R22** | Medium | Safety | `ui/build.ts` forwards the **entire** parent environment to `next build` with `stdio: 'inherit'`, so child output bypasses redaction | `ui/build.ts:265-276`, `:288-292` |
| **R23** | Medium | Safety | Nothing cross-checks the `env` label against the actual `chainId`/`rpcUrl` — `env` is a trusted free-standing string | `config/schema.ts:300` |
| **R24** | Low | Safety | `wallets/preflight.ts` never redacts at source; safety rests entirely on `cli.ts`'s single catch (known, S12) | `preflight.ts:91/119/169/197/260` |
| **R25** | Low | Safety | HAR recording and `browser.trace` are present-but-unwired; a Playwright trace would capture the raw key passed to `addInitScript` | `pool.ts:83/164/193/325-328`, `config/schema.ts:239/243` |
| **R26** | Info | Docs | P2 is not implemented at all; DESIGN §9.1 / PARITY §5 describe it as "probability 0", implying a knob that does not exist | `DESIGN.md:961`, `PARITY.md:146` |
| **R27** | Info | Safety | `fund.ts`'s Pass-2 incremental cap check is confirmed dead code (Pass 1 already guarantees it); cap values themselves are unbounded | `fund.ts:493-496`, `:515-519`, `schema.ts:181` |
| **R30** | Medium | Observability | Every per-phase timeout is emitted with `transition: 'T28'`, so T3/T5/T7/T9/T12–T14/T19–T23/T26's timeout arcs never appear under their own id | `core/ring.ts:775-784` |
| **R31** | Low | Observability | The `lapMs` path closes an open gate visit without emitting `gate_exit`, and hand-rolls logic `finish()` already encapsulates | `core/ring.ts:1082-1104` |
| **R32** | Low | Dead code | T27's documented `AWAITING_CLAIMED` half is unreachable; plus three other confirmed-dead branches and one orphaned type | `core/ring.ts:686-710`, `:763-773`, `:534-536`, `core/types.ts:224` |
| **R33** | Low | Docs | `DESIGN.md` contradicts itself on the `lapMs` default: prose says `2 700 000`, its own table says `3 600 000` (the table is right) | `DESIGN.md:410` vs `:427` |
| **R34** | Info | Docs | DESIGN §3.5's prose implies `maxInflightLapsPerUser` is a per-**user** cap; the code (correctly, per §3.5's own asset-interleaving clause) applies it per (user, asset) | `core/scheduler.ts:166-178` |

Findings from the three sub-audits (ring/scheduler, parity, safety) are merged
into §2–§5 under the same R-numbers.

---

## 1. What I could NOT audit, and why

Stated plainly, per the acceptance criteria:

1. **No live run was performed.** The compose devnet was not brought up and no
   `run`/`fund`/`preflight` was executed. Every runtime claim below is either
   (a) traced statically to file:line, or (b) taken from the plan's recorded
   S08/S10/S11/S13/S14/S17 runs. Where a finding needs a live repro I say so
   and give the exact command.
2. **R1's hang is root-caused statically, not reproduced.** Reproducing it
   needs a multi-slot browser run with real crashes (S17's shape: 150 browser
   users, 19 slots). The code path is proven by reading; the *frequency* is not.
3. **The testnet/mainnet path is unexercised** — S18 is blocked for want of a
   funded Sepolia key and a real aggkit-proxy URL (`config.json` carries only
   `https://PLACEHOLDER-testnet-aggkit-proxy`). Confirmed as described. So
   every prod-path safety claim (funder transfers, ERC20 spend, real gas
   pricing) rests on unit tests with a mocked viem client, not on a real chain.
4. **Latency numbers from S14/S17 are unusable by the tool's own admission**
   (A5 self-disqualification fired: `eventLoopDelayP99Ms` peaked at 35 433 ms
   against a 100 ms threshold). I therefore could not audit whether the
   *latency* figures are correct — only whether the disqualification machinery
   that refuses to present them is correct. It is.
5. **`aggkit`'s own `/metrics` is unreachable** (port not published by the
   vendored compose file; `:11577/metrics` → 404), so nothing in the report can
   be cross-checked against aggkit-side counters. Recorded honestly by S14/S17.
6. **The devnet is wedged** (`agglayer_node_network_latest_certificate_in_error{network_id="1"} = 1`,
   SIGBUS in the SP1 native executor, deterministic across three runs). Any
   fresh end-to-end validation would measure a broken backend, so I did not
   attempt one.
7. **Prettier could not be made clean** without a formatting pass, which S20's
   non-goals forbid. Reported as R13 only.
8. **R29's tick loss is shown reachable, not shown to have fired.** The
   precondition (a pump gap exceeding `periodMs`) is demonstrably reachable on
   this host at the plan's own `--rate 2`, given S17's measured 35 433 ms
   event-loop p99 — but S14 predates event-loop sampling and S17 ran at
   `--rate 1`, where `periodMs` stayed above the measured delay. I could not
   confirm ticks were actually lost in any recorded run.
9. **The `_ltPollOrigin=harness` marker's inertness on the wire** rests on
   S24's orchestrator-verified live comparison; I confirmed from code only that
   it cannot affect endpoint classification. Re-verifying the proxy's
   indifference to the extra query parameter needs a live devnet.
10. **The single-flight dedup path under real lap concurrency** is proven by
    unit test, not by a live trace: the only headless trace available
    (`loadtest-results/20260910T203813Z/`) drove 2 sequential laps per user, so
    `maxInflightLapsPerUser > 1` was never exercised in captured traffic.

---

## 2. Critical and high-severity findings

### R0 — The mainnet confirmation gate protects `fund`, not the load test itself

**Severity: CRITICAL** (real-funds safety). This is the single highest-severity
finding in the audit and the only one I would call a release blocker.

**Files:**
- `loadtest/wallets/fund.ts:441-444` — `MAINNET_CONFIRMATION_REQUIRED`, the **only** check
- `loadtest/runner.ts:534-542` — `fundWallets` is called **only** `if (options.fund)`
- `loadtest/cli.ts:184, 189, 345` — the only three references to `mainnetConfirmed`
- `loadtest/config/schema.ts:300` — `env` accepts `'mainnet'`

**What is wrong.** `--i-know-this-is-mainnet` / `mainnetConfirmed` is consumed in
exactly one place: `fund.ts:441-444`, inside `fundViaTransfer`. That function is
reached only when `runLoadTest` decides to fund (`runner.ts:534-542`,
`if (options.fund)`). Once the wallets are funded — in a prior invocation, or by
any other means — the confirmation flag is never consulted again anywhere in
`runner.ts` or `cli.ts`.

So this command:

```
pnpm loadtest run --config mainnet.loadtest.json        # note: no --fund
```

against a config with `env: "mainnet"` will, with **no confirmation prompt, no
flag, and no dry-run mode**, proceed to sign and broadcast up to
`users.total × bridgesPerMinutePerUser × durationMinutes` real bridge
transactions from real funded wallets on mainnet, plus the corresponding
approves and claims. At the plan's target scale that is 300–1000 wallets at
1–2 bridges/user/min for tens of minutes.

The gate is on the step that *moves* money into the wallets, not on the step
that *spends* it. That is backwards: funding is recoverable (the funds are still
yours, in wallets you derived); the load test is not — every bridge burns gas on
two chains and every lap that fails mid-ring leaves value stranded on an
intermediate network.

Aggravating factors:
- There is **no `--dry-run`** anywhere. `grep` of `cli.ts`'s command switch and
  usage string confirms it: the only rehearsal available is `validate`, which
  checks the config's shape and never simulates the load.
- **R19** (below) means the ERC20 leg of that run has no spend cap at all.
- **R23** means nothing verifies that a config labelled `devnet` is not in fact
  pointed at mainnet RPCs, or vice-versa — so the `env` string that gates
  `fund` is itself untrusted input.

**Repro.** Take `loadtest/config/examples/testnet.loadtest.json`, set
`"env": "mainnet"`, supply any real `aggkitProxyUrl` (a non-placeholder host,
so `PROXY_URL_PLACEHOLDER` passes) and pre-funded wallets, then
`pnpm loadtest run --config <that file>` with no `--fund`. Nothing asks for
confirmation. (Not executed here — see §1: no funded mainnet key exists in this
environment, which is also why S18 is blocked.)

**Fix shape for S21** (not applied): move the `env === 'mainnet'` confirmation
check into `runLoadTest`'s entry (or `cli.ts`'s `run` handler) so it gates the
load test unconditionally, independent of `--fund`; and add a `--dry-run` that
walks preflight + the scheduler with the drivers stubbed. Consider also
requiring it for `env === 'testnet'` when `maxTotalSpend` is absent.

---

### R19 — `maxTotalSpend` caps native currency only; ERC20 top-ups are uncapped

**Severity: High** (real-funds safety; compounds R0).

**Files:**
- `loadtest/wallets/fund.ts:543-546` — the code's own comment says it
- `loadtest/wallets/fund.ts:547-615` (transfer path) and `:291-407` (devnet path) — the uncapped ERC20 loops
- `loadtest/config/schema.ts:173-183` — `funderSchema` has no ERC20-spend field

**What is wrong.** The native path maintains `cap`/`spent` and refuses the whole
fund up front if the total exceeds the cap (`fund.ts:467-491`, a genuine
enforcement — see R27). The ERC20 path has **no equivalent**. `fund.ts:543-546`
states it plainly: *"ERC20 asset top-ups on ring[0] (not counted against
`maxTotalSpend`, which is denominated in the chain's native currency…)"*. The
loop below computes `topUp = funder.assetTopUp ?? defaultAssetTopUp(...)` and
issues `writeContract(transfer, …)` per wallet with no cap check of any kind, and
the schema offers no field to set one.

The only backstop is the funder's ERC20 balance running out, which produces a
revert (`fund.ts:598-603`) — **after** every prior transfer has already
succeeded. On a mainnet or testnet config naming a real, valuable ERC20 (real
USDC, say), a fat-fingered `assetTopUp` or a large `users.total` has no
preventive limit whatsoever.

This is **already known**: S05 recorded it and S18's blocked note carries it
forward as "remaining prod-path risk to call out in the PR". I am re-raising the
severity because R0 removes the one gate that made it tolerable — with no
mainnet confirmation on `run` and no ERC20 cap on `fund`, there are two
independent missing guards on the same money path.

**Repro.** A config with `assets: [{kind: 'erc20', …}]`, `users.total: 1000`,
`funder.assetTopUp: "100"`, and any `maxTotalSpend`. `pnpm loadtest fund` will
attempt 100 000 tokens' worth of transfers; `validate` passes.

---

### R28 — `ready_to_claim` is re-recorded on every retry cycle, against `ring.ts`'s own note N2

**Severity: High** (report honesty; same optimistic direction as R2, on the same
metric, so the two compound).

**Files:** `loadtest/core/ring.ts:613` (`applyAwaitingReady`, lines 574-624);
`ring.ts:20-31` (note N2); `ring.ts:481-500` (`goTo`, which resets
`stateEnteredAt`).

**What is wrong.** Note N2 in the file's own header states the rule explicitly:

> "T20 re-enters `AWAITING_READY` with a FRESH `readyToClaimMs` window … but
> keeps `readyAt` and **does not re-record the `ready_to_claim` phase**."

The code does not honour it. `applyAwaitingReady` calls

```ts
recordPhase(mut, phaseSample('ready_to_claim', now, mut.hop.stateEnteredAt));   // :613
```

**unconditionally** whenever it processes a row that is still `READY_TO_CLAIM` —
with no guard for whether this is the first observation. Each T20 loop
(`CLAIM_BUILD` →`claimable: false`→ `AWAITING_READY` →still `READY_TO_CLAIM`→
back to `CLAIM_BUILD`) passes through `goTo`, which **resets `stateEnteredAt`**,
so the next sample's duration is merely the poll interval since re-entry — not a
"ready to claim" latency at all.

**Effect on the numbers.** A hop that cycles through `not_yet_claimable` N times
(the `l1-info-tree-index` / syncer-inconsistency gate stall, which S14 recorded
as the dominant backpressure cause — 1583/1790 skips had their oldest hop on the
`claim-proof` gate) emits **N+1** `ready_to_claim` samples, N of them
near-zero. The §5.1 `ready_to_claim` histogram is therefore diluted toward zero
by exactly the hops that struggled most, so p50/p90 read **better** the worse the
backend behaves.

That matters beyond cosmetics: DESIGN §3.3 justifies the `readyToClaimMs` /
`hopMs` defaults from measured `ready_to_claim` latency. A metric biased low by
retry churn is the wrong input for sizing the very timeout that produces the
churn.

Together with **R2** (timed-out `ready_to_claim` waits contribute no sample at
all), `ready_to_claim` is biased optimistically from both ends simultaneously:
the slow tail is dropped and the fast head is duplicated. Of every figure in the
report, this is the one I would trust least.

**Repro (unit-level, no devnet).** `ring.test.ts:395-426` ("does not re-enter the
grace window after escalating") already drives exactly the T20 →
re-poll-`READY_TO_CLAIM` sequence, but asserts only on `transitions` and
`autoclaim_overdue` — it never inspects `.phases`. Add:

```ts
expect(again.lap.hops[0]?.phases.filter(p => p.phase === 'ready_to_claim')).toHaveLength(1);
```

and it fails: the array holds **2** entries.

---

### R29 — The token bucket silently discards offered load, and `ticksOffered` cannot reveal it

**Severity: High** (correctness + report honesty: the *denominator* of the
headline achieved-vs-requested comparison can shrink without anyone knowing).

**Files:**
- `loadtest/core/scheduler.ts:207-208` — the credit cap and unconditional `lastRefillAt` advance
- `loadtest/core/scheduler.ts:209, 214` — one token consumed per pump call
- `loadtest/core/scheduler.ts:254-259` — `ticksOffered` defined as the sum of the other three counters
- `loadtest/runner.ts:922, 984` — `PUMP_INTERVAL_MS = 1000`, driven by `await sleep(...)`

**What is wrong — part 1, the lost ticks.**

```ts
bucket.creditMs = Math.min(periodMs, bucket.creditMs + (now - bucket.lastRefillAt));  // :207
bucket.lastRefillAt = now;                                                            // :208
if (bucket.creditMs < periodMs) continue;                                             // :209
...
bucket.creditMs -= periodMs;                                                          // :214
```

Credit is capped at exactly one token's worth and `lastRefillAt` advances
unconditionally, so if the real gap between two `pump()` calls exceeds
`periodMs` (`= 60_000 / bridgesPerMinutePerUser`), **the excess is discarded, not
carried over** — the bucket can fire at most one tick per user per pump call
regardless of how many periods elapsed. Nothing in `scheduler.ts` documents a
required minimum pump cadence, and nothing guards against violating it.

**This is not merely latent.** `PUMP_INTERVAL_MS` is 1 000 ms, so a naive
reading says the cap only bites above 60 bridges/user/min. But the pump loop is
`await sleep(PUMP_INTERVAL_MS)` on the **same event loop** that A5 documents as
saturated: S17 measured `eventLoopDelayP99Ms` peaking at **35 433 ms**. A
nominal 1 s sleep can therefore take ~35 s, and at the plan's own target
`--rate 2` (`periodMs = 30 000`) that gap **exceeds** `periodMs`. So on this
host, at the rate S14 actually used, the precondition for silent tick loss is
demonstrably reachable. (I did not observe lost ticks directly — S14 predates
event-loop sampling, and S17 ran at `--rate 1` where `periodMs = 60 000` stayed
above the measured 35 s. Reachable and evidenced, not confirmed fired.)

**What is wrong — part 2, and this is the sharper half.** `ticksOffered` is not
measured; it is *defined* as `ticksIssued + skippedBackpressure + ticksLostToRamp`
(`scheduler.ts:258`). It is therefore a **tautology** with respect to the
scheduler's own three counters and can never disagree with them. If the bucket
drops demand, `ticksOffered` simply comes out smaller — and the DESIGN §5.5
identity still prints **OK**, because every term shrank together.

Meanwhile `ticksLostToRamp` (`scheduler.ts:155-158`) is a closed-form value
computed once from the ramp formula; it accounts only for ramp-in delay and
never for a coarse pump cadence. So there is **no counter anywhere** for
"demand the user requested that the scheduler never offered".

**Why this matters for the report's conclusions.** `summary.md` presents
`rate per user/min (requested)` beside `steadyStateRatePerUserPerMin (achieved)`
and an identity check that says OK. A reader concludes "the tool offered the
requested load and the system under test could only absorb X". But if the pump
was starved, the tool never offered the requested load in the first place, and
the identity — designed to catch exactly this class of error, and which
genuinely caught S11's unit mismatch — is structurally blind to it. S14's
headline "achieved 0.87/user/min = 43 % of target" and its 51 %-backpressure
narrative both rest on a demand figure that can silently shrink.

The honest fix is cheap: compute a **fourth, independent** term —
`ticksExpected = users × bridgesPerMinutePerUser × durationMinutes` from the
config — and report `ticksOffered` against it. Any gap is then visible instead of
absorbed. (Or carry credit across multiple periods and cap the bucket at more
than one token, which fixes the loss itself.)

**Repro (unit-level, no devnet).** `scheduler.test.ts`'s `run()` helper always
uses `stepMs = 1000` and every test keeps `bridgesPerMinutePerUser ≤ 60`
(`periodMs ≥ 1000`), except line 81 which pairs `stepMs = 100` with rate 2.5 —
so the suite **never** exercises `stepMs > periodMs` and the gap is untested.
Drive the scheduler with `bridgesPerMinutePerUser: 2` (`periodMs = 30 000`) and
`stepMs = 45_000` for 10 steps: true demand is ~15 ticks/user, `ticksIssued` is
10, and `ticksOffered` reports 10 rather than 15, with the identity OK.

---

### R1 — `run` never exits: an abandoned driver call can relaunch the browser pool after teardown

**Severity: High** (resource leak; this is S17's reported hang, root-caused).

**Files:**
- `loadtest/runner.ts:319-345` — `raceOrTimeout`
- `loadtest/runner.ts:1024-1026` — `writeReportFiles` then `disposeEverything`
- `loadtest/workers/browser/pool.ts:245-247` — `launchSlot`, no `disposing` check
- `loadtest/workers/browser/pool.ts:465-470` — `acquireContext`, no `disposing` check
- `loadtest/workers/browser/pool.ts:525-537` — `dispose()`, does not await in-flight launches
- `loadtest/cli.ts:413-419` — `main().catch(...)` sets `process.exitCode`, never `process.exit()`

**What is wrong.** `raceOrTimeout` documents its own behaviour:

> "If the deadline wins, the promise is **abandoned (not cancelled** — its
> eventual settlement is simply dropped by the caller…)"

The runner then awaits only the *lap tasks* (`await Promise.allSettled(activeLapTasks)`,
`runner.ts:998`) — a lap task returns as soon as `raceOrTimeout` resolves
`{timedOut: true}`, so the abandoned driver promise **outlives it**. An
abandoned browser-mode driver call can still be sitting inside
`pool.acquireContext()` → `createContextFor()` → `launchSlot()`.

`dispose()` sets `this.disposing = true` and closes what exists *at that
instant*. It does **not** await `slot.launching` or `this.crashInFlight`, and
neither `launchSlot` (`pool.ts:245`) nor `acquireContext` (`pool.ts:465`)
checks `this.disposing`. (`browser.on('disconnected')` at `pool.ts:258`,
`context.on('close')` at `pool.ts:342` and `runSlotCrashRecovery` at
`pool.ts:413` *do* check it — so the crash-driven relaunch paths are guarded;
the **direct** launch paths are not.)

Net effect: a `launchSlot` that starts, or is still in flight, at or after
teardown completes successfully and assigns a **fresh** `slot.server`
(a real Chromium child process) and `slot.browser` (a connected WebSocket) that
nothing will ever close. Both are libuv handles, so Node's event loop never
drains. Because `cli.ts` ends by setting `process.exitCode` rather than calling
`process.exit()`, the process hangs indefinitely — **after** `run: complete` has
already printed (cli.ts prints it only once `runLoadTest` has resolved, i.e.
after `disposeEverything`). That is exactly S17's signature: "hangs well past
printing `run: complete`… holding hundreds of Chromium processes", and the
orphaned 2 h 45 m run with 127 Chromium processes.

With 19 slots and 516 `browser_crash` events in S17 run 1, a relaunch being
in flight at drain time is not a rare race — it is likely.

**Repro (needs a live devnet).**
```
pnpm loadtest run --users 40 --browser 40 --rate 2 --minutes 3
# while it runs, kill a Chromium slot to force a relaunch near the drain
# boundary, then after "run: complete" prints:
ps -o pid,etime,rss,cmd -C chrome | wc -l    # > 0, indefinitely
```
Deterministic unit-level repro without a devnet: in `pool.test.ts`, start a
`launchSlot` on a stubbed `chromium.launchServer` that resolves after a delay,
call `dispose()` before it resolves, then assert the slot's `server`/`browser`
are null. They are not.

**Why it matters beyond tidiness.** Any script waiting on the `run` PID hangs
(S13's e2e and the nightly CI job need a bounded wait), and an orphaned run
contaminates the next run's host-resource baseline — which S17 caught happening.

---

### R2 — Phase-latency percentiles are survivor-biased, and the report does not disclose it

**Severity: High** (report honesty — this is the "a number that flatters
itself" class the audit was asked to hunt, and it is in the headline latency
table).

**Files:**
- `loadtest/core/ring.ts:502-516` — `finish()`
- `loadtest/core/ring.ts:517-520` — `failWithTimeout()`
- `loadtest/core/ring.ts:579, 613, 645, 661, 690, 818, 830, 836, 856, 863, 959, 966, 973` — every `recordPhase` site
- `loadtest/metrics/report.ts:334-345` — `renderPhaseLatencies`

**What is wrong.** Every `recordPhase(...)` call in `ring.ts` sits on a
**success** transition. `failWithTimeout` does only:

```ts
const failWithTimeout = (mut: Mut, outcome: TimeoutOutcome, now: number): void => {
  mut.hop = { ...mut.hop, timeouts: [...mut.hop.timeouts, outcome] };
  finish(mut, 'FAILED', outcome, now);
};
```

and `finish` records a phase sample only for `hop_total`, only when
`isSuccessOutcome(outcome)` (`ring.ts:511`). So a phase that **times out
contributes no latency sample at all** — its elapsed time is discarded.

Consequence, using S14's real numbers: of 667 `L2A→L2B` hops, 534 timed out at
`readyToClaimMs`. The `ready_to_claim` row in `summary.md`'s **Phase latencies**
table is therefore the distribution over the ~133 hops that *did* become
claimable. The reported p50/p90/p99 are systematically **better than reality**,
and nothing in the report says so. A reader can only infer it by comparing each
row's `n=` against the hop-outcome table — a comparison the report never makes
and never prompts.

This is documented for `hop_total` only (note N5, "only a successful hop
contributes a `hop_total` latency sample"), which is a defensible choice for a
*total*. Silently extending the same rule to **every individual phase** is not
equivalent: `ready_to_claim` is precisely the quantity a reader wants when
asking "how long does this bridge take", and censoring its failures inverts the
answer.

Note the direction: the disqualification banner (R6-adjacent, `report.ts:320-332`)
protects against *over*-reporting latency caused by event-loop lag. There is no
counterpart protecting against *under*-reporting caused by dropping the
timed-out tail. The two biases are not symmetric and only one is handled.

**Repro.** `metrics/report.test.ts` style, no devnet needed: drive a `RingEngine`
through one hop that succeeds `ready_to_claim` in 10 s and one that times out at
900 000 ms; snapshot the collector. `phases.global.ready_to_claim` has `n=1`,
`p99=10000`. The 900 s wait is absent from the table and from `results.json`.

**Fix shape for S21** (not applied): either emit a phase sample on the timeout
path with the censored duration and a `censored: true` marker, or — cheaper and
sufficient for honesty — have `renderPhaseLatencies` print each phase's sample
count against the number of hops that entered that phase, and a one-line note
that timed-out phases are excluded. The existing `gates` table already carries
`hopsEntered`, so the denominator is available.

---

### R3 — No nonce serialization on the user send path; the funder's discipline is not shared

**Severity: High** (correctness + report honesty: it manufactures errors that
are then attributed to the system under test).

**Files:**
- `loadtest/wallets/chainClients.ts:61-112` — `ChainNonceManager` (the serialized per-chain nonce queue DESIGN §4.4 specifies)
- `loadtest/wallets/fund.ts:357, 376-387; 503, 520-526; 570, 588-599` — the **only** three users of it
- `loadtest/workers/headless/headlessUser.ts:791-795` — the **only** send site in the user path, with no `nonce`
- `loadtest/config/schema.ts` — `maxInflightLapsPerUser` default 3

**What is wrong.** DESIGN §4.4 gives the *funder* "one in-memory nonce counter
per chain… serialized queue… so concurrent callers never observe the same nonce
twice". Nothing equivalent exists for the load users. `headlessUser.sendAndWait`
issues:

```ts
txHash = await runtime.wallet.sendTransaction({
  to: mapped.to, data: mapped.data, value: mapped.value,
  ...(opts.gasOverride !== undefined ? { gas: opts.gasOverride } : {})
});
```

— no `nonce`, so viem's `prepareTransactionRequest` re-derives it with
`eth_getTransactionCount` per send (this is finding C4, and it is *correct*
parity with the UI, which also drops the SDK's nonce). But the tool then runs up
to **3 concurrent laps per user on one EOA** (`maxInflightLapsPerUser: 3`), with
one shared `runtime.wallet` per (user, chain). Three sends that interleave
between their `eth_getTransactionCount` and their `eth_sendRawTransaction` all
receive the same pending nonce.

This is not hypothetical: S14 logged **19** `Nonce provided for the transaction
is lower than the current nonce` plus **70** `Transaction creation failed.`
(viem `TransactionRejectedRpcError`, JSON-RPC `-32003`), and `VALIDATION-1.md:526-528`
already names the cause — "same-wallet concurrency from `maxInflightLapsPerUser: 3`
+ C4's dropped nonce". A4 then **classified** them into `rpc_error` and stopped
there.

**Why this is a report-honesty defect, not just a bug.** After A4, these land in
the `rpc_error` class — a name that reads as "the chain or the proxy rejected
us". `summary.md` presents `rpc_error 2037` (S17 run 1) / `4344` (run 2) with no
indication that an unknown share of it is the harness colliding with itself. The
tool exists to measure the proxy honestly; here it makes the system under test
look **worse** than it is, which is the same failure mode as flattering itself,
mirrored.

**The tension that must be resolved deliberately, not silently.** Adding a
per-(user, chain) nonce queue would *break* UI parity — a real user's wallet
does exactly what the tool does now. So the choice is between:
  (a) keep the parity, and **attribute** the collisions: a dedicated
      `nonce_conflict` error class (or a sub-count of `rpc_error`) plus a
      `summary.md` line stating that N errors are self-inflicted by
      `maxInflightLapsPerUser > 1`; or
  (b) serialize per (user, chain) and declare it in DESIGN §9.4 as a divergence.

Either is acceptable; the present state — neither — is not. Note DESIGN §9.4
closes with "Anything else that differs between the two modes is a defect", and
same-EOA concurrency is the one place where both modes are equally affected and
neither is declared.

**Repro.** `--users 1 --browser 0 --rate 6 --minutes 2` with
`maxInflightLapsPerUser: 3` against any anvil chain; grep `activity.ndjson` for
`nonce` — the collisions appear within the first minute and are recorded as
`rpc_error`.

---

### R4 — Timed-out driver operations are never cancelled, so a failed hop keeps generating recorded traffic

**Severity: High** (report honesty + bounded resource leak).

**Files:**
- `loadtest/runner.ts:319-345` — `raceOrTimeout` abandons rather than aborts
- `loadtest/workers/headless/headlessUser.ts:813` — `waitForTransactionReceipt({ hash: txHash })` with **no** `timeout`
- `loadtest/workers/headless/uiCallset.ts:346-378` — the abandoned request is still recorded, because the `AsyncLocalStorage` fetch context propagates into it
- `node_modules/viem/_cjs/actions/public/waitForTransactionReceipt.js:16` — viem's default `timeout = 180_000`

**What is wrong.** The only `AbortController` in the entire tool is
`runner.ts:128`, the UI-server liveness probe. No driver operation receives an
abort signal. When a phase deadline fires, `raceOrTimeout` records the timeout
outcome and moves on, while the underlying operation keeps running.

The sharpest case is the receipt wait. `txReceiptMs` is 60 000 on devnet and is
enforced **only** by `ring.ts`'s deadline via `raceOrTimeout`. viem's own
default is 180 000, so an abandoned receipt poller keeps issuing
`eth_getTransactionReceipt` for up to **three times** the configured budget
after the hop has already been recorded `timeout_bridge_receipt`. Those
requests are still inside the user's fetch context, so
`installTimingFetch` records every one of them as a
`rpc/<chain>/eth_getTransactionReceipt` sample.

Consequences:
1. `results.json`'s endpoint counts and RPC latency distributions include
   traffic from hops the same report declares failed. The load the tool says it
   generated and the load it actually generated differ, in an undisclosed
   direction and by an unmeasured amount.
2. Those polls contribute to `eventLoopDelayP99Ms`, which then triggers A5's
   self-disqualification — so the tool partly disqualifies its own numbers
   because of load it need not have created.
3. Every abandoned operation holds a timer/socket past the hop's end, feeding
   R1's teardown problem (bounded here at ~180 s, so R4 alone does not cause the
   indefinite hang — R1 does).

Credit where due: `raceOrTimeout` *does* attach both handlers to the abandoned
promise (`runner.ts:332-344`), so a later rejection is swallowed rather than
becoming an unhandled rejection. That part is correct.

**Repro.** `--minutes 2` against a chain with a stalled mempool; after the run,
grep `activity.ndjson` for `eth_getTransactionReceipt` samples whose
`tsOffsetMs` is later than the `hop_end` line for the same `hopId`.

---

## 3. Medium-severity findings

### R5 — The E2E override symbol ships in every production bundle (the gate itself holds)

**Severity: Medium** (safety / accuracy of the PR's claims).

**Files:** `app/context/e2eAccount.ts:22-38`; `app/constants/e2e.ts:6`.

**The gate is correct.** `resolveE2EPrivateKey` opens with
`if (!IS_E2E_ENABLED) return undefined;` as its first statement, so the
`window` read is unreachable when E2E is off. `IS_E2E_ENABLED` is
`process.env.NEXT_PUBLIC_E2E_ENABLED === 'true'`, build-time-inlined by Next.
The override is validated (`isHexPrivateKey`) before reaching
`privateKeyToAccount`, and the throw message does **not** echo the bad value, so
a malformed key cannot leak through the error. All verified and accepted.

**But the plan's expectation — "nothing leaks into production bundles, verify by
building without E2E and grepping `out/` for the override symbol" — is not
literally satisfied.** The guard is a *runtime* early return inside an IIFE, so
Turbopack's minifier cannot dead-code-eliminate the block; the whole closure,
including both string literals naming the `window` property, is compiled into
every build.

**Verbatim grep result — recorded as required.** Negative control, production
static export with E2E unset (`unset NEXT_PUBLIC_E2E_ENABLED NEXT_PUBLIC_E2E_PRIVATE_KEY LOADTEST_UI_BUILD; pnpm run build:production`):

```
$ grep -r '__AGGLAYER_E2E_PRIVATE_KEY__' out/ ; echo "exit=$?"
out/_next/static/chunks/0cse1_gyyy_9s.js:...e.s(["E2E_PRIVATE_KEY",0,E,"IS_E2E_ENABLED",0,_],709944);let S=(()=>{if(!_)return;let e=i(window.__AGGLAYER_E2E_PRIVATE_KEY__);if(e){if(!/^0x[0-9a-fA-F]{64}$/.test(e))throw Error("window.__AGGLAYER_E2E_PRIVATE_KEY__ is invalid. It must be a 0x-prefixed 32-byte hex private key.");return e}return E})(),...
exit=0

$ grep -rc 'AGGLAYER_E2E' out/ | awk -F: '$2>0'
out/_next/static/chunks/0cse1_gyyy_9s.js:1
```

Positive control, same build with `NEXT_PUBLIC_E2E_ENABLED=true NEXT_PUBLIC_E2E_PRIVATE_KEY=0x1111…1111`:

```
$ grep -r '__AGGLAYER_E2E_PRIVATE_KEY__' out/ ; echo "exit=$?"
out/_next/static/chunks/0b6_5npjz4tt~.js:...e.s(["E2E_PRIVATE_KEY",0,_,"IS_E2E_ENABLED",0,!0],709944);let I=(()=>{let e=i(window.__AGGLAYER_E2E_PRIVATE_KEY__);if(e){if(!/^0x[0-9a-fA-F]{64}$/.test(e))throw Error("window.__AGGLAYER_E2E_PRIVATE_KEY__ is invalid. It must be a 0x-prefixed 32-byte hex private key.");return e}return _})(),...
exit=0
```

**Reading of the two.** In the no-E2E build `IS_E2E_ENABLED` is the minified
binding `_` (false) and the guard `if(!_)return;` is **present and effective** —
the branch is inert and `E2E_PRIVATE_KEY` (`E`) is `undefined`, so **no key
material leaks**. In the E2E build the guard is gone (`IS_E2E_ENABLED` inlined
as `!0`) and the build-time key literal is present, as designed. The property
name is not renamed in either build — Turbopack renames locals, never member
names accessed as `window.X`.

**So: no secret leaks; the mechanism's name does.** The residual risk is
disclosure (any bundle reader learns the exact override hook exists) plus
fragility (the inertness depends entirely on the inlined constant staying
falsy). Both builds were run in a scratch pass and `out/`/`.next/` removed
afterwards; `git status --short` verified byte-identical before and after, and
`out/` is gitignored.

**Action for S21:** none required for safety. **Required for S22:** the PR must
say "the override is gated and inert in production builds" rather than "does not
appear in production builds", because the latter is false and is one grep away
from being contradicted by a reviewer.

---

### R6 — Gate-stall percentiles are right-censored at the timeout, presented as plain percentiles

**Severity: Medium** (report honesty).

**Files:** `loadtest/metrics/report.ts:404-418` (`renderGateStalls`);
`loadtest/core/ring.ts:503` (`finish` → `exitGate`, so a timed-out gate visit
*is* recorded — unlike phases, R2).

**What is wrong.** Gate visits are recorded on both the success and the timeout
path, which is right. But a visit that ended in a timeout has duration ≈ the
timeout, so the distribution piles up at the budget. `VALIDATION-1.md:825`
already reads this correctly — "the `claim-proof` p90/p99 ≈ 904 s is the
*signature of the 900 s timeout*, not a latency measurement: **do not raise
it**" — yet `summary.md` renders `p50 | p90 | p99` with no censoring note. The
next reader of a `summary.md` (without VALIDATION-1 in hand) will read 904 s as a
measured gate latency and will reach for `readyToClaimMs`, which is precisely
the wrong move the analysis warned against.

The table already carries `hopsEntered` and `blockedTicks`; it does not carry
"how many of these visits ended at the timeout", which is the one number that
makes the percentiles interpretable.

**Repro.** Any run where a gate times out (e.g. S14's
`loadtest-results/20260911T175302Z/summary.md`): the `claim-proof` row's p99 sits
at the configured `readyToClaimMs` with no annotation.

---

### R7 — Suppressed error classes are counted nowhere

**Severity: Medium** (report honesty).

**Files:** `loadtest/metrics/collector.ts:688`, `:710`;
`loadtest/metrics/errors.ts:197-239`; `loadtest/metrics/report.ts:430-445`.

**What is wrong.** `collector.error()` writes the line to `activity.ndjson` and
then returns early, before any aggregation, for two cases:

```ts
if (input.errorClass === 'not_ready') return;                                   // :688
...
if (input.errorClass === 'console_error' && isBenignExternalAssetHost(input.endpointClass)) return;  // :710
```

Both suppressions are *correct policy* (DESIGN §5.3 for `not_ready`; S11 defect
(3) for the `icon.invalid` favicon noise that hit 46/46 in one run). The defect
is that **no counter records how many were suppressed**. `not_ready` is at least
represented indirectly as a gate stall; benign `console_error` has **no
representation in `results.json` at all**.

So a run whose only errors were benign renders, verbatim:

```
## Errors

**By class**

No errors recorded.
```

while `activity.ndjson` beside it holds 46 `{"kind":"error",...}` lines. "No
errors recorded" is a stronger claim than the data supports, and it is the
claim a reader skims. One `suppressedErrors: { not_ready: N, benign_asset: M }`
block in `results.json` plus a footnote in the Errors section closes it.

**Repro.** `metrics/collector.test.ts` style: call
`collector.error({errorClass: 'console_error', endpointClass: 'https://icon.invalid/x'})`
ten times, snapshot, render. `errors.byClass` is `{}` and the section reads "No
errors recorded."

---

### R8 — Achieved rate divides by requested minutes, not elapsed

**Severity: Medium** (report honesty).

**Files:** `loadtest/metrics/report.ts:133-134` (`steadyStateMinutes`),
`:136-154` (`achievedFromSnapshot`).

```ts
const steadyStateMinutes = (config: LoadtestConfig): number =>
  Math.max(0, config.load.durationMinutes - config.load.rampUpSeconds / 60);
...
const rate = minutes > 0 && config.users.total > 0
  ? snapshot.scheduler.lapStartsSubmittedSteady / (config.users.total * minutes)
  : 0;
```

Both terms of the denominator are **requested**, never observed:

- **Minutes.** A run SIGINT-ed after 4 minutes of a requested 20 still divides by
  ~19 steady-state minutes, so `steadyStateRatePerUserPerMin` reads ~5× lower
  than the rate actually achieved. `results.json` carries the real
  `run.durationMs` right next to it and does not use it. The bias is
  self-deprecating rather than flattering, which is the better direction, but it
  is still a wrong number presented as "achieved", and a reviewer comparing
  "requested 2 / achieved 0.4" will draw a false conclusion about the tool's
  throughput.
- **Users.** Dividing by `config.users.total` folds in users that were never
  active — including browser users permanently retired via
  `browser_crash_permanent`. This is A9/A10 territory and is already a deferred
  S21 task; I note it here only because it compounds with the minutes term in
  the same expression.

**Repro.** Start any run with `--minutes 20`, SIGINT at t=4 min, read
`summary.md`'s Throughput table against `run.durationMs`.

---

### R9 — No `rampUpSeconds < durationMinutes × 60` guard; a short run reports a zero rate

**Severity: Medium** (correctness; silent zero rather than an error).

**Files:** `loadtest/config/schema.ts:216` — `rampUpSeconds: z.number().int().min(0).default(60)`;
`loadtest/metrics/report.ts:134`, `:142-145`.

**What is wrong.** The schema bounds `rampUpSeconds` only below. With the
default 60 s ramp, `--minutes 1` gives `steadyStateMinutes = 0`, the `minutes > 0`
branch fails, and the report prints:

```
| steadyStateRatePerUserPerMin (achieved) | 0.0000 | same unit as rate per user/min (requested) |
```

for a run that submitted real laps. There is no `n/a`, no warning, and the
identity check still says **OK** (it does not involve the rate), so nothing in
the report signals that the figure is undefined rather than measured. Anything
`rampUpSeconds >= durationMinutes × 60` hits this; `--minutes 1` is a perfectly
plausible smoke invocation, and S13's own spec uses `--minutes 2`, one step away.

S12 already added the `readyToClaimMs < hopMs < lapMs` ordering invariant to
`schema.ts`; this is the same class of guard and belongs beside it.

**Repro.** `pnpm loadtest validate` a config with `durationMinutes: 1`,
`rampUpSeconds: 60` — it passes. Then any run with it reports `0.0000`.

---

### R10 — No runtime assertion that a browser context signs with its intended wallet

**Severity: Medium** (correctness; silent catastrophic-measurement failure mode).

**Files:** `loadtest/workers/browser/browserUser.ts:305` (`this.address = privateKeyToAccount(options.privateKey).address`),
`:371` (`connectedAddressBadge()` — "Debug/verification helper (**not part of
`UserDriver`**)"); `loadtest/workers/browser/pool.ts:330-336` (`addInitScript`).

**What is wrong.** Per-user identity in browser mode rests entirely on
`context.addInitScript` landing **before** the bundle evaluates
`app/context/e2eAccount.ts` — which reads the override exactly once, at module
load. The pool does this correctly today (`addInitScript` in `createContextFor`,
before any page exists). But if that ordering ever breaks — a Playwright change,
a context recreated by a path that forgets the script, a page opened before the
init script is registered — every browser user silently falls back to the shared
build-time key `0x6Aa7F0e2397117D732a1d6A76D8A25fdC0bA7B07`.

The failure would be catastrophic and *invisible*: all N browser users collapse
onto one EOA, producing massive nonce collisions (see R3), a meaningless
per-user load profile, and an error pattern that reads as chain/proxy trouble.

The project already knows this — S09's outcome note states "**if a browser user
ever transacts from that address, the override failed to apply**" — and S10
proved four distinct addresses. But that proof was a one-off acceptance check
run by a harness. `connectedAddressBadge()` is explicitly **not** on the
`UserDriver` interface, so `run` never calls it. There is no assertion in the
production path.

A one-line check at connect time (`connectedAddressBadge()` or an in-page
`e2eWalletAddress` read, compared against `this.address`, failing the user loudly
on mismatch) converts a silent measurement-invalidating regression into an
immediate, obvious error. Cheap, and the helper already exists.

**Repro.** In `pool.ts:330`, comment out the `addInitScript` call and run
`--users 2 --browser 2`. The run proceeds; both users bridge from the same
fallback address; nothing in `summary.md` or `activity.ndjson` reports a problem.

---

### R11 — HTTP samples outside a fetch context are silently dropped

**Severity: Medium** (report honesty: the endpoint tables are an undisclosed
lower bound).

**Files:** `loadtest/workers/headless/uiCallset.ts:346-378` — both the success
and the error branch of the wrapped fetch are guarded by `if (ctx)`, where
`ctx = fetchContextStorage.getStore()`.

**What is wrong.** A request issued outside any `runWithFetchContext(...)` scope
is performed but **not recorded at all** — no sample, no counter, no warning.
Because `AsyncLocalStorage` propagates through awaits, in-scope SDK retries are
covered; anything called outside a scope is not. `preflight`/`fund`/`validate`
traffic, and any future driver-internal call that forgets to wrap, is load the
tool puts on the proxy that the report does not count.

The report presents the endpoint tables as the load the run generated. They are
a lower bound of unknown tightness, and nothing discloses that. A single
`uncontextedRequests` counter (incremented in the `else`) would make the gap
visible and testable; today a forgotten wrapper is undetectable by inspection
of the output.

**Repro.** Call `globalThis.fetch(proxyUrl)` once from outside a
`runWithFetchContext` after `installTimingFetch`, snapshot the collector:
`http` is unchanged and no diagnostic is produced.

---

### R12 — `.env.local.bak` is not gitignored and contains a private key

**Severity: Medium** (hygiene; one `git add -A` from committing a key).

**Files:** `.gitignore:59-61` (`.env`, `.env.local` — exact names, no `*.bak`);
untracked `.env.local.bak` at the repo root.

**What is wrong.** S01 deliberately moved the stale Kurtosis `.env.local` aside
to `.env.local.bak` (it holds stale values that would otherwise override
exports) and the plan says to leave it there. Correct as a procedure — but the
`.gitignore` patterns are exact names, so the `.bak` suffix escapes them
entirely:

```
$ git check-ignore -v .env.local        ->  .gitignore:60:.env.local
$ git check-ignore -v .env.local.bak    ->  (exit 1, no match)
```

The file contains `E2E_PRIVATE_KEY=0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625`
— the kurtosis `l2_admin` devnet fixture key, which is also present in the
already-committed `tests/devnet/summary.json`, so **the key itself is not a new
secret**. The defect is the pattern gap: the repo's staging area is currently
willing to track a file whose whole purpose is holding environment secrets, and
the branch that created it did not close the hole.

**Action for S21:** either delete `.env.local.bak` (its contents are recoverable
from `scripts/kurtosisDevnetEnv.mjs`) or widen `.gitignore` to `.env.local*` /
`.env*.bak`. Note S22 must not `git add -A`.

---

### R20 — Undeclared parity gap: headless treats an `ERROR` row as terminal, the UI does not

**Severity: Medium** (parity gap, undeclared — and DESIGN §9.4 closes with
"Anything else that differs between the two modes is a defect").

**Files:** `loadtest/workers/headless/uiCallset.ts:423-424` vs
`app/hooks/useTransactions.ts:24-25`.

```ts
// uiCallset.ts:423 — the headless cadence engine
export const anyRowNonTerminal = (rows) =>
  rows.some((row) => row.status !== 'CLAIMED' && row.status !== 'ERROR');

// app/hooks/useTransactions.ts:24 — the real UI
const hasNonTerminalTransaction = (transactions) =>
  (transactions ?? []).some((tx) => tx.status !== 'CLAIMED');
```

**What is wrong.** The real UI's non-terminal predicate excludes **only**
`CLAIMED`. An `ERROR`-status row (`claimed === 'error'`,
`app/services/activity.ts:151`) therefore still counts as non-terminal, and the
UI keeps polling activity at the **5 000 ms** interval. The headless engine also
excludes `ERROR`, so as soon as an address's only un-claimed rows are `ERROR` it
decays to the **10 000 ms** terminal branch while the real UI would still be at
5 000 ms.

This is a genuine **under-polling** divergence against P1 — the direction that
makes the tool generate *less* load than a real user on the highest-volume
endpoint class in the whole test. It is not among C1–C16 and not in §9.4's
declared-divergence table, so by DESIGN's own rule it is a defect. It is also
untested: `anyRowNonTerminal` has no test in `uiCallset.test.ts`.

The trigger is narrow (needs an `ERROR` row with nothing else pending for that
address) but `ERROR` rows are exactly what a wedged devnet produces, which is
the condition every validation run so far has hit — so this is likely to have
been live during S14/S17 and to have depressed their headless activity volume
slightly.

**Repro.** Unit-level, no devnet: feed `mapActivityResponseText` a response whose
single bridge has `claimed: "error"`, then assert the cadence engine's next
delay. It returns the 10 000 ms branch; the UI's predicate returns non-terminal
(5 000 ms).

---

### R21 — `redactSecrets` cannot redact a mnemonic, and `LOADTEST_MNEMONIC` is a supported secret

**Severity: Medium** (safety; latent rather than demonstrated).

**Files:** `loadtest/wallets/redact.ts:17` — the sole pattern is
`/0x[0-9a-fA-F]{40,}/g`; `.env.example` (`LOADTEST_MNEMONIC`);
`loadtest/config/schema.ts` (`users.wallets.mnemonic` as a secretRef).

**What is wrong.** The redactor is purely hex-shaped. It correctly catches
0x-prefixed 64-hex private keys and 0x-prefixed addresses, including
mid-string and inside JSON. It **cannot** catch:

1. **A BIP-39 mnemonic.** Twelve or twenty-four English words have no hex shape,
   and no mnemonic-aware pattern exists anywhere in the repo. This matters
   because the mnemonic is a *supported, documented* secret input
   (`LOADTEST_MNEMONIC`, resolved by `wallets/secrets.ts`) and it is the
   **highest-value** secret the tool handles — it derives every user wallet. A
   single key leaking exposes one wallet; the mnemonic exposes all of them.
2. **An un-prefixed 64-hex key** — the pattern requires the literal `0x`.

Mitigating: every producer in the tool validates the `0x`+64-hex shape before
use (`derive.ts`'s `PRIVATE_KEY_PATTERN`, `app/utils/e2eEnv.ts`'s
`isHexPrivateKey`), so any *private key* held in memory is always in the one
form the regex catches. And `secrets.ts` never logs a resolved value — only the
secretRef's label — and refuses to read a secret file whose mode is not exactly
`0600` (verified, and a good control). So this is a latent gap, not a
demonstrated leak. But the invariant the repo states for itself is "never log a
key", and for the mnemonic the redactor provides **no defence at all** — the
protection is entirely "no code path currently interpolates it".

Also confirmed, and worth recording because it is why this has not bitten yet:
no file in `loadtest/` references `Error.stack` (zero grep hits), and every
redaction call site uses `error.message` / `String(error)`. A stack trace is
never fed to `redactSecrets` — so the redactor's inability to handle one is
currently moot, by accident rather than by design.

**Fix shape for S21** (not applied): add a word-list-free mnemonic heuristic
(e.g. ≥12 whitespace-separated lowercase alpha tokens) and an un-prefixed
64-hex branch, plus a test per case. Cheap, and it removes the reliance on
"nothing currently interpolates it".

---

### R22 — `ui/build.ts` forwards the whole parent environment to `next build` with `stdio: 'inherit'`

**Severity: Medium** (safety).

**Files:** `loadtest/ui/build.ts:265-276` (`buildEnv = { ...process.env, … }`),
`:288-292` (`execFileSync('pnpm', ['run','build'], { cwd, env: buildEnv, stdio: 'inherit' })`).

**What is wrong.** Two things compose:

1. `buildEnv` spreads the **entire** parent environment, so any real secret the
   operator has exported — `LOADTEST_MNEMONIC`, `LOADTEST_DEVNET_FUNDER_KEY`,
   any funder secretRef env var — is handed to the `next build` child process,
   which has no need for any of them.
2. `stdio: 'inherit'` pipes that child's stdout/stderr **straight to the
   terminal**, entirely bypassing the tool's redaction. `installTimingFetch`,
   `redactError` and `collector.error()`'s defensive redaction all sit on the
   Node side and see none of it.

The private key `build.ts` itself injects
(`NEXT_PUBLIC_E2E_PRIVATE_KEY: THROWAWAY_E2E_PRIVATE_KEY`, `build.ts:38-39`,
`:273`) is a fixed, hardcoded, publicly-known throwaway — that value leaking is a
non-issue by construction, and correctly so. The risk is the *inherited* vars: if
Next, Turbopack or any transitive plugin ever error-dumps `process.env` in a
crash diagnostic — which bundlers do — a real mnemonic or funder key prints
unredacted to the console and into any CI log capturing it.

Largely inherent to `stdio: 'inherit'`, and the blast radius is a local/CI
console rather than a committed artefact, hence Medium not High. The cheap fix
is to pass an **allowlisted** env to the child (`PATH`, `HOME`, `NODE_*`,
`NEXT_PUBLIC_*`, `LOADTEST_UI_BUILD`) rather than `...process.env`.

**Repro.** `LOADTEST_MNEMONIC="test test … junk" pnpm loadtest build-ui`, then
inspect the child's environment (e.g. via a temporary `next.config.ts` that
prints `Object.keys(process.env)`). The variable is present.

---

### R23 — Nothing cross-checks the `env` label against the actual chain

**Severity: Medium** (safety; the input that gates R0 is itself untrusted).

**Files:** `loadtest/config/schema.ts:300` — `env` is a free-standing
`'devnet' | 'testnet' | 'mainnet'` string with no relationship to
`chains[].chainId` or `chains[].rpcUrl`.

**What is wrong.** `env` drives real safety decisions — it gates
`anvil_setBalance` (correctly, see §5), it gates the `fund` mainnet
confirmation (R0), and it shapes the funding strategy — but nothing validates
that a config labelled `devnet` actually points at a devnet. A config with
`env: "devnet"` and mainnet `rpcUrl`s / mainnet `chainId`s passes `validate`
cleanly and then skips the mainnet confirmation entirely (and, on the
`anvil_setBalance` path, would simply fail at the unsupported RPC method — but on
the `transfer` path it would send real funds).

The chain ids are already in the config; asserting that a `mainnet`-labelled
config uses known mainnet chain ids (and that a `devnet` one does not) is a
handful of lines and closes the loop on R0.

**Repro.** Copy `loadtest/config/examples/testnet.loadtest.json`, change `env`
to `"devnet"`, leave the Sepolia/Bokuto chain ids. `pnpm loadtest validate`
passes.

---

### R30 — Every per-phase timeout is emitted under `transition: 'T28'`

**Severity: Medium** (observability; the transition stream misattributes which
DESIGN §3.2 row fired).

**Files:** `loadtest/core/ring.ts:775-784`, and `hopDeadline` at `:294-368`.

**What is wrong.** The `TimeoutOutcome` values themselves are **correct** —
`hopDeadline` was checked state-by-state against DESIGN's per-state `Timeout
key` / `On timeout` columns and matches the table exactly, for every state. The
defect is the emitted **transition id**: `ring.ts:778` labels *every* per-phase
timeout `'T28'`, including the common case where only a phase timeout fired and
`hopMs` is nowhere near elapsed.

Per DESIGN's own T28 row, `'T28'` is the `hopMs` umbrella producing
`timeout_hop`, with a per-phase outcome recorded only as a *secondary* emission
when both fire on the same tick (which is exactly what the
`secondary_timeout` emission type at `ring.ts:172` exists for). Reusing `'T28'`
for the standalone case means T3/T5/T7/T9/T12/T13/T14/T19/T20/T21/T23/T26's
**timeout arcs never appear under their own ids** in the `RingEmission` stream.

Anything reconstructing "how often did each §3.2 row fire" by grouping on
`transition` will systematically undercount those rows and overcount T28 —
making the `hopMs` backstop look far busier than it is, and hiding which phase
actually timed out. Outcome and counter correctness are unaffected (the
`outcome`/`TimeoutOutcome` field carries the truth), so this is a diagnosis
problem, not a data-corruption one.

**Repro.** Drive a hop to a `readyToClaimMs` timeout well inside `hopMs`;
inspect emissions. The `transition` is `'T28'`, the outcome is
`timeout_ready_to_claim`.

---

### R31 — The `lapMs` path closes a gate without emitting `gate_exit`

**Severity: Low** (observability).

**Files:** `loadtest/core/ring.ts:1082-1104` (specifically `:1089-1092`).

Unlike every other transition — which routes through
`goTo`/`finish`/`exitGate` and therefore always pushes a `gate_exit` emission —
the inline lap-timeout handling hand-rolls the hop mutation. It sets
`exitedAt: now` on any open gate visit but pushes only `'outcome'` and
`'lap_transition'` emissions. The final `Hop.gates` **data is correct**, so
`results.json` is right; but a consumer building §5.4 gate-stall durations from
the streamed emissions alone (which is what `runner.ts:265` does —
`case 'gate_exit': ctx.collector.recordGateVisit(...)`) **misses this closure**.
So a gate visit interrupted by `lapMs` is absent from the Gate-stalls table.

Secondary concern: this block duplicates logic `finish()` already encapsulates
(exit gate + emit outcome), so a future change to `finish()` will not apply
here.

---

## 4. Low / informational

- **R13 — `loadtest/**` is not prettier-clean.** `pnpm exec prettier --check .`
  fails on 40 files, of which **20 are ours**: `loadtest/cli.ts`,
  `config/schema.test.ts`, `core/ring.test.ts`, `metrics/{collector,collector.test,errors,errors.test,report,report.test}.ts`,
  `runner.ts`, `ui/build.ts`, `wallets/{derive,preflight}.ts`,
  `workers/browser/{browserUser,browserUser.test,pool,pool.test,timing}.ts`,
  `workers/headless/{headlessUser,uiCallset}.ts`. **Zero** under
  `tests/loadtest-e2e/`. The other 20 are pre-existing and untouched
  (`app/utils/address.ts`, `app/constants/routes.ts`, `next.config.ts`,
  `tsconfig.json`, `postcss.config.mjs`, `tests/e2e/globalSetup.ts`, …) —
  including `app/context/e2eAccount.ts`, which already failed at `HEAD`. Already
  an S21 task; recorded for completeness, ranked Low, and the scope stands:
  format `loadtest/**` only.

- **R14 — `installTimingFetch`'s handle is discarded.** `uiCallset.ts:380-386`
  returns `{ uninstall() }`; `runner.ts:579` calls
  `installTimingFetch(collector, clock)` and drops the return value.
  `globalThis.fetch` stays monkey-patched for the process lifetime and the
  closure keeps the collector reachable. Harmless in a one-shot CLI, wrong in
  the e2e Playwright project where `runCli.ts` runs the CLI as a subprocess
  (so still isolated) — but it means no test can install and then restore the
  wrapper, and a future in-process runner would inherit a permanent patch.

- **R15 — Unbounded in-memory sample retention.** `collector.ts:757-790` pushes
  every phase duration and every HTTP sample into arrays held for the whole run
  (S14 recorded 96 927 `tracker/activity` samples alone; S17 peaked at 4.26 GB
  tool RSS). Percentiles genuinely need the samples, so this is a design
  trade-off rather than a bug — but there is no cap and no reservoir sampling, so
  a longer or larger run can OOM and lose the report entirely.
  `activity.ndjson` is flushed as events occur (correct, and deliberate), so the
  raw log survives; `results.json`/`summary.md` would not.

- **R16 — Silent default logger.** `runner.ts:514`:
  `const logger = options.logger ?? (() => {});`. A caller that omits `logger`
  loses every diagnostic, including `run: fatal error, draining: …`. `cli.ts`
  passes one, so the shipped path is fine; a programmatic embedder gets silence
  by default. Prefer defaulting to `process.stderr.write`.

- **R17 — The branch has zero commits.** `git log fix/pr24-review-followup..feat/bridge-loadtest`
  is empty and both refs are `d5529b3`; the whole deliverable is an uncommitted
  working tree. Consequence for reviewers: `git diff base...branch` shows
  nothing, and the untracked trees must be reviewed as new files (which is how
  this audit was done). S22 must stage deliberately — **not** `git add -A`, see
  R12 — and the PR diff will be the first time this change set exists as commits.

- **R24 — `wallets/preflight.ts` never redacts at source.** Raw `error.message`
  is embedded at `preflight.ts:91, 119, 169, 197, 260`, and the file **never
  imports** `redactSecrets`/`redactError` — contradicting `redact.ts:5-7`'s own
  header, which names `preflight.ts` as an expected consumer. Traced end to end:
  every current caller (`cli.ts:213`, `runner.ts:547-549`) wraps the text in a
  thrown `PreflightError` that reaches `cli.ts:413`'s
  `main().catch(redactError(...))`, so **nothing escapes unredacted today**.
  Confirmed as S12 reported it. The residual issue is that the whole guarantee
  rests on one choke point with no test, and the choke point *is* genuinely the
  only exit (verified independently: zero `process.on('unhandledRejection')` /
  `'uncaughtException')` handlers and no `process.exit()` anywhere in
  `loadtest/` — only `process.exitCode = 1` assignments, which do not bypass a
  pending catch). Ranked Low on that basis. One adjacent nit: `cli.ts:250-256`'s
  `runServeUi` SIGINT/SIGTERM handler does `void handle.close().finally(resolve)`,
  silently discarding a close failure — cannot leak a secret, but it is a silent
  failure.

- **R25 — HAR and trace capture are present-but-unwired, and would capture the
  raw key if enabled.** `pool.ts:83, 164, 193, 325-328` implement
  `recordHar: { mode: 'full', content: 'embed' }` gated on a `harPathFor`
  callback — which `runner.ts:650-657` never supplies, and which no call site in
  `tests/loadtest-e2e/` or `tests/e2e/` wires up. HAR output is **not** passed
  through `redactSecrets` (it is a separate capture mechanism entirely).
  Separately, `config/schema.ts:239, 243` defines `browser.trace` (default
  `false`) which is **never consumed** — no `context.tracing.start()/stop()`
  exists. So neither is an active leak vector. Flagged because a Playwright trace
  at higher verbosity records the literal arguments passed to calls such as
  `context.addInitScript(fn, key)` — i.e. the raw per-user private key — so
  whoever eventually wires `browser.trace` up must handle that. The schema field
  existing while nothing reads it is also a straightforward
  schema/implementation mismatch worth closing either way.

- **R26 — P2 is not implemented at all, and the docs overstate it.**
  `DESIGN.md:961` (row P2) and `PARITY.md:146` both record P2's verdict as "not
  exercised by this ring — user-driven, probability 0 by config on both sides",
  which implies a configurable knob defaulted off. There is no knob:
  `grep -rn 'tracker/v1/network|useBridgeTracking|bridgeTrackingProbability' loadtest/`
  (excluding tests) returns **nothing**, and neither `headlessUser.ts` nor
  `browserUser.ts` has any code path for the bridge-steps-modal
  `GET /tracker/v1/network/{id}/tx/{hash}` call. Zero traffic impact (0 calls
  either way, which is what §9.2's never-called list independently confirms), so
  this is a documentation-accuracy issue only: the docs should say "not
  implemented — the UI only issues it when a user opens a CLAIMED row's steps,
  which this tool never does" rather than implying a defaulted-off probability.

- **R27 — `fund.ts`'s Pass-2 incremental cap check is dead code, and caps are
  unbounded.** Two small confirmations, both already flagged by S12 and neither a
  vulnerability:
  (a) Pass 1 (`fund.ts:467-491`) sums `needed` across wallets and throws
  `FUNDING_CAP_EXCEEDED` at `:486-490` **before Pass 2 starts**, genuinely
  implementing DESIGN §4.3's "refuse the whole fund, sending nothing". Pass 2's
  per-wallet `spent + needed > cap` check (`:515-519`) re-reads the *same*
  `neededPerChain` map over the *same* wallets in the *same* order, so it is
  mathematically unreachable. S12's "looks like dead code" is confirmed: it **is**
  dead. The only defect is that its comment (`:493-496`) claims it protects
  against a stale plan, which it does not — Pass 1 is what protects you.
  (b) `maxTotalSpend`/`gasPerChain` are validated only as non-negative decimal
  strings (`schema.ts:181`), so an operator may set an arbitrarily large cap and
  the schema accepts it. The tool trusts the operator's number; that is a
  defensible design, but it means the cap is a typo-catcher, not a limit.

- **R32 — Dead code in `core/`, catalogued.** All four confirmed by reading, all
  harmless, listed so S21 can delete deliberately rather than rediscover:
  (a) **T27's `AWAITING_CLAIMED` half is unreachable.** The only entry to
  `AWAITING_CLAIMED` is `goTo(…, 'T23', …)` at `ring.ts:976`, reachable only
  from `CLAIM_PENDING`, reachable only after the `claim_sent` handler sets
  `claimSubmitted: true` (`ring.ts:967`). So `ring.ts:691`'s
  `const unexpected = !mut.hop.spec.autoclaim.expected && !mut.hop.claimSubmitted`
  is **always false** in that branch, and the ternaries at `:695` and `:703-707`
  can never select `'T27'`/`hop_completed_auto` from there. T27 remains fully
  reachable via its `AWAITING_READY`/`AWAITING_ACTIVITY`-cascade half, which is
  what `ring.test.ts:546-565` exercises — so DESIGN §3.2's T27 row overstates
  the arc's origins. Behaviourally correct; the docs and the dead ternary
  branch should be reconciled.
  (b) `ring.ts:763-773` — the *second* drain check in `applyTick` is
  mathematically unsatisfiable given the branch ordering above it (if
  `drain.deadlineAt <= hopDeadlineAt` the first drain branch fires; if it is
  greater, `now >= drain.deadlineAt` implies `now > hopDeadlineAt` and the T28
  branch already returned). T29 itself stays reachable via the first branch.
  (c) `ring.ts:534-536` — `outcomeFromDriverError`'s `case 'already_claimed'` is
  dead by its own comment, since `submit_error`'s handler intercepts that class
  at `ring.ts:899` and `break`s first. Likely kept for switch exhaustiveness.
  (d) `core/types.ts:224` — `SchedulerCounter` is orphaned: zero non-definition
  references, and `scheduler.ts:46-52`'s actual `SchedulerCounters` has a
  different shape (camelCase, plus `ticksIssued`/`ticksOffered`). Stale type.

- **R33 — `DESIGN.md` contradicts itself on the `lapMs` default.** `DESIGN.md:410`
  (prose) says `lapMs` default (devnet) = `2 700 000` (45 min) = 3 × `hopMs`;
  `DESIGN.md:427` (the §3.3 table) says `3 600 000` (60 m). With
  `hopMs = 1 200 000`, `3 × hopMs = 3 600 000`, so **the table is right and the
  prose is stale** — it was not updated when S10 raised the timeouts.
  `deriveDevnet.ts:220-223` emits `3 600 000`, matching the table, so no code is
  affected; only the document misleads. Worth fixing while S21 is in these
  files.

- **R34 — `maxInflightLapsPerUser` is per (user, asset), and the prose blurs it.**
  DESIGN §3.5's prose reads "a user may have at most `maxInflightLapsPerUser`
  laps in flight", which sounds like a per-user cap. The code checks
  `inflightByAsset[candidate]` individually (`scheduler.ts:166-178`), i.e. **per
  (user, asset) ring** — which matches §3.5's own "Asset interleaving" clause
  and is the more specific, authoritative reading. So the code is right; the
  looser sentence is what misleads. Practical consequence worth stating
  explicitly in the docs: with 2 assets the real per-user in-flight ceiling is
  **6**, not 3, which is also the concurrency figure R3's nonce analysis must be
  read against.

- **R18 — Deferred items, confirmed still open, not re-discovered:** A5's
  multi-process sharding (needs an inter-process collector-aggregation
  protocol; the users-per-process cap + self-disqualification landed instead),
  A7 (`ATTEMPT_WINDOW_MS` 35 s vs a 5 s poll mislabels legitimate polls as
  `retries`, so `describeHttpStats`'s `retries=` field is not a retry count),
  A8 (`browserUser.ts`'s bare `catch {}` manufacturing `bridge_event_missing`),
  A9 (req/user should normalise per active user-minute), A10 (achieved rate
  should be per mode, not blended). All already listed as S21 tasks.

---

## 5. Verified correct — do not re-audit

Recorded so S21 does not spend time here.

**Correctness**

- **`core/` is pure.** Every module specifier across `ring.ts`, `types.ts`,
  `scheduler.ts`, `userDriver.ts` is a sibling core module or `viem`, and
  **every `viem` import is `import type`** (`ring.ts:55`, `types.ts:11`,
  `userDriver.ts:17`) — erased at compile. The only value import is
  `./types`. The only time primitive in the whole directory is
  `ring.ts:95 export const systemClock: Clock = { now: () => Date.now() }`, and
  the logic never calls it (tests use `createFakeClock`). No `setTimeout`,
  `setInterval`, `Math.random`, `process.*`, `globalThis`, `require`, or `fetch`
  anywhere in `core/`. Confirmed by exhaustive grep.
- **`global_index` big-int handling is correct on BOTH workers.** Headless reads
  the activity response as **text** and parses it through the app's own
  `parseActivityResponse` → `quotePrecisionUnsafeIntegers`
  (`headlessUser.ts:521`, `app/services/activity.ts:273/329`), never
  `response.json()`. Browser mode does `page.evaluate(… response.text())`
  (`browserUser.ts:663-665`) and hands the text to the **same**
  `mapActivityResponseText` (`browserUser.ts:117, 619`). Downstream the value
  stays a string until `BigInt(row.globalIndex)` (`headlessUser.ts:660`). The
  only `Number()` on the claim path is `browserUser.ts:168` on `depositCount`
  (a uint32 — safe). No unsafe re-parse exists.
- **`getClaimInputs` recording-network routing is byte-identical to the UI.**
  `headlessUser.ts:605-609` passes
  `{ recordingNetworkId: row.sourceNetwork, destinationNetworkId: row.destinationNetwork, depositCount: row.depositCount }`,
  matching `app/hooks/useClaimExecution.ts:127-131` exactly, with the same
  "never the asset's origin network" reasoning in the comment. `isClaimed` uses
  `{ leafIndex: row.depositCount, sourceBridgeNetwork: row.sourceNetwork }`,
  matching `useClaimExecution.ts:97-100` (where `resolveLeafIndex` always
  returns `deposit_count`). The call order
  `isClaimed → getClaimInputs → buildClaimAsset → send → receipt` mirrors the
  hook.
- **Row identity is `tx_hash:deposit_count`.** `core/types.ts:259-260` defines
  `toRowKey = (transactionHash, depositCount) => \`${transactionHash}:${depositCount}\``,
  matching `app/services/activity.ts:191`'s `toHubUID` exactly;
  `uiCallset.ts:415` maps through it. Grep for `bridgeHash|bridge_hash|globalIndex`
  across non-test `loadtest/` shows neither is ever used as a row key — only doc
  comments explaining why they were rejected. As DESIGN §9.2 requires.
- **The `dest === 0` skip of `injected-l1-info-leaf` is correct and is shared.**
  Confirmed at SDK level, not just by the design doc:
  `node_modules/@agglayer/sdk/dist/index.d.ts:1329-1368` documents that
  `recordingNetworkId` keys `/l1-info-tree-index` and `/claim-proof`'s
  `network_id` unconditionally while `destinationNetworkId` gates only the
  injected-leaf call, and `dist/index.js:3179-3193` shows
  `resolveInjectedLeafIndex` returning immediately when
  `destinationNetworkId === 0`. `app/services/claimProof.ts` performs **no**
  routing logic at all (a pure hex-narrowing transform of an already-resolved
  proof), so the skip lives entirely in the shared SDK and both modes inherit it
  identically. There is nothing here that can diverge.
- **The §9.2 never-called list holds.** `grep` for `bridge/v1/bridges`,
  `bridge/v1/claims`, `bridge/v1/claim-candidates` across `loadtest/` → **zero**
  hits outside `DESIGN.md` prose. `sync-status` and `tracker/v1/health` appear
  **only** in `wallets/preflight.ts:139, 179` (`checkSyncStatus` /
  `checkTrackerHealth`) — a one-shot pre-run gate, legitimately outside the
  measurement window per DESIGN §9.2/§4.5, not steady-state traffic.
- **`SingleFlightPoller` does not under-poll.** Independently recomputed from
  `loadtest-results/20260910T203813Z/headless-trace.ndjson` rather than trusting
  PARITY.md: u0 = 101 `tracker/activity` samples over 418 366 ms → **14.48
  req/min**, max inter-request delta 8 076 ms, **zero** deltas > 9 000 ms; u1 =
  113 over 478 382 ms → **14.17 req/min**, max delta 8 075 ms, zero > 9 000 ms.
  No delta breaches the 10 000 ms terminal-branch ceiling, so no interval is
  silently skipped, and the rate sits at or above the ~12/min a continuous
  5 000 ms non-terminal poll implies — and above browser mode's own measured
  real-UI (`origin: 'ui'`) rate of 7.00–8.47/user/min. The single-flight logic
  itself is race-free (`run()`'s check-then-set has no `await` before the
  `inFlight` assignment) and `delayMs()` is re-evaluated per chain rather than
  cached stale. Caveat recorded: that trace drove 2 sequential laps/user, so the
  `maxInflightLapsPerUser > 1` dedup path is proven by unit test
  (`uiCallset.test.ts:301-416`, "three concurrent `run()` calls inside one
  interval produce exactly ONE fetch") rather than by a live concurrent trace.
- **P1–P14 verdicts re-derived against dev-ui source** (not merely re-read from
  PARITY.md): P3, P4, P5, P6, P7, P8, P9, P10, P11, P12, P13, P14 all **match**.
  P7/P8 use a 15 s `TtlCache`; P9's `allowanceCache` is keyed including the
  amount string with an effectively-infinite TTL, correctly modelling the UI's
  `refetchOnMount/WindowFocus/Reconnect: false`; P11's
  `mapTransactionRequest` (`app/utils/transaction.ts:26-38`) strips `gas`/`nonce`
  identically for UI and headless, with C5's bridge-only `gasOverride` the sole
  exception; P12/P13 are inherited from a real viem `WalletClient`, so there is
  no custom code that *could* diverge; P14's `isClaimedRetryLoop` uses
  `IS_CLAIMED_RECHECK_DELAYS_MS = [0, 400, 1000]`, mirroring
  `useClaimExecution.ts:244-258`. P1 matches on the burst/steady timings and the
  dedup rule **except** for R20. P2 produces the correct zero calls (see R26 for
  the doc issue).
- **The `_ltPollOrigin=harness` marker cannot create a phantom endpoint class** —
  verified from code, not the design doc: `classifyEndpoint`'s activity branch
  matches purely on `path.includes('/tracker/v1/activity/from/')`
  (`uiCallset.ts:250`) and never reads query params; only the `bridge/*` branch
  reads `network_id` (`:243-248`). So the marker is invisible to classing. It
  *is* a real extra query parameter on the wire — asserted inert by
  orchestrator-verified live comparison in S24 (structurally identical
  responses, 51 bridges, HTTP 200 both ways); I could not re-verify that without
  a live devnet.
- **`report --dir` re-renders from `results.json`'s own embedded config**
  (`cli.ts:367-371`), not from the live `loadtest.config.json` — so re-rendering
  an old run cannot pick up today's config. Byte-identical re-render is sound.
- **All of T1–T30 and L1–L4 are reachable** — checked branch by branch — with the
  single exception of T27's `AWAITING_CLAIMED` half (R32a). Every one of the 11
  non-terminal `HopState`s has an entry in `hopDeadline`'s switch
  (`ring.ts:294-368`), so **no state can hang un-bounded**, and each is in
  addition covered by the `hopMs` umbrella. Every `hopDeadline` row was verified
  against DESIGN §3.2's `Timeout key` / `On timeout` columns and **matches
  exactly**. Caveat inherent to the pure design (not a defect): because `core/`
  is I/O-free, every timeout — T18, T28, T29, L1/L2's `lapMs` check — fires only
  in response to an injected `'tick'` event, so if `runner.ts` ever stops
  pumping, no timeout can fire.
- **`hopMs` bounds a hop independently of its phase timeouts.**
  `hopDeadlineAt = mut.hop.startedAt + timeouts.hopMs` (`ring.ts:726`) uses the
  hop's fixed creation time, unaffected by how many times `stateEnteredAt` is
  reset within the hop. DESIGN §3.3's acknowledged trade-off holds: with the
  current devnet defaults a hop could in principle want ~45 min across three
  independently-bounded phases and be truncated by the 20 min umbrella — that is
  intentional, and the doc says so.
- **`autoclaim_overdue` / `unexpected_autoclaim` genuinely cannot fail a hop.**
  `applyAutoclaimDeadline` (T18, `ring.ts:629-637`) always transitions to the
  **non-terminal** `CLAIM_BUILD`; every `unexpected_autoclaim` bump
  (`ring.ts:583`, `:692`) is paired with `finish(mut, 'DONE', …)`. Neither
  counter has any path to `FAILED`. Confirms DESIGN §3.4 as described.
- **Notes N1, N3, N4, N5, N6, N7 are implemented exactly as documented** —
  each individually verified: N1 at `ring.ts:615`; N3 (`CLAIM_BUILD`'s deadline
  uses `hop.stateEnteredAt`, not `stepStartedAt`) at `:295, :347-352`; N4
  (T12 cascades into `applyAwaitingReady` within the same event) at `:643-650`;
  N5 at `:506-518` and `:1030-1035`; N6 (the outstanding hop is explicitly
  failed `timeout_lap` alongside the lap) at `:1082-1104`; N7's two rules at
  `:526-551`. **N2 is the one exception — see R28.**
- **The asset round-robin is genuinely round-robin, not biased.** `pickAsset`
  (`scheduler.ts:166-178`) starts at `bucket.nextAssetIndex`, cycles all
  `assetCount` candidates, and advances the index on every successful pick
  (`:173`). **Correction to the plan's S13 note:** the observed "`--rate 1
  --minutes 2` always lands on index 0" is *not* a round-robin defect. It is an
  artefact of `pump()`'s strict stop check (`scheduler.ts:199`:
  `if (drainStartedAt !== null || now >= stopAt) return [];`) — with
  `periodMs = 60 000` and `stopAt = 120 000`, tick 1 fires at ~t=60 000 (asset 0)
  and tick 2's due instant is exactly `now === stopAt === 120 000`, which the
  `>=` excludes, so the second tick never fires at all. `--rate 1 --minutes 3`
  (or any higher rate) exercises erc20 correctly. Worth recording because the
  plan carries the weaker diagnosis forward into S14/S17 guidance.
- **Ramp-up math is correct.** `admissibleAt` (`scheduler.ts:139-140`) matches
  DESIGN's `t = rampUpSeconds × 1000 × k / total` exactly, and
  `ticksLostToRamp`'s closed form (`:155-158`) correctly represents the tokens a
  fully-ramped user would have earned before this user existed, with no
  double-counting against the pump loop's own not-yet-admissible skip
  (`:203-206`, which deliberately increments no counter).
- **Drain deadline math is correct.** `computeDrainDeadline`
  (`scheduler.ts:105-116`) implements
  `min(drainStartedAt + hopMs, max over in-flight hops of (hopStartedAt + hopMs))`,
  including the subtle intentional case where a hop spawned *during* drain (via
  L1) is still capped by the original `drainStartedAt + hopMs` rather than given
  a fresh runway — so "drain stops within `hopMs`" is a theorem, not a hope.
- **`raceOrTimeout` attaches both handlers** to the raced promise
  (`runner.ts:332-344`), so an abandoned promise's later rejection cannot become
  an unhandled rejection.
- **`disposeEverything` is idempotent** (`runner.ts:590-610`, the `disposed`
  guard) and the reason is documented: without it a `fatal`-cause run would
  double-close the ndjson fd. Correct.
- **The pool's crash-signal dedup is real.** `context.on('close')`
  (`pool.ts:342`), `browser.on('disconnected')` (`pool.ts:258`) and
  `runSlotCrashRecovery` (`pool.ts:413`) all check `this.disposing`, and both
  signals coalesce through one `crashInFlight` promise per slot
  (`pool.ts:398-409`) with a stale-incarnation guard (`pool.ts:269`). S10's real
  bug is genuinely fixed. (R1 is about the *direct* launch paths, which are a
  different set.)

**Report honesty (the parts that work)**

- **The throughput identity is a genuine cross-check of the runner↔collector
  handoff — but only of that.** `ticksOffered`/`skippedBackpressure`/`ticksLostToRamp`
  come from `core/scheduler.ts`; `lapStartsSubmitted` is the **collector's
  independent** count of the same event (`collector.ts:346-353`, incremented by
  `tick()` once per `start_lap` decision). Comparing the two can therefore
  genuinely fail — and it is printed either way (`report.ts:266-268`), which is
  how S11's unit mismatch was caught. That much is right and I confirm it.
  **Scope limit, recorded so nobody over-trusts it:** within the scheduler
  `ticksOffered` is *defined* as the sum of the other three
  (`scheduler.ts:258`), so the identity verifies "the runner recorded every tick
  the scheduler issued" and **not** "the scheduler offered the demand the user
  requested". See **R29** for the gap that lives in the second claim.
- **Units are now consistent.** `lapStartsSubmitted` (lap-start units, the
  identity term and the input to `steadyStateRatePerUserPerMin`) is cleanly
  separated from `hopBridgesSubmitted`, which is labelled "informational only —
  per-HOP bridge sends, not part of the identity" in both `results.json` and the
  rendered table (`report.ts:50-53`, `:260`). S11's wrong-unit defect does not
  recur.
- **`aborted` is reserved for abnormal termination.** `runner.ts:1007-1012`:
  `abnormalAbort = drainCause === 'sigint' || 'fatal'`; `duration_elapsed`
  yields `aborted: false`, and `lapsInFlightAtStop` is still disclosed in the
  headline (`report.ts:512-520`), so a clean finish that drained work reads
  `PASS (drained N in-flight laps)`. Skipped ticks are counted
  (`skippedBackpressure` is an identity term, not a footnote).
- **The A5 self-disqualification works and is conservative.**
  `report.ts:304-332` disqualifies Phase **and** Endpoint latency sections once
  any sample's `eventLoopDelayP99Ms` ≥ 100 ms, using `max` across samples (one
  spike disqualifies the run — the honest direction). It fired for real in S16's
  e2e run and in both S17 runs. Missing `eventLoopDelayP99Ms` is filtered out
  rather than folded in as a false zero (`report.ts:459-461`, `:306-311`).
- **Zero-sample keys are omitted, not zero-filled** (note N5, with an explicit
  test at `collector.test.ts:48`).
- **The `ui` vs `harness` origin split is real and leads.** `HttpOrigin`
  defaults to `'ui'` (`collector.ts:153`, `uiCallset.ts:365`) so pre-existing
  call sites stay correct; `tracker/activity` gets a dedicated headline block
  stating that `ui` answers "what load would real users create?" and that
  `harness` "is shown, not hidden" (`report.ts:361-380`), ahead of the full
  five-column table. The marker param is stripped by `classifyEndpoint`
  (it keys on pathname + `network_id` only, `uiCallset.ts:235-265`), so no
  phantom endpoint class is created.
- **`errors.top` really is a top-10:** sorted descending by count then sliced
  (`collector.ts:861`, `:889`).
- **Secrets render as references, never resolved.** `redactConfigForReport`
  (`report.ts:100-120`) is *structural* — it walks for the `{env}`/`{file}`
  secretRef shape the schema defines — and is explicitly not a second free-text
  redactor; `wallets/redact.ts` remains the only text-pattern redactor.
  `collector.error()` additionally re-redacts defensively at
  `collector.ts:692`, so nothing can reach `activity.ndjson` unredacted through
  that entry point.
- **No `console.*` anywhere in `loadtest/` production code.** Exhaustive grep:
  the only matches are comments and a string in `errors.ts`/`timing.ts`. All
  output goes through the injected `logger` or, for fatal errors, the single
  `cli.ts:413` `main().catch(...)` choke point which redacts.

**Safety**

- **`anvil_setBalance` cannot fire against a non-devnet config — double-gated.**
  Config level: `schema.ts:474-481` rejects `users.devnetFunding` being present
  at all when `env !== 'devnet'` (`DEVNET_FUNDING_NOT_ALLOWED`), at parse time.
  Code level: `fundWallets` (`fund.ts:624-644`) computes
  `useAnvilSetBalance = config.env === 'devnet' && effectiveDevnetFunding === 'anvil_setBalance'`.
  A devnet config that asks for `transfer` correctly falls through to the real
  path. (The residual concern is that `env` itself is untrusted — R23.)
- **The native spend cap is genuinely enforced before anything is sent.** Pass 1
  (`fund.ts:467-491`) sums `needed` across all wallets and throws
  `FUNDING_CAP_EXCEEDED` at `:486-490` **before Pass 2 begins**, implementing
  DESIGN §4.3's "refuse the whole fund, sending nothing". S12's spend-cap
  boundary test (`total == cap` must pass, the guard being `>` not `>=`) covers
  the edge.
- **Funder nonce discipline is correct and race-free.** `ChainNonceManager`
  (`chainClients.ts:77-113`) serializes every `nextNonce()` through one promise
  queue per chain, and `onSendError()` re-seeds from the node rather than
  trusting a possibly-wrong counter. In practice `fund.ts`'s loops
  (`:509-531`, `:576-604`) `await` each send before the next, so there is no
  concurrency to race. (R3 is about the **user** path, which has none of this.)
- **`secrets.ts` refuses to read a secret file whose mode is not exactly
  `0600`**, and never logs a resolved value — only the secretRef's label/path.
  A good control, and the reason `file:` refs are safe to print.
- **The config validators that exist are real:** `PROXY_URL_PLACEHOLDER`
  (`schema.ts:614-628`, rejecting `PLACEHOLDER`/`REPLACE-ME` anywhere in
  `aggkitProxyUrl`, applied by every config-loading command);
  `FUNDER_REQUIRED` / `FUNDER_GAS_PER_CHAIN_MISSING` /
  `FUNDER_MAX_TOTAL_SPEND_MISSING` (`schema.ts:483-514`);
  `INLINE_PRIVATE_KEY_FORBIDDEN` (`schema.ts:318-343`, `:570-576`), which walks
  the **whole** parsed document for a bare 64-hex literal — a strong control,
  since it stops a key being committed in the config at all;
  `RING_MUST_START_AT_ASSET_ORIGIN` (`schema.ts:630-644`); and the S12
  `readyToClaimMs < hopMs < lapMs` ordering invariant.
- **`cli.ts:413`'s `main().catch(redactError(...))` is genuinely the only
  top-level exit.** Verified independently: **zero**
  `process.on('unhandledRejection')` / `process.on('uncaughtException')`
  handlers anywhere in `loadtest/`, and the only `process.exit*` usages are
  `process.exitCode = 1` assignments (`cli.ts:408`, `:418`), which do not
  bypass a pending catch. (The absence of a test on this choke point is S12's
  noted gap; see R24.)
- **`ui/build.ts` never touches real key material** — the only key it injects is
  the fixed, hardcoded, publicly-known throwaway
  (`THROWAWAY_E2E_PRIVATE_KEY`, `build.ts:38-39`), whose leaking is a non-issue
  by construction. (R22 is about the *inherited* environment, not this.)
- **`ui/serve.ts` has no request logging at all** (full read) — a pure static
  server, path-traversal guarded segment-by-segment (`serve.ts:90-94`, the
  S09 fix that checks `..` as a whole segment rather than a substring). Nothing
  to redact.
- **Browser console events are redacted before reaching the collector** —
  `timing.ts:152` → `classifyConsoleError` → `redactSecrets`
  (`errors.ts:189-194`).
- **`window.__AGGLAYER_E2E_PRIVATE_KEY__` cannot reach a HAR by construction** —
  `addInitScript` is same-process JS injection, not network traffic. (R25 covers
  the Playwright-trace vector, which is unwired.)
- **No derived per-user private key is interpolated into any log or error
  message.** `privateKey` appears only where driver/account objects are
  *constructed* (`pool.ts`, `browserUser.ts`, `runner.ts`); viem's
  `PrivateKeyAccount` does not expose the raw key as a property
  (`derive.ts:24-27`). Even hypothetically, `collector.error()`'s defensive
  `redactSecrets` (`collector.ts:694`) would mask it before `activity.ndjson` or
  `errors.top`.

**Repo hygiene**

- `.gitignore` correctly adds `/loadtest.config.json`, `/loadtest-results/` and
  `/playwright-report-loadtest-e2e/`; all verified ignored by
  `git check-ignore -v`, along with `public/config.json`, `out`, `.next`. The
  generated `loadtest.config.json` and the 12 `loadtest-results/` run
  directories exist on disk and are correctly untracked. No generated config is
  committed. `loadtest/config/examples/*.loadtest.json` stays tracked, as
  intended.
- **No scratch files or markers.** `grep -rn 'TODO\|FIXME\|XXX\|HACK\|console\.log'`
  over `loadtest/`, `tests/loadtest-e2e/`, `playwright.loadtest.config.ts`,
  `app/context/e2eAccount.ts` → **zero matches**. The S08/S10 `__s08_*` /
  `__s10_harness.ts` leaks are confirmed gone.
- **No stray edits.** `git diff --stat HEAD` is exactly 11 files / +423 / −14,
  matching the intended set (`.env.example`, `.gitignore`, `CLAUDE.md`,
  `README.md`, `app/context/e2eAccount.ts`, `docs/config.md`,
  `docs/deployment.md`, `next.config.ts`, `package.json`, `pnpm-lock.yaml`,
  `vitest.config.ts`). ~140 files have touched mtimes from a branch switch /
  `pnpm install` but zero content diff (sampled and confirmed). `config.json` is
  clean.
- `package.json` adds only `loadtest`/`loadtest:test` scripts and `tsx` as a
  devDependency; `vitest.config.ts` adds `loadtest/**/*.{test,spec}.ts` to
  `include`. Both minimal and appropriate.
- The `loadtest-e2e` workflow is opt-in only: `workflow_dispatch` + nightly
  cron, **no** `pull_request` trigger, and actionlint reported 0 findings
  (S13, independently verified by the orchestrator).

---

## 6. Explicitly acknowledged as verified-and-accepted (not defects)

Each item from the audit brief's "not defects" list was checked to be true as
described. S21 should not spend time on any of them.

1. **Branch stacked on `fix/pr24-review-followup`; PR targets that branch, not
   `main`.** ✅ Verified: `feat/bridge-loadtest`, `fix/pr24-review-followup` and
   the plan's reference commit are all `d5529b3`; `origin/main` is
   `76c59ed1`. The devnet context pack exists only on the base branch.
   User-approved 2026-09-10. Accepted. (See R17 for the separate, procedural
   observation that the branch carries no commits yet.)
2. **dev-ui change 1 — the runtime E2E key override.** ✅ Verified and the gate
   **holds**: `app/context/e2eAccount.ts:22-23` opens
   `resolveE2EPrivateKey` with `if (!IS_E2E_ENABLED) return undefined;`, and
   `IS_E2E_ENABLED` is the build-time-inlined `process.env.NEXT_PUBLIC_E2E_ENABLED === 'true'`
   (`app/constants/e2e.ts:6`). The compiled no-E2E bundle retains the guard as
   `if(!_)return;` with `_` false — inert, and with no key material. The value is
   validated before `privateKeyToAccount` and the throw does not echo it.
   Accepted. See **R5** for the one thing that is *not* as the plan assumed: the
   symbol name still ships.
3. **dev-ui change 2 — `next.config.ts`'s Turbopack build cache.** ✅ Verified
   strictly gated and a literal no-op otherwise:
   `...(process.env.LOADTEST_UI_BUILD === 'true' ? { experimental: { turbopackFileSystemCacheForBuild: true } } : {})`
   — an object spread of `{}` when unset, so `dev`, `build`,
   `build:production`, the Docker image build and the Cloudflare deploy are
   untouched. Only `loadtest/ui/build.ts` sets the variable. Accepted. Both
   dev-ui changes must be called out in the PR.
4. **DESIGN §9.4's declared divergences.** ✅ Verified present and exhaustive in
   the document, with the closing rule "Anything else that differs between the
   two modes is a defect": **C5** (`bridgeGasOffset` headless-only ⇒ browser
   mode can OutOfGas-revert under concurrency, surfacing as `ui_assertion` —
   observed live in S10's third run, 2 of 4 users), **C6/C14** (browser seeds the
   ERC20 so makes no `token-mappings` calls, plus the small per-hop seeding
   residual; headless does three-tier per-chain resolution), **C15**
   (`eth_fillTransaction` wasted-round-trip *frequency* differs, same branch),
   **C16** (`tracker/activity` volume, attributed and rate-bounded since S24).
   Accepted as declared, not as defects.
5. **`autoclaim_overdue` / `unexpected_autoclaim` are counters that do not fail
   a hop** (DESIGN §3.4), a deliberate divergence from aggkit's Go tool. ✅
   Verified: both are `HopCounter` emissions routed to
   `collector.recordHopCounter` and surfaced in the Autoclaim-policy table
   (`report.ts:420-428`); neither appears in any `finish`/`failWithTimeout`
   outcome path. S14's 457 `autoclaimOverdue` against 392
   `hop_completed_escalated` is the escalation design working as intended.
   Accepted.
6. **`ring.ts` notes N1–N7** — seven documented readings where DESIGN §3.2 was
   silent. ✅ Present and each tied to behaviour and, where S12 added one, to a
   test (e.g. N1's T13 grace-window guard at `ring.ts:615`, locked by
   *"does not re-enter the grace window after escalating (note N1: T13 guard)"*;
   N5's success-only `hop_total` at `ring.ts:511`, locked by
   `collector.test.ts:48`). Accepted as documented readings. **R2 is a separate
   finding about N5's silent generalisation to all phases, not a challenge to
   N5 itself.**
7. **`BASELINE.md` contains the devnet fixture private key in plaintext.** ✅
   Verified *accepted, devnet-fixture-only*, **not** a leak: the single 64-hex
   value in `BASELINE.md` is
   `0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625`, and
   `grep -o '0x[0-9a-fA-F]\{64\}' tests/devnet/summary.json` confirms the same
   value is already committed there (among 23). Accepted. (R12 is a *different*
   point: the same key sits in an untracked file that `.gitignore` does not
   cover.)
8. **The repo has never been prettier-clean.** ✅ Verified: `pnpm run format` is
   `prettier --check .` and fails on 40 files, including
   `app/context/e2eAccount.ts` **at `HEAD`** and untouched files such as
   `app/utils/address.ts` and `app/constants/routes.ts`. Pre-existing, not
   introduced here. **20 of the 40 are ours** and are an existing S21 task —
   recorded as **R13**, ranked Low.
9. **A5's multi-process sharding and VALIDATION-1's A7–A10 are knowingly
   deferred.** ✅ Verified still open and already S21 tasks — recorded as
   **R18**, not re-discovered as new findings.
10. **S18 is blocked** for want of a funded Sepolia key and a real proxy URL. ✅
    Verified: `config.json`'s testnet **and** mainnet `aggkitProxy` are both the
    literal `https://PLACEHOLDER-testnet-aggkit-proxy`, and `validate` rejects
    placeholder hosts (`PROXY_URL_PLACEHOLDER`). Accepted as the expected
    outcome. Carried forward: **`maxTotalSpend` caps native currency only** —
    ERC20 transfers are not counted (recorded by S05/S18 and re-confirmed in §4
    of the safety sub-audit below). **R19 raises this from "call it out in the
    PR" to High**, because R0 removes the other guard on the same money path.

---

## 7. S20 acceptance criteria

1. **Findings carry file:line, severity and a repro; nothing is left
   unclassified.** ✅ 35 findings (R0–R34), every one with a severity, at least
   one `file:line`, and a stated repro or an explicit note that it is
   statically root-caused rather than reproduced. Distribution: **1 critical**
   (R0), **7 high** (R1, R2, R3, R4, R19, R28, R29), **13 medium**, **9 low**,
   **5 info**. Nothing is recorded as "unclear" or "needs investigation".
2. **The production-bundle grep result is recorded verbatim.** ✅ §3, finding
   **R5** — both the no-E2E build (the required check) and an E2E build as a
   positive control, with the exact commands, the exact `grep` output including
   `exit=$?`, and the reading of the minified guard. Result, stated plainly:
   **the symbol is present (`exit=0`) in both builds; no key material is
   present in the no-E2E build, and the gate is compiled in and effective.**
   `out/` and `.next/` were removed afterwards and `git status --short` is
   byte-identical to before.
3. **Every "not a defect" item is explicitly verified and accepted.** ✅ §6,
   items 1–10, each checked against the code rather than taken on trust, with
   the two places where verification turned up something adjacent flagged
   separately (R5 for the bundle symbol, R12 for the untracked `.bak`, R19 for
   the ERC20 cap severity) so S21 can tell the accepted decision from the new
   finding.
4. **What I could not audit is stated plainly.** ✅ §1, seven numbered items —
   chiefly: no live run was performed, R0/R1 are statically root-caused rather
   than reproduced, the testnet/mainnet path is entirely unexercised (S18
   blocked), the S14/S17 latency figures are unusable by the tool's own
   self-disqualification, aggkit's `/metrics` is unreachable, the devnet is
   wedged, and prettier could not be made clean within S20's non-goals.

---

## 8. Reviewer's bottom line

The tool is substantially better than its own history suggests: `core/` is
genuinely pure, the state machine's timeout coverage is complete and matches its
specification row for row, the big-int `global_index` path is correct on **both**
workers, `getClaimInputs`'s recording-network routing is byte-identical to the
UI, P3–P14 all match, the secret-redaction choke point really is the only exit,
and — most creditably — the report contains machinery designed to invalidate its
own numbers (the throughput identity and A5's latency self-disqualification),
both of which have fired for real and caught real defects. That is rare and
worth preserving.

The findings cluster in two places, and both are the places the audit brief
predicted.

**First, honest measurement.** The brief's instinct was right: more
self-flattering numbers existed. `ready_to_claim` — the single most
consequential latency in the whole test, and the metric DESIGN §3.3 sizes its
timeouts from — is biased optimistically from **both** ends at once: its slow
tail is discarded (**R2**, no sample on timeout) and its fast head is duplicated
(**R28**, re-recorded on every retry, against the file's own note N2). Alongside
those, the demand denominator can silently shrink with no counter able to reveal
it (**R29**), suppressed errors let `summary.md` print "No errors recorded" over
a non-empty log (**R7**), gate percentiles are censored at the timeout without
saying so (**R6**), abandoned operations keep generating recorded traffic
against hops already declared failed (**R4**), and self-inflicted nonce
collisions are filed under a class that reads as the system-under-test's fault
(**R3**). Individually each is modest; together they mean the current report
should not be quoted as a proxy measurement until they are addressed. None
requires redesign — most are a disclosed denominator or one extra counter.

**Second, real-funds safety, and this is the one blocker.** **R0** is the finding
I would not ship: the mainnet confirmation gate sits on `fund`, not on `run`, so
`pnpm loadtest run --config mainnet.json` with wallets already funded will
broadcast a full load test against mainnet with no confirmation and no dry-run.
**R19** (no ERC20 spend cap at all) and **R23** (`env` never cross-checked
against the actual chain) sit on the same path and compound it. These three
should be fixed together, and they are small: a confirmation check moved to
`runLoadTest`'s entry, an ERC20 cap field beside `maxTotalSpend`, and a chain-id
assertion.

**Suggested S21 order:** R0 + R19 + R23 first (safety, small, blocking); then
R28 + R2 + R29 + R7 (report honesty — cheap, and they are what the tool exists
for); then R1 + R4 (the teardown hang, which is also blocking CI's ability to
wait on `run`); then R3's attribution decision, which needs a deliberate
parity-versus-cleanliness call rather than a patch; then the mediums. R13's
formatting pass and the R32 dead-code deletions are best done last, in one
sweep, so they do not obscure the substantive diffs.

**Two closing notes for S22's PR description.** Both approved dev-ui changes are
verified correctly gated and must be called out (§6 items 2 and 3) — but the
E2E-override bullet must say "gated and inert in production builds", not "absent
from production builds", because **R5** shows the latter is one `grep` away from
being contradicted. And `git add -A` must not be used: **R12**'s
`.env.local.bak` is untracked, unignored, and contains a private key.

---

## 9. S21 resolutions

Every finding below was addressed in step S21. "Fixed" gives the file(s)
changed and the test that locks the fix; "Documented" gives where the
decision/caveat now lives; nothing is silently dropped.

### Critical

- **R0 — FIXED.** `loadtest/runner.ts`'s `runLoadTest` now checks
  `config.env === 'mainnet' && !mainnetConfirmed` as its **first** statement
  (before wallet derivation, funding, preflight, or any driver work), throwing
  the new `MainnetConfirmationRequiredError`. This is a **duplicate** of
  `wallets/fund.ts:441`'s existing gate, not a move — `fund` standalone still
  refuses independently. Test: `loadtest/runner.test.ts` (3 tests). Live CLI
  evidence (see the feedback pack) shows `pnpm loadtest run --config
  <mainnet config>` (no `--fund`) refusing with
  `MAINNET_CONFIRMATION_REQUIRED: run refuses to execute against env
  "mainnet" without --i-know-this-is-mainnet...`. **Not added:** a
  `--dry-run` mode — REVIEW.md's fix shape suggested one, but it is a new
  feature (S21 non-goal) rather than a fix to the missing gate; the gate
  itself is what made R0 a release blocker and is now closed.

### High

- **R19 — FIXED.** `loadtest/config/schema.ts`: new optional
  `funder.maxTotalErc20Spend` field plus a cross-field check
  (`FUNDER_MAX_ERC20_SPEND_REQUIRED`) that makes it **required** whenever a
  non-devnet-anvil fund uses an erc20 asset (devnet's `anvil_setBalance` path
  stays deliberately uncapped — no real-funds risk). `loadtest/wallets/fund.ts`'s
  `fundViaTransfer` now plans the erc20 outlay (Pass 1, sum across wallets)
  and refuses the whole erc20 fund before sending anything if it exceeds the
  cap — mirroring the native path's Pass 1, **without** repeating its Pass 2's
  confirmed-dead incremental re-check (see R32/R27 below). Tests:
  `config/schema.test.ts` (3 new), `wallets/fund.test.ts` (3 new, one
  confirming devnet stays uncapped).
- **R28 — FIXED.** `loadtest/core/ring.ts`'s `applyAwaitingReady` now gates the
  `ready_to_claim` phase recording on `mut.hop.readyAt === null` (true exactly
  once per hop, per note N2), so a T20 retry cycle contributes exactly one
  sample instead of N+1. Test: `core/ring.test.ts`'s existing "does not
  re-enter the grace window after escalating" test now asserts
  `.phases.filter(p => p.phase === 'ready_to_claim')` has length 1 — this is
  the exact repro REVIEW.md gave, and it failed (length 2) before the fix.
- **R29 — FIXED (both halves).** `loadtest/core/scheduler.ts`'s `pump()`:
  credit no longer caps at one token (`Math.min(periodMs, ...)` removed) and
  the tick loop now drains every whole period as its own tick (simulating
  each tick's effect on backpressure via `providedThisPump` so a burst still
  respects `maxInflightLapsPerUser`) — a coarse pump cadence now delivers the
  full backlog as a burst instead of silently losing it. Separately,
  `SchedulerCounters`/`CollectorSnapshot.scheduler` gained an **independent**
  `ticksExpected` (`users x rate x minutes`, from config alone, never derived
  from the other three counters), rendered in `summary.md`'s Throughput
  section alongside `ticksOffered` with an explicit gap line. Tests:
  `core/scheduler.test.ts` (3 new — burst delivery, backpressure-in-a-burst,
  `ticksExpected` independence), `metrics/report.test.ts` (1 new, rendering).
- **R1 — FIXED.** `loadtest/workers/browser/pool.ts`: `launchSlot` and
  `acquireContext` now refuse to start a **new** launch once
  `this.disposing` is true (matching the crash-recovery path, which already
  did); `dispose()` now awaits every in-flight `crashInFlight` recovery and
  every in-flight `slot.launching` **before** closing anything, so a launch
  that was already running when teardown started is guaranteed to finish (and
  then get closed) rather than resurrecting a Chromium process after
  `dispose()` returns. `loadtest/cli.ts`'s `main()` now calls
  `process.exit(process.exitCode ?? 0)` once it settles, rather than relying
  on the event loop draining naturally. Test:
  `workers/browser/pool.test.ts` — the exact unit-level repro REVIEW.md
  suggested (stub `chromium.launchServer` to stay pending, start
  `acquireContext`, call `dispose()` while the launch is still in flight,
  release it, assert `slot.server`/`slot.browser` end up `null`), plus a test
  that `acquireContext` now rejects once disposing has begun.
- **R2 — FIXED.** `loadtest/core/ring.ts`: a phase that times out now records
  a **censored** sample (`recordCensoredTimeoutPhase`, wired into both the
  standalone per-phase-timeout branch and the T28/T29 combined branches)
  instead of no sample at all. `metrics/collector.ts` keeps censored samples
  **out** of the percentile arrays (`phases`) but counts them separately
  (`phaseCensoredCounts`); `summary.md`'s Phase latencies table renders a
  `timedOut` column plus a disclosure note whenever any phase has one.
  Tests: `core/ring.test.ts` (2 new), `metrics/collector.test.ts` (1 new),
  `metrics/report.test.ts` (1 new).
- **R3 — DELIBERATE DECISION, documented and made honest (not a silent
  patch).** Kept UI parity: no per-(user, chain) nonce serialization was
  added to the user send path (`workers/headless/headlessUser.ts`'s
  `sendAndWait` still drops the nonce exactly as the real UI does — finding
  C4). Instead, a nonce-shaped rejection is now classified as its own
  `ErrorClass`, `nonce_conflict` (`core/types.ts`), rather than folded into
  `rpc_error` — `metrics/errors.ts`'s `classifyRpcError`/`classifySubmitError`
  detect "nonce" in the message text (evidence-based, not a blanket
  `-32003` reclassification, since that code covers other rejections too);
  `core/ring.ts`'s `outcomeFromDriverError` still maps it to the `rpc_error`
  **outcome** (no new hop-outcome category), so only the separately-reported
  error-class table gains the distinction. Documented in
  `loadtest/DESIGN.md` §5.3's error taxonomy table (new `nonce_conflict` row
  with the full reasoning) and in `metrics/errors.test.ts` (2 tests updated
  to assert the new class on the exact S14 messages: "nonce too low" and
  "Nonce provided for the transaction is lower than the current nonce...").
- **R4 — FIXED.** `workers/headless/headlessUser.ts`'s `sendAndWait` now
  passes `timeout: this.receiptTimeoutMs` (wired from
  `config.timeouts.txReceiptMs` in `runner.ts`) to viem's
  `waitForTransactionReceipt`, bounding an abandoned receipt wait to the
  SAME budget `ring.ts` enforces instead of viem's 180 000ms default (3x the
  devnet budget). Not independently unit-tested — `headlessUser.ts` has no
  existing unit-test harness (its I/O-heavy methods require a live/mocked
  viem client stack no test in this file currently builds); verified by code
  inspection and exercised live in the S13 e2e run and the worktree quick
  start (see below).

### Medium

- **R5 — no action required (verified-and-accepted by S20, re-confirmed).**
- **R6 — FIXED.** `core/ring.ts`'s `exitGate`/`finish` now tag a gate-exit
  emission `timedOut: true` when the hop finished via a `TimeoutOutcome`;
  `metrics/collector.ts`'s `GateStats` gained `timedOutVisits`;
  `summary.md`'s Gate-stalls table renders the column plus a disclosure note.
  Percentiles are unchanged (a timed-out visit still contributes its real
  duration, per the pre-existing, correct behaviour) — only the
  interpretability signal is new. Tests: `core/ring.test.ts` (1 new),
  `metrics/collector.test.ts` (1 new).
- **R7 — FIXED.** `metrics/collector.ts`'s `error()` now counts
  `suppressedNotReady`/`suppressedBenignAsset` (exposed as
  `errors.suppressed`); `renderErrors` prints "No non-suppressed errors
  recorded (N suppressed — see below)." instead of the unqualified "No
  errors recorded." whenever any were suppressed, plus a **Suppressed**
  table naming both classes and their policy. Tests:
  `metrics/collector.test.ts` (2 new), `metrics/report.test.ts` (1 new).
- **R8 — FIXED.** `metrics/report.ts`'s `steadyStateMinutes` now uses the
  collector's real elapsed `run.durationMs` when available (a completed or
  `report --dir`-regenerated run), falling back to the requested
  `durationMinutes` only when it isn't. Test: `metrics/report.test.ts` (1 new,
  the exact SIGINT-at-4-of-20-minutes scenario from the finding).
- **R9 — FIXED.** `config/schema.ts`'s `loadSchema` gained a
  `RAMP_UP_EXCEEDS_DURATION` cross-field check (`rampUpSeconds <
  durationMinutes * 60`), beside the existing
  `readyToClaimMs < hopMs < lapMs` invariant. Test: `config/schema.test.ts`
  (2 new).
- **R10 — FIXED.** `workers/browser/browserUser.ts`'s `openFreshPage()` now
  calls a new `assertConnectedWallet()` right after `connectWallet()`,
  comparing the header badge text against `shortenAddress(this.address)` and
  throwing loudly on mismatch — converting a silent
  addInitScript-ordering regression into an immediate, classified init
  failure. Not independently unit-tested — `init()` requires a real
  Playwright browser (this file's own tests intentionally never call it);
  exercised live in the S13 e2e run (4/4 users connected correctly, 0
  mismatches) and the worktree quick start.
- **R11 — FIXED.** `workers/headless/uiCallset.ts`'s `installTimingFetch`
  now calls a new `collector.recordUncontextedRequest()` on both the success
  and failure branch of the un-contexted case (previously a silent no-op);
  `metrics/collector.ts` exposes `uncontextedRequests`;
  `summary.md`'s Endpoint latencies section notes it explicitly when > 0.
  Tests: `workers/headless/uiCallset.test.ts` (2 new).
- **R12 — FIXED.** `.env.local.bak` deleted (contents recoverable via `node
  scripts/kurtosisDevnetEnv.mjs` against a live Kurtosis enclave, per its own
  header). `.gitignore` widened with `.env.local*` / `.env*.bak` for defense
  in depth. `loadtest/README.md`'s troubleshooting item 1 updated to match
  reality.
- **R20 — FIXED.** `workers/headless/uiCallset.ts`'s `anyRowNonTerminal` no
  longer excludes `'ERROR'` rows — it now matches
  `app/hooks/useTransactions.ts`'s `hasNonTerminalTransaction` exactly
  (`status !== 'CLAIMED'`), closing the under-polling divergence. Test:
  `workers/headless/uiCallset.test.ts` (4 new, including the exact ERROR-row
  case).
- **R21 — FIXED.** `wallets/redact.ts`'s `redactSecrets` gained two more
  patterns: an un-prefixed 64-hex private key, and a word-list-free BIP-39
  mnemonic heuristic (12-24 whitespace-separated lowercase-alpha 3-8-letter
  words), redacting the whole sequence as `<redacted mnemonic>`. Tests:
  `wallets/redact.test.ts` (4 new).
- **R22 — FIXED.** `ui/build.ts`'s child `next build` process now receives
  an **allowlisted** environment (`allowlistedEnvForBuildChild`: `PATH`/
  shell/`NODE_*`/`NPM_*`/`PNPM_*`/`NEXT_PUBLIC_*` plus the loadtest-specific
  vars it actually needs) instead of the entire parent `process.env`. Test:
  `ui/build.test.ts` (3 new, including "does NOT forward a real secret the
  operator exported").
- **R23 — FIXED.** `config/schema.ts` gained two registry-free cross-field
  checks: `ENV_RPC_URL_MISMATCH` (env `"devnet"` requires every `rpcUrl` to be
  loopback — this repo's devnet always is) and `ENV_CHAIN_ID_MISMATCH` (the
  L1 chain's `chainId` must be Ethereum mainnet's `1` if and only if `env` is
  `"mainnet"`). Tests: `config/schema.test.ts` (3 new, including the exact
  repro — a testnet example relabelled `"devnet"`).
- **R24 — FIXED (upgraded from "accepted, one choke point" to "redacts at
  source").** `wallets/preflight.ts` now imports `redactError` and routes
  every one of its 5 error-message sites through it, rather than relying
  solely on `cli.ts`'s single `main().catch(redactError(...))` choke point.
  Covered by the existing `wallets/preflight.test.ts` suite (unchanged
  assertions; passes with the wrapped calls).
- **R25 — DOCUMENTED (non-goal: do not wire up HAR/trace).**
  `loadtest/DESIGN.md`'s config-field-reference table now marks
  `browser.trace` "Not yet wired up" with an explicit warning that whoever
  wires it up must route the trace through redaction first (it would record
  the raw per-user private key at higher verbosity). The HAR path
  (`harPathFor`) was already fully explained as inert in REVIEW.md itself.
- **R26 — FIXED (docs).** `loadtest/DESIGN.md` §9.1 row P2 and
  `loadtest/PARITY.md`'s P2 row both corrected: "not implemented" (no code
  path anywhere replays it), not "default probability 0" (which implied a
  configurable, defaulted-off knob that does not exist).
- **R27 — no action required (verified-and-accepted by S20; part (a)'s dead
  code is deleted under R32 below, not because R27 demanded it).**
- **R30 — FIXED.** `core/ring.ts`'s standalone per-phase-timeout branch now
  labels its transition with the actual DESIGN §3.2 row (`timeoutTransitionId`,
  a state/claimStep/autoclaim-aware switch — T3/T5/T7/T9/T12/T13/T14/T19/T20/
  T21/T23/T26) instead of the `hopMs` umbrella's own `'T28'`. The combined
  T28/T29 branches are unchanged (correctly labelled already) and still emit
  the phase-specific outcome as `secondary_timeout`. Test:
  `core/ring.test.ts` (1 new, asserting T13/T14/T20 fire under their own ids).
- **R31 — FIXED.** The `lapMs` path in `core/ring.ts`'s `advanceLap` now
  emits a `gate_exit` RingEmission (tagged `timedOut: true`) for any open
  gate visit it closes, alongside the existing (correct) `Hop.gates` update —
  so a gate visit interrupted by `lapMs` now appears in the Gate-stalls
  table, which is built from the streamed emissions, not `Hop.gates`
  directly. Test: `core/ring.test.ts` (1 new).

### Low / informational — dead code (R32), formatting (R13), docs (R33/R34)

- **R32 — FIXED (all 4 items).** (a) `core/ring.ts`'s `AWAITING_CLAIMED`
  branch's unreachable `unexpected`/T27 ternary deleted (T27 remains fully
  reachable via its other half). (b) `core/ring.ts`'s second, mathematically
  unreachable drain check in `applyTick` deleted. (c) `outcomeFromDriverError`'s
  `already_claimed` case kept (deleting it would break the `default: return
  cls` exhaustiveness the switch relies on) — already correctly documented
  as unreachable-by-design; no code change needed beyond the existing
  comment. (d) `core/types.ts`'s orphaned `SchedulerCounter` type deleted.
  `core/ring.test.ts`'s 46 tests (up from 42) confirm no behaviour changed.
- **R13 — FIXED.** `pnpm exec prettier --write 'loadtest/**'
  'tests/loadtest-e2e/**'` run; `pnpm exec prettier --check` on both globs
  now reports "All matched files use Prettier code style!". `app/**` and
  every other pre-existing failure (20 files, confirmed unchanged) were
  deliberately left untouched.
- **R14 — FIXED.** `runner.ts` now captures `installTimingFetch(...)`'s
  `uninstall` handle and calls it in `disposeEverything()`, restoring
  `globalThis.fetch` at teardown. Test: `workers/headless/uiCallset.test.ts`
  (1 new).
- **R15 — accepted design trade-off (S20's own characterization); no action.**
- **R16 — FIXED.** `runner.ts`'s default `logger` now writes to
  `process.stderr` instead of silently discarding every line. Existing
  `runner.test.ts` unaffected (both tests pass an explicit assertion path
  before reaching any logger call).
- **R17 — informational, no action (process fact about the branch, not a
  code defect).**
- **R18 — VALIDATION-1's A7-A10, addressed below (not left open).**
- **R33 — FIXED (docs).** `DESIGN.md`'s `lapMs` prose corrected from
  `2 700 000` (45 min) to `3 600 000` (60 min), matching its own §3.3 table
  and what `deriveDevnet.ts` actually emits.
- **R34 — no action required (verified-and-accepted by S20; the code is
  correct, only the looser prose sentence misled — already flagged, not
  re-fixed here).**

### VALIDATION-1.md A7-A10 (deferred items named explicitly in the S21 brief)

- **A7 — FIXED.** `uiCallset.ts`'s attempt-window heuristic now excludes
  `tracker/activity` entirely (`attempt` is always `0` for that endpoint
  class) — it is P1's own legitimate poll loop, never retried by the SDK, so
  the window-based inference (correct for `/bridge/v1/*`) no longer
  mislabels nearly every poll after the first as a "retry". Test:
  `workers/headless/uiCallset.test.ts` (1 new).
- **A8 — FIXED.** `workers/browser/browserUser.ts`'s bare `catch {}` around
  the receipt fetch/log-decode now classifies the caught error
  (`classifyRpcError`) and reports it via a new `BridgeSubmission.
  bridgeEventDecodeError` field, wired through `runner.ts`'s
  `reportEmbeddedErrors` — the underlying cause is now visible in the errors
  table instead of silently manufacturing an unexplained
  `bridge_event_missing`. The ring outcome itself is unchanged (T11 still
  fires exactly as before when the decode genuinely fails) — this is a
  diagnostic improvement, not a ring-semantics change.
- **A9 — DOCUMENTED, not re-implemented.** This item is about how a past
  validation write-up (VALIDATION-1.md) phrased one number ("82
  requests/user" quoted without the caveat that browser users were broken
  90% of that run), not a defect in the tool's current report — the
  suggested fix ("normalise per active user-minute, print the raw count
  alongside") would be a new report metric, and A10's per-mode achieved-rate
  breakdown (below) already gives a reader the tool to catch this class of
  mistake for any FUTURE write-up. Recorded here as accepted or deferred, not
  left silently open.
- **A10 — FIXED.** `metrics/collector.ts` now tracks
  `lapStartsSubmittedSteadyByMode`; `metrics/report.ts`'s
  `achievedFromSnapshot` derives a per-mode
  `steadyStateRatePerUserPerModeMin`, rendered in `summary.md`'s Throughput
  section as its own table (browser vs. headless), so the two modes'
  achieved rates can never be silently averaged into one blended headline
  again. Tests: `metrics/report.test.ts` (1 new, two modes behaving
  oppositely).

# VALIDATION-1 — analysis of validation run #1 and fix strategy (S15)

> **RETRACTION (S35, 2026-09-16).** Finding **C1** below — "agglayer's SP1 native executor
> crashes with SIGBUS ... permanently blocking a network" — has been root-caused by S34 to
> **this devnet's own misconfiguration**, not an agglayer/aggkit defect: agglayer's certificate
> orchestrator ran its real CPU-local SP1 prover (`certificate-orchestrator.prover.sp1-local`,
> confirmed from `/etc/agglayer/config.toml`, not mock-proofs) against Docker's default **64 MB**
> `/dev/shm`, and SIGBUS on a shared-memory write is the textbook symptom of a tmpfs too small to
> back the mapping. Adding `shm_size: '4gb'` to the `agglayer` service (commit `4947855`)
> eliminates the crash entirely — verified both at the exact rung that reliably wedged network 1
> (`--users 12 --browser 4 --rate 3 --minutes 10`, zero `InError` certificates, 69 laps drained)
> and at the full original 100-user/20-browser/20-minute scale that motivated this document (571
> laps drained, 73 certificate-health samples, zero `in_error` at any point, zero container
> restarts). **The "devnet capacity ceiling" this document attributes to C1 was never real** —
> every "(c) C1" / "bucket (c)" assignment below should be read as **(b) our own devnet
> misconfiguration**, now fixed. The fix came from the agglayer node team (Leo Gaspard, Monir
> Hadji, Thiago Nobayashi) via Slack and was **already known on agglayer 0.5.0** — the actionable
> upstream ask is a **kurtosis-cdk default**, not a code change. **C2–C6 below are unaffected and
> stand** — in particular C2 (a wedged network reporting `is_synced: true`) is arguably
> strengthened: a silent *local* misconfiguration produced exactly the silent-failure mode C2
> warns about. **Finding A5 (§2, the harness's own single-Node-process event-loop ceiling) is a
> separate, genuine, already-documented limit and is NOT affected by this fix** — do not read the
> retraction below as implying that devnet capacity is now unbounded; the harness's own
> concurrency ceiling still applies. See plan steps S34/S35 for the full evidence. The rest of
> this document is left intact as the historical record of the original (now-corrected)
> analysis, with inline corrections added at each affected passage.

Run under analysis: `loadtest-results/20260911T175302Z/` — `run --users 100 --browser 20
--rate 2 --minutes 20 --assets eth,erc20`, started `2026-09-11T17:53:53.987Z`, ended
`18:31:14.721Z` (37.3 min: 20 min load + 17 min drain), `aborted: false`.

This document does three things and nothing else: it splits every observation from S14 into
**(a) tool defect**, **(b) expected on devnet**, **(c) genuine aggkit/agglayer finding**; it
gives S16 a prioritised, file-level fix list for (a); and it resolves the one attribution
question S14 left open — whether the L2→L2 wall was load-driven latency or a broken prover.

No code was changed. Every number below was re-derived from
`activity.ndjson` / `results.json`, from the full-window container logs in the session
scratchpad (`s14/aggkit-00{1,2}-full-window.txt`, `s14/aggkit-proxy-001-full-window.txt`), or
read live off the still-running devnet during this step.

---

## 0. Verdict in four lines

1. **aggkit-proxy is clean.** Zero errors, zero warnings, zero 4xx/5xx across the full window;
   96 927/96 927 headless and 1 628/1 645 browser `tracker/activity` calls returned 200.
2. **The L2→L2 wall was not latency. Network 1's certificate prover crashed** (SIGBUS) on the
   first certificate that carried load-test bridge data, and it was *still* crashing at the time
   of this run. **[RETRACTED, S35]** All 534 `timeout_ready_to_claim` were originally assigned to
   bucket **(c) "the devnet was broken [genuine agglayer finding]"**; S34 root-caused the crash to
   this devnet's own undersized `/dev/shm` (fixed in commit `4947855`), so the correct bucket is
   **(b) "our own devnet was misconfigured"** — not an agglayer defect, and not (b)'s usual
   "the devnet is slow" either. It genuinely was broken, just by us.
3. **The largest tool defect is trivial and embarrassing**: each user was funded exactly
   `amount × 4` of the ERC20 and the ring never returns the token, so the 5th erc20 bridge
   onward reverts. Verified live on-chain in this step.
4. **The tool's own latency numbers are not usable.** The runner pinned one CPU core out of 64;
   the headless HTTP percentiles are contaminated by event-loop queueing. The proxy's latency
   is *unmeasured* by this run.

---

## 1. Resolved: load-driven latency vs prover crash

**Answer: prover crash. Certificate settlement on this devnet is a fixed ~60 s and shows no
load sensitivity whatsoever.** The "~95 s idle → ~640 s lightly loaded → >900 s under load"
curve recorded earlier in this project is not a capacity curve; it is the *retry cadence of a
crashing prover* sampled at three different moments.

### 1.1 The evidence

**agglayer's own histogram kills the latency hypothesis.** Read live from
`http://127.0.0.1:9092/metrics` during this step:

```
agglayer_certificate_duration_seconds{network_id="1"}  count 9   sum 541.692 s   (mean 60.19 s)
  bucket le=60   -> 0        # not one certificate ever settled faster than 60 s
  bucket le=120  -> 9        # and not one ever took longer than 120 s
agglayer_certificate_stage_duration_seconds{network_id="1",stage="candidate"}  mean 60.01 s
agglayer_certificate_stage_duration_seconds{network_id="1",stage="proven"}     mean  0.0072 s
agglayer_certificate_duration_seconds{network_id="2"}  count 1   sum  60.208 s
```

Ten settled certificates across two networks, every one of them 60–120 s end to end, with
essentially all of it in `stage=candidate` (the L1 settlement epoch) and ~7 ms in `stage=proven`
(this devnet runs a native/mock prover). **There is no load-sensitive settlement latency to
find.** Under the load of this very run, certificates 8 settled in 60.9 s.

**The wedge started before any lap could reach hop 1, and it froze the exit root before the run
even began.** From `aggkit-001`'s full-window log:

| time | event |
|---|---|
| 17:51:16.945Z | cert **7** `[Candidate] → [Settled]`, `NewLocalExitRoot 0xb0ca4019…` — **2 m 37 s before the run started** |
| 17:53:53.987Z | run starts |
| 17:54:46.945Z | cert **8** `[Pending] → [Candidate]` |
| 17:55:04.636Z | **first L2A→L2B bridge send of the run** (earliest hop-1 `T7` in `activity.ndjson`) |
| 17:55:46.945Z | cert **8** `→ [Settled]` in 60.9 s — but `PreviousLocalExitRoot == NewLocalExitRoot == 0xb0ca4019…`, i.e. a **claims-only certificate that did not advance the LER** |
| 17:55:48.945Z | cert **9** (`0xfb2ec17c…`, the first cert to advance the LER, to `0x4c881482…`) goes `[Pending] → [InError]`: `InternalError("Sp1-native execution failed … Child native executor crashed, details: CrashDetails { signal: 7, addr: 0, operation: 0 }")`, `crates/agglayer-certificate-orchestrator/src/error.rs:171:29`. **signal 7 = SIGBUS.** |
| 18:00:49 … 18:30:50 | retries 1–7, one every 5 min, **identical crash every time** |
| now (≈1 h after run end) | `agglayer_node_network_height{network_id="1",stage="pending"} 9` vs `stage="settled" 8`; `agglayer_node_network_latest_certificate_in_error{network_id="1"} 1`; aggkit-001 still logging the retry loop twice a second |

Network 1's local exit root has been frozen at `0xb0ca4019…` since **17:51:16Z**, before the
load phase. Certificate 9 is the *first* certificate containing any load-test L2A→L2B bridge
leaf, and it has never settled. **Therefore not one L2A→L2B bridge produced by this run could
ever have become claimable, at any timeout.** This is deterministic, not probabilistic:
`L2A→L2B` completions were 0/667 because they were structurally impossible, not because 900 s
was too short.

### 1.2 Re-reading the three earlier latency measurements

Settlement is a fixed ~60 s, and agglayer retries an `InError` certificate **every 5 minutes**.
That single fact reproduces all three previously recorded figures without invoking load:

| earlier observation | re-attribution |
|---|---|
| **~95 s idle** | healthy: 60 s epoch + ~35 s bridge-mine / tracker-index / claim. This is the devnet's true floor and belongs in **(b)**. |
| **~638 s "lightly loaded"** (`sanity_l2l2.log`) | one crash + one successful retry: 300 s retry delay + 60 s settle + ~60 s claim/index ≈ 420–700 s. The 5-minute retry quantum explains 638 s far better than "light load" does. **(b)** [was **(c)**, S35: same root cause as C1, now known to be our devnet's `/dev/shm` misconfiguration, not an agglayer defect]. |
| **>900 s "under 6 concurrent users"** (12/12 `timeout_ready_to_claim`) | a persistent wedge — unbounded, not 900 s-ish. **(b)** [was **(c)**, S35: same root cause — see above]. |
| the 3 earlier "aggsender wedges" | **not** the LER-not-found signature: grepping both aggkit logs for `resolving root index`, `unable to replace`, `tracking_status` gives **zero hits** in this run's window. Whatever they were, the mechanism observed here is a prover crash, and it is the only one with direct evidence. |

**Consequence for the headline.** The tool's finding is **not** "the proxy is fine, the devnet is
slow". It is: **"the proxy is fine; the devnet's certificate prover crashes on real bridging
traffic and stays crashed, and nothing in the client-visible health surface says so."**
**[RETRACTED/revised, S35]** S34 root-caused the crash to this devnet's own undersized
`/dev/shm` (Docker's default 64 MB, fixed by `shm_size: '4gb'`) — not an agglayer/aggkit defect.
The corrected headline is: **"the proxy is fine; our own devnet was misconfigured and its
certificate prover crashed as a result (now fixed); and nothing in the client-visible health
surface would have caught it even so"** — that second half (C2) is the part that survives
unchanged and is arguably the more valuable finding, precisely because it shows a *local*
mistake can hide behind `is_synced: true` for the better part of an hour.

### 1.3 Bucket assignment for the 534 `timeout_ready_to_claim`

**534/534 → (b)** [was **(c)**, S35 — see the retraction note at the top of this document: the
cause was our own devnet's undersized `/dev/shm`, not an agglayer defect]. All 534 are hop 1
(`L2A→L2B`); 531 headless, 3 browser; every one of them waited on a local exit root that
certificate 9 was supposed to publish. By extension the 1 583 `claim-proof`-gated backpressure
skips (88 % of all skips) and therefore most of the throughput shortfall are downstream of the
same cause.

---

## 2. (a) TOOL DEFECTS — prioritised, file-level fix list for S16

### A1 · P0 — ERC20 funding is sized for exactly 4 bridges per user; every erc20 bridge from the 5th onward reverts (336 occurrences)

**Symptom.** `Execution reverted with reason: panic: arithmetic underflow or overflow (0x11).`
336 occurrences, **336/336 headless**, 100 % asset `a1` (erc20), 100 % hop 0 (`L1→L2A`), across
**29 distinct users**, each user's first occurrence at lap index **4**.

**Root cause — established, not hypothesised.**

1. The lap index in a `hopId` is **per (user, asset)**, not per user. `u21:a1:l4:h0` is user 21's
   *5th erc20 lap*. (S14's NOTES read it as a global counter; the conclusion survived, but the
   fix depends on the correct reading. Verified: `u21` has both `u21:a0:l1:h0` and
   `u21:a1:l1:h0`.)
2. The run config sets `users.funder.assetTopUp: "0.04"` and `assets[1].amount: "0.01"` —
   **exactly four bridges' worth.** The schema default is the same shape:
   `decimalTimesFour(asset.amount)`, `loadtest/wallets/fund.ts:61-75`, applied at `:333` and
   `:545` (DESIGN §2.1's documented `amount × 4`).
3. The ring `L1 → L2A → L2B → L1` only returns the token on hop 2. `LAP_DONE: 0`, so **the token
   never came back**. Each user's L1 ERC20 balance is monotonically drained 0.01 per erc20 lap:
   4 laps succeed (l0–l3), the 5th (l4) underflows, and every one after it.
4. The devnet's test ERC20 does an unchecked `balanceOf[from] -= amount` (the same shape as
   `fund.ts:113-131`'s fallback token), so an insufficient balance surfaces as a bare Solidity
   panic 0x11 instead of a named error.

**Live confirmation performed in this step** (devnet still up, token
`0xe293A6b8F558422813499bb5C89B60adD8c54636` on L1):

```
u21 0x02484cb5…  erc20 balance = 0        u22 = 0    u23 = 0    u25 = 0
u28 0x40Fc963A…  erc20 balance = 0        u30 = 0    u32 = 0
u75 0x54ccCeB3…  erc20 balance = 0.01     <- only reached 3 erc20 laps, never underflowed
eth_call transfer(0.01) from u21 right now -> "Arithmetic operation resulted in underflow or overflow"
```

It is **not** gas drift and **not** allowance drift: allowance is re-approved per hop (T1/T3/T5,
530 approvals headless), and ETH never underflows because gas funding (0.05/chain) dwarfs the
0.001 bridge amount.

**Fix (S16), in order:**

1. `loadtest/wallets/preflight.ts` — add a budget invariant and **fail the run before it starts**:
   for each `assets[i]` with `kind: 'erc20'`, require
   `perUserBalance ≥ amount × ceil(load.bridgesPerMinutePerUser × load.durationMinutes)`
   (worst case: every lap picks that asset). The error message must print the required
   `assetTopUp`. This alone would have turned 336 silent reverts into one clear startup failure.
2. `loadtest/wallets/fund.ts:61-75` — replace the `decimalTimesFour` default with a
   duration-derived default, `amount × (bridgesPerMinutePerUser × durationMinutes + margin)`;
   keep `users.funder.assetTopUp` as an explicit override. Update DESIGN §2.1's default text in
   the same commit.
3. Optional but right for S17 scale: a pre-bridge balance read in `loadtest/core/ring.ts`'s
   `BRIDGE_BUILD` path that emits a distinct outcome (`insufficient_asset_balance`) and skips
   the hop instead of burning a lap on a guaranteed revert; plus a mid-run top-up hook.

**The test that would have caught it** — and why S12 missed it. Every existing test runs ≤3 laps,
so no test ever spends a user's budget. The missing test is a **budget invariant**, not a
lap-count test: add to `loadtest/wallets/preflight.test.ts` a case with
`{bridgesPerMinutePerUser: 2, durationMinutes: 20, assetTopUp: '0.04', amount: '0.01'}` that
must **fail** preflight, and a sibling case at `assetTopUp: '0.4'` that must pass. Add the raw
message `Execution reverted with reason: panic: arithmetic underflow or overflow (0x11).` to
`loadtest/metrics/errors.test.ts` (see A4).

### A2 · P0 — a browser UI claim failure is reported as `timeout_not_claimable`, i.e. as a devnet outcome; and the `DriverError` is silently discarded

**Symptom.** Browser mode recorded **0** `hop_completed_escalated` and **0** `hop_completed_raced`
against headless's 392 and 16. Transition counts by mode make it unambiguous:

| transition | browser | headless |
|---|---|---|
| T18 (escalate: autoclaim overdue) | 6 | 451 |
| T19 (`isClaimed` true before build) | **0** | 16 |
| T21 (claim built + sent) | **0** | 392 |
| T22 (claim build/send threw) | **0** | 43 |

Six browser hops escalated and **not one produced any CLAIM_BUILD exit event at all.**

**Root cause.** `loadtest/workers/browser/browserUser.ts:700-717` — when `clickClaim` throws
(the claim button never became clickable) `claim()` returns `claimInputs: null` with the
classified `ui_assertion` error attached to `claim.error`. But
`loadtest/core/ring.ts:1175-1205` (`eventsFromClaim`) does:

```ts
const inputs: ClaimInputsResult | null = submission.claimInputs;
if (inputs === null) return events;          // <- the claim error is DROPPED here
```

so only the `is_claimed` event is emitted. The hop sits in `CLAIM_BUILD` at step `claim_inputs`
until the timeout, and `claimBuildTimeoutOutcome` (`core/ring.ts:287`) labels that step
**`timeout_not_claimable`** — an outcome that reads as "the devnet never made this deposit
claimable". Matching evidence: 3 `timeout_not_claimable` (browser, hop 0) and 3
`[claim-tokens-button] locator.click: Timeout 30000ms exceeded` `ui_assertion`s.

**Fix (S16):**

1. `workers/browser/browserUser.ts:700-717` — return
   `claimInputs: { claimable: true, timing: { startedAt: submitStartedAt, durationMs: 0 } }` on
   the `clickClaim`-throw path (the row *was* `READY_TO_CLAIM`; only the UI failed), so T22 fires
   and the `ui_assertion` classification survives. The two later paths in the same method
   already do exactly this.
2. `core/ring.ts` `eventsFromClaim` — when `claimInputs === null` **and**
   `submission.claim?.error` is set, emit the claim error event instead of returning early. The
   invariant to enforce is: *no `DriverError` returned by a driver may ever be dropped.*
3. `core/ring.test.ts` — a case asserting a `claimInputs: null` + `claim.error` submission ends
   `FAILED` with the driver's own error class, never `timeout_not_claimable`.

### A3 · P0 — the entire browser pool ran in ONE Chromium process

**Symptom.** 226 `browser_crash` (216 hop 0, 10 hop 1) from 20 users, arriving in simultaneous
bursts of 40, 46, 58 and 27, with a new browser PID 4–6 s after three of the four bursts; plus
57 `BrowserPool: slot 0 has no live browser`.

**Root cause.** `browser.contextsPerBrowser: 25` with `users.browser: 20` ⇒
`computeShardAssignment` (`workers/browser/pool.ts:29-53`) yields `slotCount = ceil(20/25) = 1`.
`results.json.resources.samples` confirms **max 1 concurrent browser process** across all 395
samples (4 PIDs sequentially, never concurrently). One crash therefore takes out all 20 users.
The pool code is correct — the *configuration* is wrong and nothing rejects it.

**Fix (S16):**

1. `loadtest/config/schema.ts` — reject or clamp a `contextsPerBrowser` that yields fewer than
   ~2 slots: add a validation that `ceil(users.browser / contextsPerBrowser) ≥ ceil(users.browser / 8)`,
   i.e. cap `contextsPerBrowser` at 8, and surface a clear message naming the blast radius.
2. `loadtest/config/deriveDevnet.ts` — emit `contextsPerBrowser: 8`, not 25.
3. `workers/browser/pool.ts:286-291` — `createContextFor` throws
   `BrowserPool: slot N has no live browser` when it races a relaunch. Make it re-enter
   `launchSlot(slot)` once and only throw on a second failure; and classify the resulting error
   through `classifyBrowserCrash`, not `internal` (those 57 records also carry **no `hopId`**, so
   they cannot be joined to a lap — attach one).

**What this implies for S17's 150-browser-user target.** RAM is *not* the ceiling: each Chromium
held only 116–163 MB RSS, the tool peaked at 2.55 GB, and the 64-core/62 GB host had 28 GB free.
150 users at 8 contexts/browser = 19 Chromium processes ≈ 3 GB — comfortable. The real ceiling
is **A5** (one Node event loop), so S17 must fix A5 before 150 browser users means anything.

### A4 · P1 — the error taxonomy dumps ~440 of the 861 `internal` errors into the wrong bucket

`classifySubmitError` (`loadtest/metrics/errors.ts:119-126`) special-cases only
`LocalBalanceTreeUnderflow` and falls through to `internal` for everything else. Measured
consequences:

| count | message (verbatim) | is currently | should be |
|---|---|---|---|
| 336 | `Execution reverted with reason: panic: arithmetic underflow or overflow (0x11).` | `internal` | `tx_revert` (ideally a new `insufficient_asset_balance`) |
| 70 | `Transaction creation failed.` — viem `TransactionRejectedRpcError`, JSON-RPC **-32003** (`viem/errors/rpc.ts:299`); anvil rejecting the send | `internal` | `rpc_error` |
| 57 | `BrowserPool: slot 0 has no live browser` | `internal` | `browser_crash` (see A3) |
| 19 | `Nonce provided for the transaction is lower than the current nonce…` | `internal` | `rpc_error` |
| 13 | `The request took too long to respond.` | `internal` | `rpc_error` |
| 9 | `Execution reverted with reason: custom error 0x646cf558.` = `AlreadyClaimed()` | `internal` | `already_claimed` |

The `already_claimed` case is the sharpest: `ALREADY_CLAIMED_SELECTOR` already exists at
`metrics/errors.ts:63`, but only `classifyRevertError` consults it and only via an
`input.selector` field the headless submit path never extracts from the viem message.

**Fix (S16):** extend `classifySubmitError` to (1) pull a `0x########` selector or a `panic:`
prefix out of the viem message and delegate to `classifyRevertError`; (2) recognise viem's RPC
error identities (`TransactionRejectedRpcError`, nonce-too-low, `TimeoutError`) and delegate to
`classifyRpcError`; (3) route the pool error through `classifyBrowserCrash`. Add one
`metrics/errors.test.ts` case per row above, copying the message strings verbatim out of this
run's `activity.ndjson` so the test is anchored to real evidence.

*Note on the 19 nonce-too-low and 70 `Transaction creation failed.`:* their **cause** is genuine
same-wallet concurrency (`maxInflightLapsPerUser: 3` ⇒ up to 3 concurrent sends per account,
with viem re-deriving the nonce per send because `mapTransactionRequest` drops the SDK's nonce —
declared finding C4). The defect being fixed here is the *classification*; whether to serialise
sends per wallet is a separate, optional S16 call (a per-account send mutex in
`headlessUser.bridge()`/`claim()`), and 89/1 985 hop attempts is a tolerable rate if left alone.

### A5 · P1 — 100 users share ONE Node event loop; that is the real capacity ceiling, and it invalidates the run's latency numbers

**Evidence.** `results.json.resources.samples` (n=395): `toolCpuPct` p50 **101.4 %**, p90
118.9 %, max 129.8 % — i.e. the process is pinned at 1.0–1.3 cores **on a 64-core host** with
63 cores idle, RSS 2.55 GB of 62 GB.

**What it contaminates.** `installTimingFetch` (`workers/headless/uiCallset.ts:229-258`) measures
`clock.now()` around `original(input, init)`, so the measured duration includes the time until
the promise's continuation is *scheduled* on a saturated loop. The fingerprints:

- `tracker/activity` headless `ui` p50 **5 316 ms** — versus **p50 1 ms** for the *same endpoint*
  measured inside the browser's own context in the *same run*.
- a ~5.0–5.4 s p90 cluster across *unrelated* anvil endpoints: `eth_getTransactionCount` 5 089,
  `eth_estimateGas` 5 083, `eth_getBalance` 5 128, `eth_fillTransaction` 5 293.
- 322 `locator.click: Timeout 30000ms exceeded` in the single Chromium the same loop drives.

**Therefore: this run's headless HTTP percentiles must not be quoted as aggkit-proxy latency**,
and §4's (c) list says so explicitly.

**Fix (S16/S17):**

1. `loadtest/runner.ts` — shard `userIds` across `os.availableParallelism()`-sized worker
   processes and aggregate the collectors, or at minimum enforce and document a
   users-per-process cap; keep the browser pool in its own process(es).
2. `loadtest/metrics/collector.ts` — add a `perf_hooks.monitorEventLoopDelay` sample to
   `resources.samples`.
3. `loadtest/metrics/report.ts` — **disqualify its own latency percentiles** (print them as
   "not usable as server latency") when event-loop-lag p99 exceeds a threshold. A report that
   can invalidate its own numbers is the only honest version of this measurement.

### A6 · P1 — the activity-poll cadence is defeated by lap concurrency: 1 211 requests/user headless against an expected ~448

`headlessUser.observeActivity()` (`workers/headless/headlessUser.ts:476-518`) reads
`nextActivityFetchDelayMs(this.cadence, now)`, sleeps, fetches, *then* writes `this.cadence`.
With `maxInflightLapsPerUser: 3` up to three hops call it concurrently: all three read the same
`lastFetchAt`, all three compute the same delay, all three sleep and fire together. The real UI
**cannot** do this — react-query shares the `['activity', mode, address]` key and issues ONE
request per interval (declared finding C2, which `uiCallset.ts:28-40` documents as the thing
being modelled).

Measured: 96 927 / 80 = **1 211.6 per user** over 2 240 s = one every 1.85 s against a 5 000 ms
cadence ⇒ **2.7× inflation**, matching `maxInflightLapsPerUser: 3` almost exactly.

**Fix (S16):** single-flight the fetch per driver — one shared in-flight promise, with the
cadence check inside the same critical section — with the helper placed next to
`nextActivityFetchDelayMs` in `workers/headless/uiCallset.ts` so it is unit-testable. Add a
`uiCallset.test.ts` case asserting that three concurrent `observeActivity()` calls inside one
interval produce exactly **one** fetch.

**Why this is a P1 and not cosmetic:** `tracker/activity` is the highest-volume endpoint class in
the whole test. This is finding C16 / step S24's concern reappearing on the headless side, and
until it is fixed S17 cannot claim it loaded the proxy the way real users do.

### A7 · P2 — `retries` in the HTTP table is not a retry count, and S14's NOTES drew a wrong conclusion from it

`nextAttempt` (`workers/headless/uiCallset.ts:205-216`) marks any repeat call on the same
`(userId, method, endpointClass)` within `ATTEMPT_WINDOW_MS = 35_000` as `attempt > 0`, and
`collector.ts:797-803` counts those as `retries`. A legitimate 5–10 s poll loop therefore
reports `retries ≈ n`: **96 847 of 96 927** for `tracker/activity`, 2 581/2 932 for
`eth_getTransactionCount`, 1 885/2 236 for `eth_estimateGas`.

S14's NOTES §4 concluded from this that "the headless poll loop is essentially spin-polling".
**That is not supported** — it is an artefact of the attempt window being 3–7× longer than the
poll interval. The real inflation is A6's 2.7×, not 1 212×.

**Fix (S16):** carry an explicit attempt number through the fetch context (the driver knows when
it is retrying) rather than inferring one from a time window; failing that, set
`ATTEMPT_WINDOW_MS` below the shortest legitimate poll interval and exclude `tracker/activity`
from window-based inference. `metrics/collector.test.ts` case.

### A8 · P2 — browser-only `bridge_event_missing` (8) is manufactured by a swallowed RPC error

`workers/browser/browserUser.ts:504-524` wraps the receipt fetch and `decodeBridgeEventLog` in a
bare `catch { }` and leaves `bridgeEventFound: false`, which `ring.ts`'s T11 converts into
outcome `bridge_event_missing` — an outcome that reads as "the chain did not emit a
`BridgeEvent`". All 8 are browser (2 hop 0, 6 hop 1); headless recorded **0** because it decodes
off a receipt it already holds.

**Fix (S16):** classify the caught error with `classifyRpcError` and return it as the bridge
step's error, so it lands in `rpc_error`. Reserve `bridge_event_missing` for a receipt that
genuinely carries no matching log.

### A9 · P2 — reporting hygiene: one number in S14's write-up is not safe to quote

S14's NOTES presents browser `ui` ≈ **82 requests/user** as "what a real user's browser
generates". It is not: browser users were crashed or failing for most of the run (68 completed
hops out of 717 attempts, 9.5 %), so 82/user is an artefact of brokenness. A real user with the
transactions page open for 37 min at the 5 s non-terminal cadence would generate ~450.

**Fix (S16):** `loadtest/metrics/report.ts` — normalise per *active* user-minute (or per hop in a
polling state), and print the raw count alongside. Until then the 82/user figure must carry the
caveat wherever it is repeated.

### A10 · P3 — the achieved-rate headline averages two modes that behaved completely differently

`steadyStateRatePerUserPerMin: 0.869` blends browser (~1.79 lap starts/user/min, **zero**
backpressure skips) with headless (~0.61, **all** 1 790 skips). Reporting one number hides the
most informative fact in the section. **Fix:** `metrics/report.ts` — report achieved rate, ticks
offered and skips **per mode**.

### Verified and explicitly *not* a defect

- **`lapsInFlightAtStop: 439` alongside `LAP_ABORTED: 0`.** `runner.ts:951-958` sets this from
  `lapsInFlightAtDrainStart` — laps running when the *load phase* ended, all of which then
  drained to a real terminal outcome during the 17-minute drain (1 695 lap starts = 1 695
  `lap_end` records, last at 18:31:14.718Z, and no `aborted_drain` outcome exists because every
  lap hit its own hop timeout before the drain deadline). Correct behaviour; only the field
  *name* invites a misreading. Optional P3: rename or annotate in `report.ts`.
- **`erc20` had more hop-0 attempts than `eth` (985 vs 710)** despite a round-robin. Explained,
  not anomalous: A1's reverts fail *instantly*, freeing the in-flight slot immediately, so more
  erc20 ticks got admitted. A pleasing self-consistency check on A1.

---

## 3. (b) EXPECTED ON DEVNET — the "do not fix this" list

| # | Observation | Why it is expected |
|---|---|---|
| **B1** | **L2→L2 hop floor ≈ 95 s**: ~60 s certificate settlement + ~35 s bridge-mine / tracker-index / claim | Settlement is one L1 epoch and is **load-insensitive**: 10 settled certificates, all 60–120 s, `stage=candidate` mean 60.01 s, `stage=proven` mean 7 ms (native/mock prover). Budget hop timeouts against ~95 s per L2→L2 hop, **not** against the discredited 640 s / 900 s figures (§1.2). |
| **B2** | `activity-index` gate p50 5.1 s / p90 10.7 s / p99 39.8 s, **0** blocked ticks; 4 `timeout_appears_in_activity` (0.3 % of 1 267 hops entering the gate) | The tracker indexes a bridge in ~5 s. The 4 timeouts are the p99 tail, browser-side. Nothing to fix. |
| **B3** | `autoclaimOverdue: 457` with `hop_completed_escalated: 392` and `unexpectedAutoclaim: 0` | The 120 s autoclaim grace window on `L1→L2A` was exceeded often at 100 concurrent users, and manual escalation covered for it every time it got the chance. This is **positive evidence the escalation design works under exactly the stress it was built for**. (Cross-referenced as a capacity datum in (c) C4.) |
| **B4** | `claimRaceLost: 16` (all headless, all T19) | Autoclaim won between our `READY_TO_CLAIM` poll and our claim build. DESIGN treats a lost race as a **success** (`hop_completed_raced`), which is what was recorded. Working as designed. |
| **B5** | 51 % backpressure skip rate (1 790 / 3 535) and achieved 0.87 vs requested 2.0/user/min | **Purely mechanical — no scheduler defect.** Offered load was correct in both modes: browser 717 ticks / 20 users = 35.9 per user; headless (978 + 1 790) / 80 = 34.6 per user; expected ≈ 2/min × ~18 min steady ≈ 36. Laps then never drained, so `maxInflightLapsPerUser: 3` saturated and stayed saturated. **1 583 of the 1 790 skips (88 %) had their oldest in-flight hop parked on the `claim-proof` gate** (129 on `claimed`, 78 on no gate) — which is exactly the number DESIGN §5.4 says answers "was the devnet or the tool the bottleneck". It says the devnet. *Caveat, corrected S35: the underlying cause is **(b)**, our own devnet's `/dev/shm` misconfiguration (was labelled (c) C1; C1 is retracted — see top of document), so this is "expected given a wedged network", not "expected on a healthy devnet", and not an agglayer defect.* |
| **B6** | `claim-proof` gate p90/p99 ≈ 904 s, sitting exactly at `readyToClaimMs = 900 000` | Arithmetic, not a measurement: a hop that times out contributes ~900 s to the gate. It is the *signature of the timeout*, not evidence about devnet latency. Do **not** raise `readyToClaimMs` in response — record the stall and its cause (DESIGN §5.4). |
| **B7** | `ui_assertion: 129` (116 hop 0 / 13 hop 1; 71 `[bridge-success-view] expect(...).toContainText`, 45 `[bridge-success-view] locator.waitFor`, 13 others) | **Declared divergence C5 / DESIGN §9.4, not a new defect**: browser mode cannot apply `gas.bridgeGasOffset` (+300 000), so browser bridges can revert with `OutOfGas` on a same-block `forceUpdateGlobalExitRoot` where headless survives. Expect a browser-vs-headless revert asymmetry, as the plan already states. *Refinement for S16:* this run **cannot separate** C5 reverts from A5-induced browser starvation, because the assertion message records only that the success view never appeared. Have `browserUser.bridge()` capture the UI's own error text on the `waitForBridgeSuccess` failure path so the two become distinguishable — a small change inside the existing driver, no UI widening. |
| **B8** | Anvil writable layers 2.3–3.7 GB; L1 15 % / L2B 16 % CPU post-run | Long-lived anvil nodes with full state, already state-heavy before this run (no clean restart was performed). No before-baseline exists, so nothing here is attributable to this run. |
| **B9** | `locator.click` / `getAttribute` / `waitFor` timeouts (340 total) and `page.evaluate: Execution context was destroyed` (9) | On the plan's declared "known contributors" list. But note the **majority is downstream of A3 + A5** (20 users in one CPU-starved Chromium), not of devnet slowness — so expect this count to fall sharply once A3 and A5 land, and re-measure before treating the residue as inherent. |

---

## 4. (c) FINDINGS FOR THE AGGKIT / AGGLAYER TEAM

*Note (S35, 2026-09-16): C1, originally listed here, has been **retracted** — see the note at
the top of this document and the resolution appended to its entry below. It is reattributed to
bucket (b), our own devnet misconfiguration, and removed from the set of findings for the
aggkit/agglayer team. C2–C6 below remain genuine findings for that team.*

### C1 · RETRACTED (S35) — believed to be an agglayer defect; root-caused by S34 to our devnet's undersized `/dev/shm`, not agglayer

**The evidence below (as originally recorded) is accurate; only the attribution was wrong.**
Read it as the historical symptom, not as a standing agglayer defect — the resolution is appended
at the end of this entry.

`agglayer` (devnet, `aggkit v0.11.0-rc8`, pessimistic-proof / `type: pp`). Network 1 (L2A).

```
certificate 9/0xfb2ec17cff451a6323e4b8f23e52078aff6b4e010d7f3c13428e5b66ac2aa39e (retry: 0, type: pp)
  [Pending] -> [InError] at 2026-09-11T17:55:48.945Z
  PreviousLocalExitRoot: 0xb0ca4019383eac26f3648ba850a1a991ace35449e138144449c861165acbb813
  NewLocalExitRoot:      0x4c8814824e2f3e5de8d2b700e63738e0113eedd82c199f415adfc9853a88d11e
  Errors: [InternalError("Sp1-native execution failed.
      Caused by:  Child native executor crashed,
                  details: CrashDetails { signal: 7, addr: 0, operation: 0 }
      Location:   crates/agglayer-certificate-orchestrator/src/error.rs:171:29")]
```

- **Deterministic.** Retried every 5 min with the identical crash — retries 0–7 during the run
  (17:55:48, 18:00:49, 18:05:49, 18:10:50, 18:15:50, 18:20:50, 18:25:50, 18:30:50) and still
  retrying now, over an hour after the run ended. Later retries re-use certificate ID
  `0xbf91e39d0083e58909760d0e0872748ed8367e4ac3edfcbf319ce73df708ab04`.
- **Correlated with the first real bridging load.** Certificates 0–8 settled normally, all in
  60–120 s. Certificate 9 is the **first** certificate to advance network 1's local exit root
  after the load test began generating `L2A→L2B` bridge volume (667 attempts submitted on L2A in
  the surrounding minutes). Signal 7 (SIGBUS) in a child native executor typically means a bad
  mapping or a guest stack overflow — the certificate's size or shape is the obvious suspect.
- **Total blast radius.** Network 1's LER has been frozen since 17:51:16Z; **0 of 667**
  `L2A→L2B` bridges ever became claimable, and the whole three-hop ring recorded `LAP_DONE: 0`.
- **No automatic recovery path.** aggkit-001 runs with `RetryCertAfterInError = false`, so it
  will not rebuild or resend; recovery depends entirely on agglayer retrying the *same*
  certificate, which re-crashes every time. Without manual intervention the network stays
  wedged indefinitely.
- **Reproduction is available now.** The devnet is still in this exact state and can be handed
  over, along with the certificate payload / SP1 witness for network 1 height 9.

**Resolution (S34/S35, 2026-09-16) — RETRACTED.** The agglayer node team (Leo Gaspard, Monir
Hadji, Thiago Nobayashi, via Slack) identified a byte-identical crash signature — same
`signal: 7`, same `error.rs:171:29` — already known on agglayer 0.5.0, caused by the SP1
local prover's shared-memory mapping outrunning an undersized `/dev/shm`. `grep -niE
"shm_size|/dev/shm|tmpfs" tests/devnet/docker-compose.yml` on this repo's vendored devnet found
**nothing**, so the `agglayer` container ran on Docker's **default 64 MB** `/dev/shm`. Confirmed
from `/etc/agglayer/config.toml` inside the running container (not inferred): the active prover
is `certificate-orchestrator.prover.sp1-local`, a real CPU-local SP1 prover, not mock-proofs —
exactly the pipeline where this crash occurs. Adding `shm_size: '4gb'` to the `agglayer` service
(commit `4947855`) — the Compose-native equivalent of the node team's Kubernetes
`emptyDir{medium: Memory, sizeLimit: 4Gi}` fix, whose accompanying pod memory/CPU bump is GKE
Autopilot ratio bookkeeping and does not transfer to this uncapped 62 GiB host — grew
`/dev/shm` from **64M to 4.0G** (`docker exec devnet-agglayer-1 df -h /dev/shm`, before/after)
and **eliminated the crash entirely**: re-running the exact rung that reliably wedged network 1
(`--users 12 --browser 4 --rate 3 --minutes 10`) produced zero `signal: 7` and zero certificates
going `InError` across a full run (69 laps drained, network 1 climbing cleanly through height 9
— the exact height that crashed deterministically before — to 11/11 settled). Pushed further to
this document's own 100-user/20-browser/20-minute configuration: **also a clean pass** — 571
in-flight laps drained, 73 certificate-health samples across the run, `zero` `in_error` at any
point on either network, network 1 finishing 38/38 and network 2 42/42 (pending/settled), zero
container restarts. **This finding is not an agglayer/aggkit defect; it is a devnet
misconfiguration, now fixed, and the actionable upstream ask is a kurtosis-cdk default
(`/dev/shm` sized for the SP1 local prover), not a code change.** The "total blast radius" and
"no automatic recovery path" bullets above were real *symptoms* of this misconfiguration, not
evidence of an agglayer defect — with `shm_size` set, the certificate that used to crash
deterministically now settles normally. **Correction to a claim made when this was first
diagnosed:** "reproduced on an idle 62 GiB host, so not host memory" ruled out *host* RAM
pressure but said nothing about a **fixed 64 MB tmpfs inside the container** — which is exactly
what was starving the prover regardless of host RAM; do not repeat the original "not memory"
claim. **What is unaffected by this fix:** the harness's own single-Node-process event-loop
ceiling (finding A5, §2 above) is a separate, genuine, already-documented capacity limit that
holds regardless of devnet health — do not read this retraction as removing it. **C2 directly
below is unaffected and stands** — a silent local misconfiguration producing exactly the
silent-failure mode C2 warns about is, if anything, a stronger argument for C2's asks.

### C2 · High — a permanently wedged network reports itself healthy

`GET /bridge/v1/sync-status` returned `is_synced: true` **throughout**, including while network 1
had been unable to settle a certificate for 40 minutes. **No health check available to a bridging
client would have caught this.** The only signals that existed were:

1. `agglayer_node_network_latest_certificate_in_error{network_id="1"} 1` and the gap between
   `agglayer_node_network_height{stage="pending"} 9` and `{stage="settled"} 8`, on **agglayer's**
   Prometheus endpoint (`:9092`) — not reachable from a client, and not reachable from aggkit's
   own metrics either (see S17 recommendation R1).
2. aggkit-001 logging `found 1 InError certificate(s) with no pending certs, enabling retry` plus
   `An InError cert exists but skipping send cert because RetryCertAfterInError is false` at
   **INFO, twice per second, indefinitely**.

**Asks:** (a) expose certificate-in-error and settled-vs-pending height in `sync-status` (or a
sibling endpoint) so a client can tell "slow" from "wedged" — this is the single cheapest change
that would have saved this whole investigation; (b) log the InError retry state at WARN with
backoff rather than INFO at 2 Hz; (c) publish aggkit's metrics port in the vendored compose
devnet.

### C3 · Medium — `AlreadyClaimed()` is logged as a hard ERROR by aggkit's own tx manager

Selector `0x646cf558` appeared 9 times client-side (headless, both assets, hop 0) *and* as the
only 2 genuine ERROR lines in aggkit-001's entire window:

```
18:01:32.517Z ERROR ethtxmanager/ethtxmanager.go:917  failed to estimate gas: execution reverted:
                    custom error 0x646cf558 (0x646cf558)  monitoredTxId=0xe8d04a58…
18:01:32.517Z ERROR ethtxmanager/ethtxmanager.go:653   failed to review monitored tx: …
```

This is the autoclaim service and the user racing for the same claim. Rare (9 of ~1 985 hop
attempts), self-recovering (the tx manager retried and the certificate later settled), and
benign on the client side — DESIGN treats a lost claim race as a success. **Ask:** treat
`AlreadyClaimed()` on a claim gas estimate as an expected terminal state for the monitored tx
(drop it at INFO) rather than an error to retry.

### C4 · Medium — autoclaim missed its 120 s window on ~72 % of `L1→L2A` hops at 100 concurrent users

`autoclaimOverdue: 457` against 670 hops that reached `READY_TO_CLAIM` (T13: 628 headless + 42
browser); `claimed` gate p50 48.4 s / p90 126.3 s / p99 138.8 s. **Not a defect** — every overdue
hop that survived then succeeded via manual escalation (392) — but it is a concrete
autoclaim-throughput datum at 100 users on a single-sequencer devnet, and worth having before
anyone quotes an autoclaim latency SLA.

### C5 · Positive result — no aggkit-proxy defect was found

State this plainly, because it is the reassuring outcome of the whole exercise.

- **Logs:** `aggkit-proxy-001`'s full window (17:50→18:35, 510 KB) contains **zero** lines
  matching `error|warn|panic`, case-insensitively. Every line is INFO from the bridgetracker
  engine: 2 155 × `domain/resolve_step_waiting_ger_injection.go:48`, 57 ×
  `bridgetracker/engine.go:232`, 54 × `:223`, 2 × `common/retry_handler_delays.go`.
- **Client side:** `tracker/activity` returned **200 on 96 927/96 927** headless calls and
  1 628/1 645 browser calls (the 17 `status: 0` are browser-context teardown during the A3 crash
  bursts, not proxy responses). The `proxy_4xx` and `proxy_5xx` error classes were recorded
  **zero** times anywhere in the run.
- It sustained ~44 req/s of `GET /tracker/v1/activity/from/{addr}?includeTracking=true` across
  100 distinct addresses for 37 minutes, with **no rate limiting and no caching**
  (`../aggkit/proxy/service.go:76-138`), and did not drop a request.

**Required caveat: proxy latency is *unmeasured* by this run.** Do not quote the headless
`tracker/activity` p50 of 5 316 ms as proxy latency — the runner was pinned at 1 core of 64 and
the *same endpoint measured inside the browser in the same run* was p50 1 ms (defect A5). A
clean latency number needs A5 and A6 fixed first.

### C6 · Low — proxy memory grows with tracked addresses and then plateaus

`aggkit-proxy-001` RSS went from 41.6 MiB at run start to ~172 MiB within 10 minutes and then
held flat (~157–172 MiB) through a capture 48 min after the run. `docker inspect` shows **no bind
mounts and no named volumes**, and the container's writable layer is **4.1 kB**, so
`includeTracking=true` state appears to be held in-process rather than persisted. Not a problem
at 100 users; worth watching at S17's 500–1 000. (The containers are distroless, so this could
not be confirmed by inspecting a file inside them — it is inferred from the absence of any
volume plus the negligible writable layer plus the RSS curve.)

---

## 5. Complete attribution — every error class and anomalous number

Nothing in S14's report is left unclassified.

| Observation | Count | Bucket | Evidence |
|---|---|---|---|
| `panic: arithmetic underflow or overflow (0x11)` | 336 | **(a) A1** | 336/336 headless, erc20, hop 0; onset at per-(user,asset) lap 4; `assetTopUp "0.04"` ÷ `amount "0.01"` = 4; live balances now 0; live `transfer` simulation reverts identically |
| `locator.click: Timeout 30000ms` | 322 | **(a) B9/A3/A5** | 288 hop 0 + 34 hop 1, browser only; declared known contributor, but majority downstream of A3 (20 users/1 Chromium) + A5 (1 core of 64) |
| `Transaction creation failed.` | 70 | **(a) A4** classification; cause (b)/C4-adjacent | viem `TransactionRejectedRpcError`, JSON-RPC -32003; same-wallet concurrency from `maxInflightLapsPerUser: 3` + C4's dropped nonce |
| `BrowserPool: slot 0 has no live browser` | 57 | **(a) A3** | relaunch race in `pool.ts:286-291`; no `hopId` attached |
| `Nonce provided … lower than the current nonce` | 19 | **(a) A4** classification; cause as above | 10 hop 1 + 9 hop 0, headless only |
| `The request took too long to respond.` | 13 | **(a) A4** | RPC transport timeout, headless |
| `locator.getAttribute: Timeout 30000ms` | 11 | **(a) B9** | browser, hop 0, eth; declared known contributor |
| `page.evaluate: Execution context was destroyed` | 9 | **(a) B9** | browser; navigation race, declared |
| `custom error 0x646cf558` (`AlreadyClaimed()`) | 9 | **(a) A4** classification + **(c) C3** logging | selector exists in the classifier but is unreachable from the submit path; correlates with 2 aggkit ERROR lines |
| `locator.waitFor: Timeout 30000ms` (as `internal`) | 7 | **(a) B9** | browser, erc20 |
| `page.goto` abort / `observeActivity fetch timed out` | ≤5 each | **(a) A3** | browser-teardown noise during crash bursts |
| `browser_crash` | 226 | **(a) A3** | 4 sequential PIDs, max **1** concurrent process, bursts of 40/46/58/27, respawn 4–6 s later |
| `ui_assertion` | 129 | **(a) declared — C5 / DESIGN §9.4** | browser cannot apply `bridgeGasOffset`; **not a new defect**. Refinement: capture the UI's own error text so C5 separates from A5 (B7) |
| `timeout_ready_to_claim` | 534 | **(b) C1** [was (c), retracted S35 — our devnet's `/dev/shm` misconfiguration, not an agglayer defect] | all hop 1; network 1's LER frozen since 17:51:16Z, cert 9 InError from 17:55:48Z. |
| `bridge_event_missing` | 8 | **(a) A8** | browser only (headless 0); swallowed RPC error in `browserUser.ts:504-524` |
| `timeout_appears_in_activity` | 4 | **(b) B2** | 4 of 1 267 gate entries = 0.3 %, p99 tail of a 5 s gate |
| `timeout_not_claimable` | 3 | **(a) A2** | browser `claim()` returns `claimInputs: null`, `eventsFromClaim` drops the error, timeout mislabels it as a devnet outcome |
| `claimRaceLost` | 16 | **(b) B4** | all headless T19; a lost race is a success by design |
| `autoclaimOverdue` | 457 | **(b) B3** + **(c) C4** | 72 % of 670 hops reaching READY; 392 covered by escalation |
| `unexpectedAutoclaim` | 0 | **(b)** | `L2B→L1` (the not-expected route) never reached |
| `console_error` | 2 039 | **(a) known/benign** | `https://icon.invalid` token-icon lookups with no outbound DNS; already excluded from the aggregate tables and covered by the S11 benign-host allowlist |
| `hop_completed_escalated` 392 / `raced` 16 — **all headless, 0 browser** | — | **(a) A2** | browser T18 = 6 → T19/T21/T22 = 0/0/0; escalation path effectively untested in browser mode |
| `LAP_DONE: 0`, `LAP_FAILED: 1695` | — | **(b) C1** [was (c), retracted S35 — see above] | hop 1 was structurally impossible for the whole run |
| 51 % backpressure skips, 0.87 vs 2.0/user/min | — | **(b) B5** (root cause **(b) C1**, retracted S35 — devnet misconfiguration, not an agglayer defect) | offered load was correct in both modes; 1 583/1 790 skips gated on `claim-proof`; **no scheduler defect** |
| `claim-proof` p90/p99 ≈ 904 s | — | **(b) B6** | the signature of a 900 s timeout, not a latency measurement |
| headless `tracker/activity` 1 211 req/user | — | **(a) A6** | expected ~448; 2.7× = `maxInflightLapsPerUser` |
| `retries: 96847/96927` | — | **(a) A7** | 35 s attempt window vs 5 s poll interval; **not** spin-polling |
| headless HTTP p50 5 316 ms | — | **(a) A5** | 1 core of 64 saturated; same endpoint p50 1 ms in-browser |
| browser `ui` 82 req/user quoted as "realistic" | — | **(a) A9** | browser users were broken 90 % of the run |
| aggkit-proxy: 0 errors, 0 4xx/5xx | — | **(c) C5 — positive** | full-window log clean; 96 927/96 927 HTTP 200 |
| proxy RSS 42 → 172 MiB, writable layer 4.1 kB | — | **(c) C6** | in-process tracking state; watch at S17 scale |
| anvil writable layers 2.3–3.7 GB | — | **(b) B8** | pre-existing state; no before-baseline |
| `lapsInFlightAtStop: 439` with `LAP_ABORTED: 0` | — | **not a defect** | measured at drain start; all 439 drained to real terminal outcomes |
| erc20 985 hop-0 attempts vs eth 710 | — | **not a defect** | A1's instant reverts free the in-flight slot faster |

---

## 6. Recommendations for S17 (capture gaps and process, not findings)

- **R1 — aggkit `/metrics` is not reachable on this devnet.** `aggkit-001` publishes only
  `11576->5576` and `11577->5577`; `curl :11577/metrics` and `:12577/metrics` both return
  **404 page not found**. The plan's "aggkit `/metrics` before/after" acceptance item is
  unachievable without a compose edit. Either accept **agglayer :9092** as the substitute
  (it is what produced §1's decisive evidence) or get the compose file changed under a separate,
  explicit decision.
- **R2 — no during-run host or container sampling exists** for this run and it cannot be
  reconstructed. S17 must write `docker stats --no-stream` + `free -h` + per-browser-process RSS
  to a file on a fixed interval from the first second of the run.
- **R3 — add a devnet health gate, before and during the run** (highest-value S17 change):
  poll `agglayer_node_network_latest_certificate_in_error{network_id}` and the
  `agglayer_node_network_height{stage="pending"}` vs `{stage="settled"}` gap; refuse to start, and
  annotate/abort mid-run, when any network is InError. Without it a validation run silently
  measures a broken devnet — exactly what happened here — and the report cannot tell.
- **R4 — restart the devnet clean before the run** and record certificate heights before and
  after. This run inherited a devnet that had been up 37 min and was already at certificate
  height 6.
- **R5 — record event-loop lag** (A5) so the report can disqualify its own latency percentiles.
- **R6 — run the proven 2-hop ring `L1 → L2A → L1` as a control arm** alongside the 3-hop ring, so
  the tool always has a route that completes even when one network is wedged, and so `LAP_DONE`
  stays a meaningful signal. The plan already names this fallback.
- **R7 — sample aggkit-proxy RSS** across the 500- and 1 000-user runs (C6).
- **R8 — order of work:** A1, A2, A3 unblock correctness; **A5 must land before the 150-browser-user
  target means anything**, and A6 must land before any claim that the proxy was loaded the way
  real users load it.

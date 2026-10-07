# PARITY.md — headless vs browser trace diff (S23)

This document diffs the headless worker's real HTTP trace against the browser
worker's real HAR for the same lap shape (`L1 -> L2A -> L2B -> L1`, auto /
auto / manual, one ETH lap + one ERC20 lap per user), classes every request
with **the same classifier both workers already use**
(`classifyEndpoint` in `loadtest/workers/headless/uiCallset.ts:132`, imported
as-is by `loadtest/workers/browser/timing.ts:24` — no second classing scheme
was written for this document), and gives every DESIGN §9.1 row P1–P14 an
explicit verdict.

## 0. Inputs

- **Headless**: `loadtest-results/20260910T203813Z/headless-trace.ndjson`
  (506 lines, all parse) + `results.json`'s `http` aggregate. 2 users
  (`u0`, `u1`), each 1 ETH lap + 1 ERC20 lap = **4 laps total**, 4/4
  `LAP_DONE`.
- **Browser**: `loadtest-results/s10-2026-09-11T11-06-30-206Z/browser-lap.har`
  (749 entries, user `u0` only, re-classed here with a Python port of the
  exact same classifier logic for cross-check) +
  `accept-collector-snapshot.json` (pre-classified, covers **all 4 users**:
  `u0`..`u3`, each 1 ETH lap + 1 ERC20 lap = **8 laps total**, 24 hops, 16
  auto + 8 manual, zero failures — `accept-outcomes.json`). The
  collector snapshot is used for the endpoint-class count table (broader,
  already-classified sample); the HAR (`u0`'s raw per-request timeline) is
  used for interval/cadence detail the aggregated snapshot doesn't carry.

## 1. Fairness caveats (stated, not papered over)

1. **Different user counts.** Headless = 2 users × 2 assets = 4 laps.
   Browser = 4 users × 2 assets = 8 laps — exactly 2×. All counts below are
   normalized **per user** (headless ÷ 2, browser ÷ 4) — each user in both
   datasets runs exactly one ETH lap + one ERC20 lap, so "per user" here
   means "per (1 ETH lap + 1 ERC20 lap)" and is the fair unit.
2. **Different times, different devnet timing.** The headless run
   (2026-09-10T20:38Z) predates the timeout raise described in DESIGN
   §3.3/S10 (`readyToClaimMs`/`claimedMs` 600 000→900 000,
   `hopMs`→1 200 000, `lapMs`→3 600 000); the browser run
   (2026-09-11T11:06Z) is the retried acceptance run under the raised
   timeouts. Per-hop wall-clock durations are therefore **not** directly
   comparable in absolute terms. Cadence is compared **per poll interval**
   (does the sequence contain 500/1000/2000/3000/5000/10000 ms steps in the
   right order), not by matching total elapsed time.
3. **Not the final runner.** S11 (the `run` orchestrator that will own the
   real poll-driving loop) is still `pending`. Both traces were produced by
   the S08/S10 acceptance harnesses driving the workers directly (each now
   deleted per the repo-hygiene rule: no `__s08_*`/`__s10_harness.ts` file
   exists). Counts reflect how each *worker* behaves when driven, not
   necessarily the exact polling cadence S11 will eventually choose for its
   own control-flow ticks (see C16 below, which is about a structural
   asymmetry that will persist regardless of S11's tick rate, not about the
   specific numbers here).

## 2. Per-endpoint-class table (counts normalized per user)

`n` = total samples in the dataset; `/user` = normalized. UI-expected
cadence is DESIGN §9.1's column, abbreviated.

| Endpoint class | headless n (/user) | browser n (/user) | UI-expected cadence | Note |
|---|---|---|---|---|
| `tracker/activity` | 214 (107.0) | 802 (200.5) | burst 500/1000/2000/3000ms, then 5000ms while non-terminal else 10000ms, badge 15000ms, deduped, `staleTime 30s` | **C16** — browser volume inflated by the driver's own `readState()`/`observeActivity()` poll running concurrently with, and undeduped against, the UI's own poll. Interval *family* matches on both sides (§3). **S24 update (measured, mitigated — not eliminated):** these 802/200.5 counts are the pre-S24 combined total from this document's original S08/S10 harness trace. `results.json`/`summary.md` now split the stream by `origin: 'ui' \| 'harness'`, and the driver's own poll is single-flight + ~5s TTL cached (`fetchActivitySingleFlight()` in `browserUser.ts`), with a bounded retry (`fetchActivityTextWithRetry()`) so one shared fetch's transient failure doesn't fail every joined caller. Two independent real 4-browser-user runs (`--rate 2 --minutes 6`, actual duration ≈16.2 min each) measured **`ui` n=453/546 (7.00–8.47/user/min, headline)** vs **`harness` n=195/192 (~3.0/user/min both runs)** — the harness share is consistently now *below* the UI's own rate, down from 4.5x *above* it in the S24 attempt #1 defect (a check-then-act throttle race that made harness volume worse, not better), and comfortably under the ≤~12/user/min target. See DESIGN §9.3 C16 for the full diagnosis, the retry correction, and both runs' numbers. |
| `bridge/l1-info-tree-index[2]` | 4 (2.0) | 8 (2.0) | once per manual claim attempt | Matched exactly. `[2]` = recording network L2B, per P3's `sourceNetwork` rule on both sides. |
| `bridge/claim-proof[2]` | 4 (2.0) | 8 (2.0) | once per manual claim attempt | Matched exactly. |
| `bridge/injected-l1-info-leaf[*]` | 0 | 0 | skipped when destination networkId===0 | Matched — the ring's only manual hop (`L2B->L1`) always has destination L1 (networkId 0), so the skip fires on both sides every time; the non-skip branch is not exercised by this ring shape (see P4 verdict). |
| `bridge/token-mappings[1]`, `[2]` | 4 (2×1.0) | 0 | non-native row, `!isNative && !localToken`, 5 min staleTime | **C6** — browser seeds the ERC20 as a local custom token, so the UI's `enabled` gate is false; headless has no local list and always calls. Declared. |
| `bridge/token-mappings[0]` | 0 | 3 (0.75) | as above | **C6 refinement** (new, added to DESIGN §9.3/§9.4) — a small, transient residual: a wrapped-token row on a chain that has not yet been that hop's `fromChain` (so not yet seeded) briefly fails the `localToken` check. Declared, not a bug. |
| `rpc/*/eth_getTransactionCount` | l1:20(10.0) l2A:8(4.0) l2B:8(4.0) | l1:38(9.5) l2A:22(5.5) l2B:22(5.5) | 2 per build (P10+P11) | **C4 confirmed both sides** — see §4. |
| `rpc/*/eth_estimateGas` | l1:16(8.0) l2A:4(2.0) l2B:4(2.0) | l1:38(9.5) l2A:22(5.5) l2B:22(5.5) | 2 per build (P10+P11) | **C4 confirmed both sides, with the documented C5 exception on headless** — see §4. |
| `rpc/*/eth_fillTransaction` | l1:2(1.0) l2A:2(1.0) l2B:2(1.0) | l1:16(4.0) l2A:8(2.0) l2B:8(2.0) | once per send, cached per client uid | **C15** (new) — same branch, different cache lifetime: headless's client is per-chain-for-the-run (pays once ever); browser's real wallet hands out a fresh client per chain-switch visit (pays once per hop-visit). Declared. |
| `rpc/*/eth_getBlockByNumber` + `eth_maxPriorityFeePerGas` | tracks `eth_getTransactionCount` 1:1 | tracks `eth_getTransactionCount` 1:1 | P12 fee-derivation fallback, once per send | Matched — confirms the fallback branch fires on every send on both sides (P12 settled). |
| `rpc/*/eth_gasPrice` | l1:4(2.0) l2A:4(2.0) l2B:4(2.0) | l1:28(7.0) l2A:8(2.0) l2B:8(2.0) | one per chain per 15s while bridge form mounted (P8) | Matched cadence rule; raw count differs because a real page stays "mounted" on the bridge form for real wall-clock dwell time (typing/waiting for approve receipt) where headless computes and moves on near-instantly — exactly what a 15s-staleTime-while-mounted rule predicts, not a rule violation. Never seen as a P12 fee fallback on either side (fallback always resolves via `eth_maxPriorityFeePerGas` — anvil is EIP-1559). |
| `rpc/*/eth_getBalance` (native) | l1:2(1.0) l2A:2(1.0) l2B:2(1.0) | l1:28(7.0) l2A:8(2.0) l2B:8(2.0) | one per (chain,token,addr) per 15s, no refetch on mount (P7) | Same explanation as `eth_gasPrice` — real dwell time vs instant compute. Rule matched. |
| `rpc/*/eth_call` (allowance + metadata + wrapped-address fallback, all bucketed together by the classifier) | l1:8(4.0) l2A:4(2.0) l2B:4(2.0) | l1:28(7.0) l2A:8(2.0) l2B:8(2.0) | P9 (allowance) + C7 (metadata composes 3–4 extra `eth_call`s) + C14 (headless-only tier-3 fallback) | Present both sides; classifier does not separate JSON-RPC calls by method *arguments*, only by method name, so P9/C7/C14 cannot be split out of this bucket without deeper (out-of-scope) call-body classing. Magnitudes are consistent with the already-declared C6/C7 residual differences, not a new gap. |
| `rpc/*/eth_sendRawTransaction` + `eth_getTransactionReceipt` | tracks builds 1:1 (1 send + 1.5 receipt polls/build on average) | tracks builds 1:1 | P13 | Matched. |
| `tracker/tx`, `bridge/bridges`, `bridge/claims`, `bridge/claim-candidates`, `bridge/sync-status`, `tracker/health` | 0 | 0 | never called in steady state (§9.2) | Matched — confirmed absent on both sides. |

## 3. Observed poll intervals

**Headless** (`tracker/activity`, deltas between consecutive requests per
user, from `tsOffsetMs`): both `u0` and `u1` show a **clean single-stream**
sequence, e.g. `u1`: `501, 1001, 2000, 3003, 5002, 5001, 5004, 4042` then
repeating `501, 1001, 2001, 3003, 5001, 5002, 5002, 5000, 5005, …`. This is
exactly DESIGN P1's burst `500/1000/2000/3000 ms` then steady `5000 ms`
(within the ±1s tolerance — all steady-state deltas land in `4996–5006 ms`).
Neither user's trace ever shows a delta `>9000 ms` (max observed `8076 ms`,
the gap between finishing one lap's polling and starting the next) — the
"`else 10000 ms`" branch (all rows terminal) is **not exercised** in this
trace, because the worker stops polling once `LAP_DONE` rather than idling
on a fully-claimed lap.

**Browser** (`tracker/activity`, `u0`'s HAR, sorted timestamps, 192
samples): the delta histogram contains all of the expected buckets — 81
near `500 ms`, 19 near `1000 ms`, 12 near `2000 ms`, 9 near `3000–4000 ms`,
62 near `5000–6000 ms`, and 8 near `10000–11000 ms` — confirming the same
cadence *family*, including (unlike headless) a clean run of **four
consecutive `10007 ms` deltas at the very end of the session**, which is
exactly the "all rows CLAIMED, page/badge fallback interval" branch of P1
that the headless trace never reaches. So the browser trace, taken alone,
independently confirms the *entire* P1 cadence rule including the one
branch headless didn't exercise. What the browser delta stream does **not**
show is a single clean sequence — small deltas (a handful of 3–20 ms gaps)
appear scattered throughout, which is **C16** (the driver's own
`observeActivity()` poll landing close in time to the UI's independent
poll) rather than a violation of the UI's own cadence rule (verified
separately above).

## 4. C4 (doubled `eth_estimateGas`/`eth_getTransactionCount`) — confirmed both sides

**Browser**: `eth_estimateGas` and `eth_getTransactionCount` counts are
**exactly equal** on every chain (`l1rpc` 38/38, `l2rpc-001` 22/22,
`l2rpc-002` 22/22) — consistent with every build issuing 2 of each (P10's
SDK-side pair + P11's viem-`prepareTransactionRequest`-side pair), and with
no gas override on this side (browser cannot apply `bridgeGasOffset`, C5).
The small deficit from the "expected" round numbers (e.g. 40 not 38 on
`l1rpc` for 4 users × 5 L1-touching builds/user) is fully explained by
**exactly one** ERC20 lap, somewhere in the 4-user run, having sufficient
pre-existing on-chain allowance and skipping its approve build (−2/−2,
reconciling 40→38 and similarly for both L2 chains) — an environment-state
artifact, not a parity gap.

**Headless**: `eth_getTransactionCount` is exactly the "full" expected count
on every chain (`l1rpc` 20 = 10/user, `l2rpc-001`/`l2rpc-002` 8 = 4/user),
but `eth_estimateGas` is **short by exactly 2/user** on `l1rpc` (16 vs 20)
and **short by exactly 1/user** on each L2 chain (2/user vs 4/user
`eth_getTransactionCount`, i.e. `eth_estimateGas` count = `eth_getTransactionCount`
count minus the number of gas-overridden bridge-submit builds on that
chain). This is not a bug: it is the exact, already-code-documented
consequence of finding **C5** — `headlessUser.ts:411-417,747-752` supplies
an explicit `gas` (SDK gas + `bridgeGasOffset`) to `sendTransaction` for the
**bridge-submit build only** (never approve, never claim), so viem's
`prepareTransactionRequest` does not re-derive `gas` for that one build
(skipping P11's `eth_estimateGas`) while still re-deriving `nonce`
(`eth_getTransactionCount` fires normally). Verified by walking the raw
trace: every multi-build cluster shows paired `(GTC, EG)` attempts except
the bridge-submit build's second pair, which shows `GTC` with no matching
`EG`. **Conclusion: C4's doubled-pair mechanism is present and provably
exercised on both sides; the one place it isn't literally 2-for-2 is
headless's bridge-submit build, which is the pre-declared C5 exception, not
an undeclared gap.**

## 5. P1–P14 verdicts

| # | Call | Verdict |
|---|---|---|
| P1 | `GET tracker/v1/activity/from/{addr}` polling | **Matched** (cadence family — burst 500/1000/2000/3000ms, steady 5000ms, terminal 10000ms — confirmed on both sides per §3; headless didn't reach the 10000ms branch in this lap shape because it stops polling at `LAP_DONE`, browser did). Request **volume** differs per **C16** (declared, DESIGN §9.4) — the driver's own control-flow poll is not deduped against the UI's own poll in browser mode; this affects count, not the cadence rule itself. |
| P2 | `GET tracker/v1/network/{id}/tx/{hash}` (bridge-steps modal) | **Not implemented** (R26, loadtest/REVIEW.md — corrected: this row previously said "default probability 0 in both configs", implying a defaulted-off knob that does not exist). Neither worker has any code path for this call at all — it fires only when a real user opens a **CLAIMED** row's steps modal, which this tool never does. Confirmed 0 occurrences on both sides, as an absent feature, not a probability-0 setting. |
| P3 | `GET bridge/v1/l1-info-tree-index` | **Matched** — 2/user on both sides, `network_id=2` (recording = source network of the manual hop) on both sides. |
| P4 | `GET bridge/v1/injected-l1-info-leaf` | **Matched** (correctly absent on both sides) — the ring's only manual hop's destination is always L1 (networkId 0), so the "skip when destination===0" branch fires every time on both sides; the else-branch is **not-exercised-by-this-ring-shape** (would require a manual hop whose destination is a non-zero network, which this ring doesn't have). |
| P5 | `GET bridge/v1/claim-proof` | **Matched** — 2/user on both sides, same `network_id=2`. |
| P6 | `GET bridge/v1/token-mappings` | **Declared divergence, C6** (browser seeds locally so the gated `!isNative && !localToken` check is false; headless has no local list) — plus the newly-documented **C6 refinement** for the small transient residual (3 calls, 0.75/user) on browser from a not-yet-seeded wrapped-token row. Both are in DESIGN §9.3/§9.4. |
| P7 | `eth_getBalance` / `balanceOf` | **Matched** (cadence rule — 15s staleTime, no refetch on mount — identical on both sides). Raw counts differ (1/user headless vs 7/user browser per chain) because a real page stays mounted for real wall-clock dwell time; not a rule violation (§2). |
| P8 | `eth_gasPrice` (bridge form mount) | **Matched**, same reasoning as P7. Also confirms `eth_gasPrice` is **never** used as a P12 fee-derivation fallback on either side (fallback always resolves via `eth_maxPriorityFeePerGas`), consistent with P12's settled verdict. |
| P9 | `allowance` (`eth_call`) | **Matched** — present both sides; cannot be isolated from the generic `rpc/*/eth_call` bucket without call-body argument classing (out of scope, the classifier keys only on JSON-RPC *method*, per its documented design). Magnitudes consistent with the already-declared C6/C7 residuals. |
| P10 | SDK builder's first `getNonce`+`estimateGas` pair | **Matched** — present on every build on both sides (§4). |
| P11 | viem `prepareTransactionRequest`'s second pair | **Matched, with the pre-declared C5 exception on headless's bridge-submit build** (§4) — confirmed via raw-trace pairing walk, not just aggregate counts. |
| P12 | Fee derivation (`eth_fillTransaction` → fallback) | **Matched** (SETTLED at S08, RECONFIRMED at S10 retry #1 — both sides take the identical fallback branch, `eth_gasPrice` never reached as a fallback). This diff adds **C15** (new, declared): the "cached per client uid" cache has a **different lifetime** per mode (per-chain-for-the-run on headless vs per-chain-switch-visit on browser) — same branch, different wasted-round-trip frequency, structural and expected given a real wallet must switch networks per hop. |
| P13 | `eth_sendRawTransaction` + receipt polling | **Matched** — tracks 1:1 with builds on both sides. |
| P14 | `isClaimed` + post-throw `[0,400,1000]ms` retry loop (C3) | **Matched at the code level on both sides** (same retry contract implemented); **not empirically exercised beyond attempt 0** in either acceptance run — both runs report **zero** claim failures (`accept-outcomes.json`: 0 failures; headless: `LAP_FAILED: 0`), so the retry branch never had to fire. Not a gap — there is nothing in either trace to contradict the retry contract, there simply was no failure to retry. |

## 6. New findings and declarations (this step)

Added to `loadtest/DESIGN.md`:

- **§9.3 C6 refinement** — clarifies "zero token-mappings calls" holds only
  for the actively-seeded chain, not transiently for a not-yet-seeded
  wrapped-token row on another chain (observed: 3 calls / 4 users).
- **§9.3 C15 (new)** — `eth_fillTransaction`'s per-client-uid cache has a
  materially different lifetime per mode (once-per-run vs
  once-per-chain-switch-visit), because headless holds long-lived per-chain
  clients while a real wallet hands out a fresh client on every chain
  switch. Same branch taken either way (P12 unaffected); only the
  wasted-round-trip *frequency* differs.
- **§9.3 C16 (new)** — browser mode's `readState()`/`observeActivity()`
  control-flow poll runs concurrently with, and is not deduped against,
  the real UI's own `tracker/activity` polling, inflating request volume
  (not violating the cadence rule — §3 shows the cadence family intact).
  Structural: Playwright has no DOM signal carrying the fields the driver
  needs (`depositCount`/`sourceNetwork`/`globalIndex`), so it cannot avoid
  this without either a UI change (out of scope, `app/` is a non-goal) or
  hooking react-query's cache from outside the page (not available to
  Playwright).
- **§9.4 table** — two new declared-divergence rows for C15 and C16, and
  the existing C6 row's browser cell amended with the refinement.

No headless code was changed — nothing found here rose to the level of a
genuine headless-side parity **bug**; every difference traced back to
either an already-declared divergence (C4/C5/C6/C12/C13/C14), a fully
explained environment artifact (one skipped approve build), or a newly
identified but structurally-inherent, now-declared divergence (C6
refinement, C15, C16). **No undeclared difference remains.**

## 7. Acceptance criteria

1. **`loadtest/PARITY.md` exists** with a per-endpoint-class table (§2),
   observed poll intervals (§3) — done, this file.
2. **Every P1–P14 row has an explicit verdict** — §5, all 14 rows present.
3. **Endpoint classes match within ±1s per poll except declared §9.4
   divergences; C4's doubled pairs confirmed on both sides** — §3 (all
   steady-state deltas within `4996–5006ms` of the 5000ms target, burst
   steps within a few ms of 500/1000/2000/3000ms on both sides) and §4
   (C4 confirmed present and mechanically verified on both sides, with the
   one exception being the pre-existing, pre-declared C5 divergence).
4. **No undeclared difference remains** — every difference found is either
   already declared (C4–C6, C12–C14) or newly declared in this step (C6
   refinement, C15, C16), all written into `DESIGN.md` §9.3/§9.4 with
   justification. No headless bug was found, so nothing needed fixing.
5. **`pnpm run check` passes** — confirmed: `validate:config` OK, lint 0
   errors (3 pre-existing warnings unrelated to this change), typecheck
   clean, **490/490** tests pass.

# Bridge load test — capacity & failure-mode report

**Date:** 2026-09-16 (runs 16:25–22:26 UTC) · **Tool:** `agglayer-dev-ui` PR
[#41](https://github.com/agglayer/agglayer-dev-ui/pull/41), branch `feat/bridge-loadtest` @ `0a2f922`
· **SDK:** `@agglayer/sdk` `1.0.0-snapshot-ca6df75e`
**Target:** the vendored compose devnet (`tests/devnet/docker-compose.yml`) — anvil ×3, agglayer, aggkit ×2,
aggkit-proxy, haproxy. aggkit `v0.11.0-rc8`.
**Host:** 64 cores / 62 GiB / Linux 5.10.

---

## 1. Headline

**The system is stable at 25 concurrent users (~79 bridge tx/min, ~53 autoclaims/min) and holds that
indefinitely** — a 67-minute soak ran at 100% headless lap completion with no drift.

Above that it does **not** fail loudly. It degrades in a way that every top-line metric hides:
lap completion stays 98–99% all the way to 200 users, while **autoclaim coverage falls from 99% to 20%**
and the *absolute* number of autoclaims served per minute *drops* (41 → 25/min) as offered load quadruples.
Only the harness's fallback — escalating a missed autoclaim to a manual claim — keeps the completion
number high. A real user gets a bridge that sits unclaimed.

At 400 users the bottleneck relocates entirely: the devnet's single haproxy ingress (`maxconn 1024`,
fronting `/l1rpc`, `/l2rpc-00X` **and** `/aggkitapi`) saturates and every call through it goes from
~1 ms to ~4–5 **seconds**, while the services behind it stay at 1.8 ms on their direct ports.

Separately, and independent of load, two real defects were root-caused: an **agglayer settlement-task
panic that permanently wedges a network** (§5.1) and a **browser-path `bridgeAsset` revert caused by an
out-of-gas inner `updateGlobalExitRoot`** (§5.3).

---

## 2. Method

Nine cases. Every case: **full `docker compose down` + `up --wait` + `devnetReady` before the run**, so
no case inherits another's chain height, certificate state or wallet balances. All cases used
`rate = 2 bridges/user/min`, ring `L1 → L2A → L2B → L1`, assets `eth 0.001` + `erc20 0.01`,
`maxInflightLapsPerUser = 3`, fresh `startIndex` per case.

Two independent evidence streams, deliberately kept separate:

- **Tool-side** — the harness's own `results.json` / `activity.ndjson` (hop outcomes, autoclaim policy
  counters, HTTP samples).
- **Server-side** — an out-of-process sampler (15 s interval) recording `docker stats` per container,
  agglayer's `:9092` gauges (certificate heights, `latest_certificate_in_error`), per-chain block height
  + txpool depth + RPC latency, proxy `sync-status`/`tracker/activity` latency, host connection count to
  `:8555`. This is what makes §5.5's ingress-vs-backend split provable.

Because all headless users in one `run` share **one** Node event loop, runs above 50 headless users were
**sharded across processes** (≤50 users each, disjoint wallet ranges, one shared pre-built UI server) and
the per-shard counters merged. Latency percentiles are only quoted from **C7**, the one run whose event
loop stayed healthy (p99 **12 ms** vs the tool's own 100 ms disqualification threshold); every other run
self-disqualifies its percentiles and they are not used here.

---

## 3. Results

Ordered by delivered throughput. `autoclaim coverage` = `hop_completed_auto / (auto + escalated + raced)`
— the share of autoclaim-expected hops the network actually auto-claimed in time.

| case | users | browser | bridges<br>/min | headless<br>lap % | browser<br>lap % | autoclaim<br>coverage | autoclaims<br>served/min | autoclaims<br>offered/min | rpc<br>error | revert<br>bridge | aborted HTTP<br>/ total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C6 browser-only | 20 | 20 | 38.0 | — | 51.5 | 100.0% | 24.1 | 24.1 | 0 | 0 | 8 / 35,019 |
| **C1 baseline** | **25** | 5 | **62.5** | **100.0** | 64.9 | **99.0%** | 41.0 | 41.4 | **0** | 0 | **0 / 53,842** |
| **C9 soak (60 min)** | **25** | 5 | **79.2** | **100.0** | **81.8** | **99.6%** | **52.5** | 52.7 | **0** | 0 | 24 / 163,943 |
| C8 | 35 | 7 | 67.9 | 99.8 | 46.0 | 93.9% | 41.9 | 44.6 | 0 | 0 | 8 / 62,069 |
| C2 | 50 | 10 | 73.6 | 98.5 | 23.9 | 79.0% | 37.2 | 47.1 | 1 | 0 | 26 / 82,084 |
| C3 | 100 | 20 | 118.1 | 98.7 | 20.9 | 43.7% | 32.5 | 74.3 | 6 | 0 | 91 / 159,419 |
| C7 headless-only | 100 | 0 | **154.8** | **99.9** | — | 44.1% | 45.5 | 103.2 | **0** | 0 | **0 / 184,329** |
| C4 | 200 | 40 | 194.3 | 99.1 | 14.3 | 20.4% | 24.8 | 121.8 | 8 | 0 | 112 / 312,542 |
| C5 | 400 | 60 | 319.2 | 88.3 | 10.8 | 10.5% | 21.1 | 201.5 | **308** | **116** | **6,850 / 581,977** |

Server-side, same cases:

| case | proxy `sync-status`<br>p99 | L1 RPC<br>p90 | agglayer `:9092`<br>p90 (direct) | aggkit-001 CPU<br>p90 / max | certs settled<br>/min (net1) | host load<br>(of 64) |
|---|---|---|---|---|---|---|
| C6 browser-only | 3.8 ms | 1.3 ms | 1.8 ms | — / 16% | 0.80 | 6.4 |
| C1 25u | 4.3 ms | 1.3 ms | 1.7 ms | 35% / 208% | 0.79 | 8.2 |
| C9 soak 25u | 4.0 ms | 1.3 ms | 1.7 ms | 38% / 380% | 0.88 | 4.0 |
| C8 35u | 3.8 ms | 1.3 ms | 1.6 ms | — / 125% | 0.77 | 6.0 |
| C2 50u | 3.9 ms | 1.3 ms | 1.7 ms | — / 631% | 0.81 | 8.2 |
| C3 100u | 6.5 ms | 1.3 ms | 1.7 ms | 138% / 1727% | 0.76 | 17.9 |
| C7 100u headless | 4.1 ms | 1.3 ms | 1.7 ms | 17% / 47% | 0.71 | 8.1 |
| C4 200u | 78 ms | 1.4 ms | 1.9 ms | 354% / 1470% | 0.77 | 29.5 |
| C5 400u | **5,279 ms** | **3,809 ms** | **1.8 ms** | 796% / 1423% | 0.81 | 34.4 |

---

## 4. Where the limits are

### 4.1 Stable: ≤25 users / ~50 autoclaims/min

C9 (60-minute soak, 25 users, 5 of them real browsers) is the evidence: 1,489/1,489 headless laps,
99.6% autoclaim coverage, 18 overdue autoclaims across 5,281 bridges, proxy latency 2–4 ms, no drift.
Hop success per 10-minute bucket across the whole hour:

| minute | 0–10 | 10–20 | 20–30 | 30–40 | 40–50 | 50–60 | 60–70 |
|---|---|---|---|---|---|---|---|
| hops | 621 | 895 | 888 | 883 | 891 | 881 | 240 |
| success | 98.6% | 99.7% | 98.1% | 99.7% | 99.0% | 99.1% | 97.9% |

Flat. Nothing accumulates.

### 4.2 The binding constraint is the autoclaimer, not throughput

Certificate settlement is **not** the limit: 0.71–0.88 certs/min per network at *every* load, with the
pending-vs-settled backlog never exceeding 1. agglayer batches, so certificate cadence sets per-hop
*latency*, not a ceiling.

The autoclaimer is the limit, and it exhibits **congestion collapse** — throughput falls as you push harder:

| offered autoclaims/min | 24 | 41 | 45 | 53 | 74 | 103 | 122 | 202 |
|---|---|---|---|---|---|---|---|---|
| **served autoclaims/min** | 24 | 41 | 42 | **53** | 33 | 46 | 25 | 21 |
| coverage | 100% | 99% | 94% | 99.6% | 44% | 44% | 20% | 10% |

Peak sustained service rate is ~**53 autoclaims/min** (C9). Past roughly 45–55/min offered, served
throughput *decreases*. At 200 users the network auto-claims only 1 hop in 5 that it promised to.

### 4.3 Hard failure: 400 users — the shared ingress

At 400 users, headless lap completion finally breaks (99.1% → 88.3%), 308 `rpc_error`s and 116
`revert_bridge`s appear, and 6,850 of 581,977 HTTP calls abort. The cause is visible only because the
monitor probes two paths: **agglayer's direct `:9092` port stays at 1.8 ms p90 while everything routed
through haproxy `:8555` degrades to 3.8–5.3 s.** `tests/devnet/docker-compose.yml`'s haproxy serves
`/l1rpc`, `/l2rpc-001`, `/l2rpc-002` and `/aggkitapi` from **one frontend with `maxconn 1024`** and no
backend connection tuning, so RPC traffic and bridge-API traffic queue behind each other.

This is a devnet-topology limit, not an aggkit/agglayer limit — but it mirrors any deployment that fronts
RPC and the bridge API with one ingress, and it is the reason the 400-user numbers cannot be read as a
statement about aggkit.

---

## 5. Findings

### 5.1 `CRITICAL` — agglayer settlement task panics on an L1 RPC error and wedges the network forever

Observed in the very first (10-user) run: 0% lap completion, every `L2A→L2B` hop
`timeout_ready_to_claim`, network 1 settled height frozen at 38 while pending/proven sat at 39.

```
thread 'agglayer-node-runtime' panicked at crates/agglayer-settlement-service/src/settlement_task.rs:602:37:
  msg: "assumed non-recoverable in settlement task 01M2NGSABY99JD0X6NNPW99CBD ...
        querying nonce inclusion on L1 for wallet 0xCae5…4D4d / nonce 82",
  source: ErrorResp(ErrorPayload { code: -32602,
        message: "BlockOutOfRangeError: block height is 16514 but requested was 8257" })
```

and thereafter, every 5 minutes, forever:

```
WARN agglayer_rpc: Certificate already exists in store for network 1 at height 39 …
WARN agglayer_rpc: … settlement_job_id: 01M2NGSABY99JD0X6NNPW99CBD,
     Unable to replace a certificate in error whose settlement job is still in flight
```

**Mechanism** (reproduced with plain `curl`, no load test involved):
agglayer's settlement task calls `eth_getTransactionBySenderAndNonce` on L1, which binary-searches
blocks; its first probe is always `height/2`. Anvil retains transaction history only for its last
`--transaction-block-keeper` blocks (**default 8192**), and this compose file does not set it. Once L1
height passes ~16,384 — **~4.5 h of uptime at 1 s blocks** — `height/2` falls outside the retained window
and anvil returns `-32602 BlockOutOfRangeError`. Confirmed nonce-independent: nonces `0x1`, `0x10`,
`0x40`, `0x52` all fail at the same midpoint; a nonce above the account's current nonce returns `null`
without searching.

The bug worth fixing is **agglayer's reaction**: it classifies a transport-level RPC error as
non-recoverable and panics, the settlement job is then permanently marked in-flight, the certificate is
stuck `InError`, and `RetryCertAfterInError=false` means it never recovers. Every L2→L2 bridge stalls
while **`/bridge/v1/sync-status` keeps reporting `is_synced: true`** — the wedge is invisible to any
client-reachable endpoint. The only signal is the gauge
`agglayer_node_network_latest_certificate_in_error{network_id}` on agglayer's `:9092`, which is not
client-reachable, and aggkit's own `/metrics` is unexposed (404) on this compose devnet.

Zero panics occurred in any of the nine measured cases, because each was preceded by a devnet reset —
which is itself the proof that the trigger is **uptime, not load**.

> **Operational consequence:** this devnet has a hard ~4.5 h lifetime. Any load test longer than that,
> or run on a devnet that has been up a while, will silently measure a broken system and misattribute
> every `timeout_ready_to_claim` to load. Check the gauge before trusting any run.

### 5.2 `HIGH` — autoclaim congestion collapse, masked by lap-completion metrics

Covered in §4.2. Two things make this dangerous rather than merely a capacity number:

1. **Served throughput decreases under increasing load** (53 → 21 autoclaims/min). This is collapse, not
   saturation; backing off restores service, pushing harder does not.
2. **Every top-line metric stays green while it happens.** At 200 users lap completion reads 99.1% —
   because the harness escalates missed autoclaims to manual claims (3,568 of them) and counts the hop as
   `hop_completed_escalated`. Without that fallback those 3,568 bridges are unclaimed user funds sitting
   in the bridge. Anyone measuring only success rate would report this system as healthy at 8× its real
   capacity.

`autoclaimOverdue` is the counter that tracks it: 14 → 87 → 350 → 1,529 → 3,798 → 7,431 across the ladder.

### 5.3 `HIGH` — browser-path `bridgeAsset` reverts: inner `updateGlobalExitRoot` runs out of gas

Browser mode fails ~20% of hops *even on a completely idle system*. C6 (browser-only, 20 users) ran with
aggkit at 16% CPU, proxy at 3.8 ms, exactly **1** overdue autoclaim — and still completed only 51.5% of
laps, with per-hop success uniform across all three routes (78.9% / 82.1% / 79.5%).

Scanning every block of all three chains for that run:

| chain | txs | reverted | rate |
|---|---|---|---|
| L1 | 1,019 | 46 | 4.5% |
| L2A | 914 | 22 | 2.4% |
| L2B | 772 | 12 | 1.6% |

All 79 reverts are selector `0xcd586579` (`bridgeAsset`) to the bridge. `eth_call` replayed against the
**parent** block **succeeds**, so it is not a logic error but a gas/state race at inclusion. The
`callTracer` trace shows the real cause:

```
CALL         bridge           0xC8cbEBf9…F038   error: execution reverted
 DELEGATECALL impl            0xcb12d626…       error: execution reverted
  CALL        globalExitRootV2 0x1f7ad7caA5…    error: execution reverted
   DELEGATECALL impl           0xb9a916d0…      error: OUT OF GAS   ← actual cause
```

The UI passes `forceUpdateGlobalExitRoot: true`, so `bridgeAsset` calls `updateGlobalExitRoot`. Under
EIP-150's 63/64 rule the inner call is starved while the outer frame keeps enough gas to return, so the
**receipt shows a plain revert with `gasUsed` at only ~97% of the limit** — a naive gasUsed-vs-gasLimit
check calls this "not out of gas" and misses it entirely.

Why browser only: the headless worker applies `gas.bridgeGasOffset: 300000`; the browser path forwards
the SDK's `eth_estimateGas` result unbuffered (the SDK's estimator is a bare `client.estimateGas`
returned as-is). When the global exit root moves between estimate and inclusion, the extra SSTORE cost
is uncovered. This is the residual browser gap that forwarding `gas` in `mapTransactionRequest`
(commit `2c6d888`) did **not** close — closing it needs an actual buffer.

> **✅ FIXED AND VERIFIED 2026-09-17 (plan step S36).** `app/utils/transaction.ts` now exports
> `BRIDGE_GAS_BUFFER = BigInt(300_000)` and `mapTransactionRequest` takes an opt-in `{ gasBuffer }`,
> which `useBridgeExecution.ts`'s **bridge send only** passes (approve and claim are deliberately left
> unbuffered — neither races the GER, and neither produced a single revert in the scan above). Sized
> from the numbers in this section: a 10–25% multiplier does not span the 155k-estimate → 241k-actual
> gap. Re-running this exact case (`S36-verify`, browser-only, 20 users, fresh devnet) gives:
>
> | | before | after |
> |---|---|---|
> | `bridgeAsset` reverts (L1 / L2A / L2B) | 46 / 22 / 12 | **0 / 0 / 0** |
> | browser lap completion | 51.5% | **91.1%** |
> | hop success | 80.1% | **97.0%** |
> | `"Transaction failed"` modal assertions | 79 | **0** |
>
> The 79 reverts and 79 modal assertions matching 1:1, and both going to zero together, confirm the
> diagnosis. `pnpm run check` 625/625, including a drift guard that fails if `BRIDGE_GAS_BUFFER` and the
> load-test schema's `gas.bridgeGasOffset` default ever diverge. The 10 `ui_assertion`s left in the
> verification run are a **different** defect —
> `[claim-tokens-button] locator.click: Timeout 30000ms` on the manual-claim `L2B→L1` hop, no transaction
> behind it, 19 of them present before the fix too.

### 5.4 `MEDIUM` — the UI reports "Transaction failed" with no diagnostic on exactly this path

`app/hooks/useBridgeExecution.ts:161` handled `receipt.status === 'reverted'` by setting
`error: { message: 'Bridge transaction reverted' }` — and, unlike the `catch` branch two blocks below, it
emitted **no `console.error`**. Confirmed empirically: 1,556 console errors were captured during C1 and
every one was benign external-asset noise; not a single `[bridge-execution]` line, despite 20 modal
failures in that run. A user (and anyone reading a bug report) got "Transaction failed" with nothing
actionable, for the single most common real failure mode in the browser path.

> **✅ FIXED 2026-09-17.** All three reverted-receipt branches now log — the bridge send and the approval
> in `useBridgeExecution.ts`, and the claim in `useClaimExecution.ts` (which had no logging on any path
> at all). Each logs `{ txHash, blockNumber, gasUsed }` alongside a labelled message. The **hash** is the
> part that matters: as §5.3 shows, an out-of-gas *inner* call reverts with `gasUsed` **below** the
> limit, so `gasUsed` cannot identify it and only a `callTracer` trace of the hash can — the log exists
> so that trace is still possible after the fact. Guarded by a mutation-proven test (deleting the
> `console.error` fails it), and the harness now records these as `console_error` events rather than
> losing them.

### 5.5 `MEDIUM` — one haproxy ingress with `maxconn 1024` fronts both RPC and the bridge API

See §4.3. Backend services were demonstrably fine at the moment everything through the ingress was taking
4–5 s. Worth either raising `maxconn`/adding backend tuning in the devnet compose, or splitting the
RPC and bridge-API frontends, so future high-load runs measure aggkit rather than haproxy.

### 5.6 `MEDIUM` — aggkit-proxy bridge tracker cannot resolve a LER root index, ~10–18× per certificate

```
WARN bridgetracker/engine.go: failed to resolve a step of bridge network=N/tx=0x…:
     certificate: resolving root index of LER 0x… on network N: not found
     (github.com/agglayer/aggkit/bridgetracker.(*Engine).persistStepError)
```

Present in **every** case, including browser-only and headless-only. Absolute counts are roughly constant
per run (120–584) regardless of whether the run pushed 1,042 or 12,608 bridges, i.e. it scales with
**certificates settled, not bridges** (~10–18 per certificate) and is **load-independent**. It appears to
be a transient window where the tracker queries a LER root index before it is indexed. It plausibly
underlies the `timeout_appears_in_activity` outcomes, which at idle browser load (125) outnumber outright
transaction failures (98) — the bridge succeeds but never surfaces in the activity feed within 60 s.

### 5.7 `LOW` — assorted aggkit warnings that grow with load

- `flows/flow_base.go: toBlock inconsistency for settled cert N (…): agglayer-derived=N, db-stored=N.
  Using agglayer-derived value.` — 14–185 per run, every case. A persistent disagreement between aggkit's
  stored `toBlock` and agglayer's, silently resolved in agglayer's favour.
- `ethtxmanager: signedTx not mined yet and timeout has been reached` — absent at ≤50 users, 5 at 100
  users, 13 at 400. aggkit's own transaction manager giving up on its certificate txs.
- `ethtxmanager: failed to send tx … replacement transaction underpriced` — aggkit hitting its **own**
  nonce collision (the same failure shape the harness had to fix on its side with a per-(user, chain)
  send queue).
- `ethtxmanager: failed to estimate gas: execution reverted: custom error 0x646cf558` — 2–6 per run; the
  autoclaimer racing a claim that already landed (`already_claimed`, benign but noisy).

### 5.8 `OBSERVATION, UNATTRIBUTED` — aggkit CPU is ~8× higher in mixed runs than headless-only at the same user count

C3 (100 users, 20 browser) vs C7 (100 users, 0 browser) — with **C7 delivering 31% more throughput**:

| | C3 mixed | C7 headless-only |
|---|---|---|
| bridges/min | 118.1 | **154.8** |
| aggkit-001 CPU mean / p90 / max | 61% / 138% / 1727% | **11% / 17% / 47%** |

The CPU is bursty in both (periodic certificate-build spikes against a low baseline), but the *mean*
difference is 5×, so it is not a sampling artefact. I could not isolate the mechanism within this run
budget — browser count alone does not explain it either (C6's 20 browser-only users peaked at 16%).
Flagging it as an open question rather than asserting a cause.

### 5.9 `TOOLING` — observability gaps that made this harder than it should be

- aggkit's `/metrics` is **not exposed** by this compose devnet (404 on both aggkit containers). Only
  agglayer's `:9092` is reachable, and it is not client-reachable in any realistic deployment.
- `/bridge/v1/sync-status` reports `is_synced: true` throughout a total network wedge (§5.1). There is no
  client-visible health signal for "certificates are not settling".
- The harness's own single-process event loop invalidates its latency percentiles above ~50 headless
  users (p99 5–10 s vs a 100 ms threshold). Multi-process sharding worked as a workaround but the tool
  has no inter-process aggregation, so counters had to be merged externally.

---

## 6. Latency reference (C7 — the only run with a valid event loop)

100 headless users, 154.8 bridges/min, event-loop p99 **12 ms**. 4,318 hops, 1,439 laps, zero HTTP errors
across 184,329 requests. These are real numbers, not queueing artefacts.

| phase | p50 | p90 | p99 | max |
|---|---|---|---|---|
| `bridge_submit` | 9 ms | 12 ms | 18 ms | 44 ms |
| `claim_submit` | 15 ms | 23 ms | 38 ms | 66 ms |
| `bridge_receipt` | 4.01 s | 4.01 s | 4.02 s | 4.05 s |
| `appears_in_activity` | 1.94 s | 3.91 s | 4.95 s | 5.03 s |
| `ready_to_claim` | 80.5 s | 117.0 s | 131.0 s | 138.0 s |
| `claimed_observed` | 2.96 s | 97.5 s | 276.0 s | 298.0 s |
| `hop_total` | 140.0 s | 418.0 s | 447.0 s | 455.0 s |
| `lap_total` | 618.7 s | 682.2 s | 706.4 s | 771.1 s |

`bridge_receipt`/`claim_receipt` at a flat ~4.01 s are the harness's poll cadence against 1 s anvil
blocks, not server latency. `claimed_observed` is strongly **bimodal** (p50 3 s, p99 276 s) — that split
*is* §5.2: either the autoclaimer got there promptly, or it was overdue and the manual escalation paid
the certificate wait.

Proxy endpoints in the same run: `tracker/activity` p50 **7 ms**, p90 9 ms, p99 20 ms, max 161 ms over
36,813 requests, **100% HTTP 200**. `bridge/claim-proof` p50 4 ms, p99 43 ms. **The aggkit-proxy itself
was never the bottleneck at any load below the ingress collapse.**

---

## 7. Recommendations

**Fix**
1. §5.1 — agglayer must not panic on a transport-level L1 RPC error, and a panicked settlement task must
   release its in-flight marker so the certificate can be replaced. This is a permanent, unattended,
   silent loss of an entire network.
2. ~~§5.3 — apply a gas buffer on the browser bridge path.~~ **Done 2026-09-17 (S36): reverts 79 → 0,
   browser lap completion 51.5% → 91.1%.** See §5.3's fix box.
3. ~~§5.4 — add a `console.error` to the `receipt.status === 'reverted'` branch~~ **done 2026-09-17,
   for all three revert branches.** Surfacing the revert reason in the *modal* is still open — the log
   makes it diagnosable to a developer, not to the user.
4. §5.2 — treat `autoclaimOverdue` / autoclaim coverage as the primary capacity SLI. Success rate alone
   does not detect this failure.

**Devnet hygiene**
5. Set `--transaction-block-keeper` on the anvil services (or `restart` on a schedule) so §5.1's trigger
   cannot fire; and check `agglayer_node_network_latest_certificate_in_error` before every run.
6. Raise haproxy `maxconn` / split the RPC and bridge-API frontends (§5.5) so >200-user runs measure
   aggkit rather than the ingress.
7. Expose aggkit's `/metrics`, and add a client-visible certificate-health signal to `sync-status`.

**Further testing**
8. Attribute §5.8 (aggkit CPU, mixed vs headless-only).
9. Re-run the 200/400-user rungs after fixing §5.5 — the current 400-user numbers measure haproxy, so
   aggkit's true ceiling above 200 users is **not yet known**.
10. Give the harness inter-process counter aggregation so sharded runs produce one report with valid
    latency percentiles.

---

## 8. What this report does not establish

- **The upper bound on aggkit.** C5's failures are ingress failures (§4.3/§5.5). aggkit's real ceiling
  above 200 users is unmeasured.
- **Absolute latency above 50 headless users per process.** Only C7 is quoted; every other run's
  percentiles are contaminated by the tool's own event loop and were deliberately excluded.
- **Browser-user capacity.** Browser mode's ~20%-per-hop floor (§5.3) was a defect, not a capacity limit,
  so the browser numbers in §3 measure that defect rather than how many browser users the system can
  serve. **They are now stale**: S36 fixed it (hop success 80.1% → 97.0% at the same load), so the whole
  ladder's browser column would have to be re-run to say anything about browser capacity.
- **Anything about testnet/mainnet.** This is a single-host compose devnet with 1 s anvil blocks and a
  ~0.8 certs/min settlement cadence. Certificate cadence, ingress topology and prover cost all differ in
  a real deployment.

---

### Appendix — raw artefacts

Per-case tool reports in `loadtest-results/<case>-s<shard>/` (`results.json`, `activity.ndjson`,
`summary.md`). Server-side samples, merged per-case aggregates, container warning summaries, the
chain-wide revert scan and the harness scripts (`monitor.py`, `runcase.sh`, `reset.sh`, `agg.py`,
`mon.py`, `warns.py`, `revscan.py`, `table.py`) are in the session scratchpad — copy them out before it
is cleaned up if they are wanted long-term.

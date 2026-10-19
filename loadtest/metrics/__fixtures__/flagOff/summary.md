# Bridge load test — 2026-10-14T12:00:00.000Z — FAIL (1 of 3 lap(s) failed: timeout_ready_to_claim x1) — users=3, rate=2/user/min, duration=30min

## Configuration

- env: devnet
- aggkitProxyUrl: http://127.0.0.1:8555/aggkitapi
- ring: L1 (networkId 0) -> L2A (networkId 1) -> L2B (networkId 2) -> L1 (networkId 0)

**Assets**
- assets[0]: {"kind":"eth","amount":"0.001","decimals":18}
- assets[1]: {"kind":"erc20","address":"0xe293A6b8F558422813499bb5C89B60adD8c54636","originNetworkId":0,"amount":"0.01","decimals":18}

**Autoclaim**
- L1->L2A: {"expected":false}
- L2A->L2B: {"expected":false}
- L2B->L1: {"expected":false}

**Timeouts**: {"txReceiptMs":60000,"appearsInActivityMs":60000,"readyToClaimMs":900000,"claimedMs":900000,"hopMs":1200000,"lapMs":3600000,"pageLoadMs":30000,"walletConnectMs":15000}

**Secrets** (shown as `env:NAME` / `file:PATH`, never resolved):
```json
{
  "total": 3,
  "browser": 0,
  "wallets": {
    "mnemonicRef": {
      "ref": "env:LOADTEST_TEST_MNEMONIC"
    },
    "startIndex": 0
  },
  "funder": {
    "privateKeyRef": {
      "ref": "env:LOADTEST_TEST_FUNDER_KEY"
    },
    "gasPerChain": {
      "L1": "0.05",
      "L2A": "0.05",
      "L2B": "0.05"
    },
    "maxTotalSpend": {
      "L1": "500",
      "L2A": "500",
      "L2B": "500"
    }
  },
  "devnetFunding": "anvil_setBalance"
}
```

## Throughput

| metric | value | note |
| --- | --- | --- |
| users (requested) | 3 | - |
| browser users (requested) | 0 | - |
| rate per user/min (requested) | 2 | - |
| duration minutes (requested) | 30 | - |
| ticksExpected | 4 | INDEPENDENT: users x rate x minutes, from config alone (R29) |
| ticksOffered | 4 | lap-start opportunities, all users (= lapStartsSubmitted + skippedBackpressure + ticksLostToRamp, by construction) |
| lapStartsSubmitted | 3 | same unit as ticksOffered/rate (requested) |
| skippedBackpressure | 1 | - |
| ticksLostToRamp | 0 | - |
| hopBridgesSubmitted | 3 | informational only — per-HOP bridge sends, not part of the identity |
| steadyStateRatePerUserPerMin (achieved) | 0.0000 | same unit as rate per user/min (requested); divides by ELAPSED duration when known (R8), else requested |

Identity check (`ticksOffered = lapStartsSubmitted + skippedBackpressure + ticksLostToRamp`): **OK**

ticksOffered vs ticksExpected (`ticksOffered - ticksExpected`): **0**

**Achieved rate per mode (A10, VALIDATION-1.md)** — the blended figure above can average two modes behaving completely differently; never quote it as "what a real user experiences" without checking this table too:

| mode | users (requested) | steadyStateRatePerUserPerMin (achieved) |
| --- | --- | --- |
| browser | 0 | n/a (0 users) |
| headless | 3 | n/a (0 users) |

**Per-mode lap reliability — attempted vs completed (S27, plans/bridge-loadtest-plan.md §7)** — `attempted` is every lap that reached a final outcome (`LAP_DONE`/`LAP_FAILED`/`LAP_ABORTED`), `completed` is `LAP_DONE` only. This is the gate `tests/loadtest-e2e/run.spec.ts` enforces per mode so a mode collapsing toward 0% completion (browser: 1 of ~58 laps before S25's fix) fails CI instead of hiding behind the other mode's healthy aggregate:

| mode | attempted | completed | completionRate |
| --- | --- | --- | --- |
| browser | 0 | 0 | n/a (0 attempted) |
| headless | 3 | 2 | 66.7% |

## Hop outcomes

| route | hop_completed_manual | timeout_ready_to_claim |
| --- | --- | --- |
| L1->L2A | 2 | 1 |
| **all routes** | 2 | 1 |

**Per-route x per-mode hop reliability (S30, plans/bridge-loadtest-plan.md §7/§8)** — `attempted` is every hop that reached a final outcome on that (route, mode) pair, `completed` counts only a `hop_completed_*` (success) outcome. This is the gate that closes S27's structural blind spot: a hop degrading in exactly one mode on one route (S26/S29's headless-only `rpc_error`s on `L2B->L1`) is visible here even when both the route-aggregate table above and the per-mode lap table stay healthy overall:

| route | mode | attempted | completed | completionRate |
| --- | --- | --- | --- | --- |
| L1->L2A | browser | 0 | 0 | n/a (0 attempted) |
| L1->L2A | headless | 3 | 2 | 66.7% |

## Phase latencies

> **Note (R2):** the `timedOut` column counts hops that entered a phase and TIMED OUT rather than completing it. Those samples are excluded from the percentiles to their left (a duration capped at the configured timeout is not a latency measurement) — a phase with a high `timedOut` count relative to its `n` has percentiles that describe only the hops that succeeded, not the whole population that attempted it.

| phase | browser | headless | timedOut |
| --- | --- | --- | --- |
| bridge_submit | n/a | n=3 p50=410 p90=420 p99=420 max=420 | 0 |
| claim_receipt | n/a | n=2 p50=5000 p90=5000 p99=5000 max=5000 | 1 |
| ready_to_claim | n/a | n=3 p50=31000 p90=32000 p99=32000 max=32000 | 0 |

## Endpoint latencies

**Headline — `tracker/activity` origin split (DESIGN §9.3 C16):** the `ui` row is what a real user's browser (or, in headless mode, the worker's single poll loop standing in for one) actually generates — this is the number that answers "what load would real users create?" The `harness` row is browser mode's own control-flow poll and is **not** real user traffic; it is shown, not hidden.

| origin | browser | headless |
| --- | --- | --- |
| ui (headline) | n/a | n=3 p50=21 p90=22 p99=22 max=22 retries=0 status={"200":2,"503":1} |
| harness | n/a | n/a |

| endpointClass | browser (ui) | browser (harness) | headless (ui) | headless (harness) |
| --- | --- | --- | --- | --- |
| bridge/claim-proof[1] | n/a | n/a | n/a | n=3 p50=90 p90=90 p99=90 max=90 retries=1 status={"200":3} |
| rpc/l1rpc/eth_call | n/a | n/a | n=3 p50=11 p90=11 p99=11 max=11 retries=0 status={"200":3} | n/a |
| tracker/activity | n/a | n/a | n=3 p50=21 p90=22 p99=22 max=22 retries=0 status={"200":2,"503":1} | n/a |

## Gate stalls

> **Note (R6):** `timedOutVisits` counts how many of `hopsEntered`'s visits ended at the configured timeout rather than a real resolution. A p50/p90/p99 at or near the timeout budget for a gate with a high `timedOutVisits` count is that budget, not a measured stall — do not raise the corresponding timeout from this number alone.

| gate | hopsEntered | totalMs | p50 | p90 | p99 | blockedTicks | timedOutVisits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claim-proof | 3 | 93003 | 31001 | 31002 | 31002 | 1 | 1 |

## Autoclaim policy

| counter | count |
| --- | --- |
| autoclaimOverdue | 0 |
| unexpectedAutoclaim | 0 |
| claimRaceLost | 3 |

## Errors

**By class**

| class | count |
| --- | --- |
| internal | 1 |
| proxy_5xx | 1 |

**Top 10**

| class | count | firstSeen | lastSeen | endpointClass | sample |
| --- | --- | --- | --- | --- | --- |
| internal | 1 | 2026-10-14T12:00:21.000Z | 2026-10-14T12:00:21.000Z | - | golden internal error |
| proxy_5xx | 1 | 2026-10-14T12:00:21.000Z | 2026-10-14T12:00:21.000Z | tracker/activity | HTTP 503 |

**Suppressed (correct policy, not silently uncounted — R7)**

| class | count | policy |
| --- | --- | --- |
| not_ready | 1 | DESIGN §5.3: a readiness gate, not an error — counted as a gate stall instead |
| console_error (benign external asset) | 0 | S11 defect (3): known-benign external asset-host noise (favicon/chain-icon fetches), unrelated to aggkit-proxy |

## Resources

| metric | peak | mean |
| --- | --- | --- |
| toolRssMb | 210.5 | 210.5 |
| toolCpuPct | 12.25 | 12.3 |
| eventLoopDelayP99Ms | 4.5 | 4.5 |

**Per-browser-process RSS**

No browser process samples recorded.

## Environment

| field | value |
| --- | --- |
| toolVersion | golden-tool |
| sdkVersion | golden-sdk |
| host.cores | 4 |
| host.totalMemMb | 8192 |
| host.platform | linux |

## Claim gas and stage latency

Only completed hops are counted in the tables; 1 hop(s) with a failed, timed-out or aborted outcome are excluded. Median is the true median (mean of the two middle values for even n). T0 is the client-observed bridge receipt (viem polls every 4 s by default, so up to 4 s late).

**Claim gas**

| toNetworkId | claimKind | n | gasUsed min / median / max | median effectiveGasPrice (wei) | l1Fee min / median / max (wei) | total fee min / median / max (wei) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | eth | 2 | 150000 / 150000 / 150001 | 1000251 | n/a | 150037650000 / 150038150125 / 150038650251 |

**Stage latency**

Stage probe was off: only the claim tx delta and end to end are available; stage columns are n/a.

| route | completed hops | delta | n / min / median / max (ms) |
| --- | --- | --- | --- |
| L1->L2A | 2 | T1-T0 l1-info-tree-index available | n/a |
| L1->L2A | 2 | T2-T0 injected-l1-info-leaf available | n/a |
| L1->L2A | 2 | T3-T0 claim-proof available | n/a |
| L1->L2A | 2 | T3b-T3 tracker READY lag after claim-proof | n/a |
| L1->L2A | 2 | T5-T4 claim tx sent to mined | 2 / 2000 / 2000 / 2000 |
| L1->L2A | 2 | T5-T0 end to end (includes tracker lag) | 2 / 33000 / 33000 / 33000 |

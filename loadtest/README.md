# Bridge load test

`loadtest/` simulates **X users each submitting Y bridges per minute for Z minutes**
against the **aggkit-proxy** (`/bridge/v1/*` + `/tracker/v1/*`) and its per-network
bridge services, with the same traffic shape real users produce through
`agglayer-dev-ui`. Each user's asset travels a closed ring (e.g. `L1 -> L2A -> L2B ->
L1 -> ...`) so nothing is burned except gas.

Two worker kinds run in the same tool and the same report:

- **Browser workers** — real Chromium via Playwright, driving the actual app UI
  (reusing `tests/bridge/models/bridge-page.ts`).
- **Headless workers** — plain TypeScript + viem + the pinned `@agglayer/sdk`,
  replaying the exact call set the UI makes (`app/services/activity.ts` and friends),
  including its polling cadences.

Every run also writes **`out/report.html`**, a single self-contained page that is the
human entrypoint to the results (see [HTML report](#html-report-outreporthtml)).

Design background, the full UI-call-set parity audit, and the two validation runs
that shaped the current defaults live in:

- [`DESIGN.md`](./DESIGN.md) — normative spec: config schema, hop/lap state machine,
  funding, metrics/error taxonomy, report layout, browser pool, UI build/serve, UI
  call-set parity.
- [`PARITY.md`](./PARITY.md) — headless-vs-browser HTTP trace diff, endpoint by
  endpoint.
- [`BASELINE.md`](./BASELINE.md) — devnet snapshot baseline (topology, ports, ids)
  the tool is developed and tested against.
- [`VALIDATION-1.md`](./VALIDATION-1.md) — analysis of the first at-scale run: what
  was a tool bug, what was devnet capacity, what was a genuine aggkit/agglayer
  finding, and the fix list that became the current behaviour.

## Quick start (devnet)

This is the exact sequence used to develop and validate the tool. Run it from the
repo root.

```bash
# 1. Bring up the vendored compose devnet (anvil x3, agglayer, aggkit x2,
#    aggkit-proxy, haproxy -- see the root README's "CI-devnet quick start").
docker compose -f tests/devnet/docker-compose.yml up -d --wait

# 2. Wait for it to actually be ready (chain ids, bridge bytecode, sync-status).
node scripts/devnetReady.mjs --timeout-ms 300000

# 3. The devnet's pre-funded key, pulled out of the compose snapshot's own
#    manifest -- never hand-typed, never committed.
export LOADTEST_DEVNET_FUNDER_KEY=$(python3 -c "import json;print(json.load(open('tests/devnet/summary.json'))['accounts']['e2e_wallet']['private_key'])")

# 4. The wallets the tool derives FOR its simulated users -- this is the
#    well-known public Anvil/Hardhat test mnemonic, not a secret.
export LOADTEST_MNEMONIC="test test test test test test test test test test test junk"

# 5. Derive a devnet config from tests/devnet/summary.json + compose port env.
pnpm loadtest derive-devnet --out loadtest.config.json

# 6. Fund 4 derived wallets (anvil_setBalance + ERC20 transfer from the e2e wallet).
pnpm loadtest fund --config loadtest.config.json --users 4

# 7. Assert gas/asset/allowance/sync-status/tracker-health before spending real time.
pnpm loadtest preflight --config loadtest.config.json --users 4

# 8. Run: 4 users, 2 of them real browsers, 1 bridge/user/min, for 3 minutes.
pnpm loadtest run --config loadtest.config.json --users 4 --browser 2 --rate 1 --minutes 3

# 9. Re-render summary.md from a previous run's results.json (also written
#    automatically by `run` itself, at loadtest-results/<ts>/).
pnpm loadtest report --dir loadtest-results/<ts>
```

Notes:

- `loadtest.config.json` and everything under `loadtest-results/` are gitignored —
  never commit either.
- Step 8's `run` command builds and serves its own E2E-enabled static export first
  (see [Two dev-ui changes](#two-dev-ui-changes-this-branch-makes) below); you do not
  need to run `pnpm loadtest build-ui`/`serve-ui` separately unless you want to
  inspect the served export on its own.
- `--minutes` is real wall-clock minutes against real devnet certificate cadences —
  see [Capacity guidance](#capacity-guidance-measured) below before requesting a large
  `--minutes`/`--users` combination.
- Before running any of this against a devnet that has been up for a while, read
  [Troubleshooting item 2](#troubleshooting) — a wedged devnet will silently produce
  a report full of `timeout_ready_to_claim`, not an obvious error.

## Prod-config walkthrough

Devnet configs are generated (`derive-devnet`); a testnet/mainnet config is
hand-written against the same schema. `loadtest/config/examples/testnet.loadtest.json`
is a validated, worked example (Sepolia <-> Bokuto):

```jsonc
{
  "env": "testnet",
  "aggkitProxyUrl": "https://REPLACE-ME-testnet-aggkit-proxy", // real URL required -- see below
  "chains": [
    { "key": "SEPOLIA", "chainId": 11155111, "networkId": 0, "rpcUrl": "...", "bridgeAddress": "0x..." },
    { "key": "BOKUTO", "chainId": 737373, "networkId": 37, "rpcUrl": "...", "bridgeAddress": "0x..." }
  ],
  "ring": ["SEPOLIA", "BOKUTO", "SEPOLIA"], // closed, >= 2 hops; ring[0] must be the asset's origin chain
  "autoclaim": {
    "SEPOLIA->BOKUTO": { "expected": false }, // manual claim (default; see "Autoclaim semantics")
    "BOKUTO->SEPOLIA": { "expected": false } // manual claim
  },
  "assets": [{ "kind": "eth", "amount": "0.00001", "decimals": 18 }],
  "users": {
    "total": 2,
    "browser": 1,
    "wallets": { "mnemonicRef": { "env": "LOADTEST_MNEMONIC" }, "startIndex": 0 },
    "funder": {
      "privateKeyRef": { "file": "/run/secrets/loadtest-sepolia-funder" }, // never inline
      "gasPerChain": { "SEPOLIA": "0.01", "BOKUTO": "0.005" },
      "assetTopUp": "0.00004",
      "maxTotalSpend": { "SEPOLIA": "0.2", "BOKUTO": "0.1" }
    }
  },
  "load": { "bridgesPerMinutePerUser": 1, "durationMinutes": 5, "rampUpSeconds": 30 },
  "browser": { "contextsPerBrowser": 1, "headless": true, "trace": true },
  "timeouts": { "txReceiptMs": 120000, "readyToClaimMs": 1800000, "claimedMs": 1800000, "hopMs": 2400000, "lapMs": 5400000 },
  "gas": { "bridgeGasOffset": 300000, "claimGasOffset": 60000 },
  "output": { "dir": "loadtest-results/testnet-smoke", "activityLog": true }
}
```

`gas.claimGasOffset` (default `60000`, headless only) is an additive gas-limit margin on claim sends: the SDK claim `gas` (or one `eth_estimateGas`) plus the offset. It is an intentional deviation from the real UI, which has no margin: concurrent first-mint claims change state between estimate and execution (~228k zero-state mint vs ~177-194k) and can run out of gas at the bare estimate. Unused gas is refunded. Set `0` to send with viem's own estimate like the UI.

To adapt this for a real run:

1. Copy it, fill in real chain RPC URLs and bridge addresses if they differ.
2. Set `aggkitProxyUrl` to a **real** aggkit-proxy URL. `validate`/`preflight`/`run`
   all reject the literal placeholder host (`PROXY_URL_PLACEHOLDER`) — the
   repo's own `config.json` ships this placeholder for testnet and mainnet, so you
   must supply a real one out of band.
3. Point `users.wallets.mnemonicRef` and `users.funder.privateKeyRef` at real secrets
   (see [Funding & safety](#funding--safety) — never inline a key).
4. Set `users.funder.maxTotalSpend` deliberately — see the ERC20 caveat below.
5. `pnpm loadtest validate loadtest.config.json` before spending anything.

Full field reference: [`DESIGN.md`](./DESIGN.md) §2 (§2.1 fields, §2.2 secrets, §2.3
devnet example with provenance, §2.4 this testnet example with provenance).

## Funding & safety

- **Secrets are always references, never inline values.** `users.wallets.mnemonicRef`,
  `users.funder.privateKeyRef` and friends are `{"env": "VAR_NAME"}` or `{"file":
  "/path"}` — a literal 32-byte hex private key anywhere in the config is rejected
  at parse time (`INLINE_PRIVATE_KEY_FORBIDDEN`). A `{file}` ref additionally
  requires mode `0600` on the referenced file.
- **The ERC20 funding budget is an invariant, not a guess.** `preflight` computes the
  worst-case ERC20 spend as `amount x ceil(rate x minutes)` per user and fails fast
  with the exact number to raise `users.funder.assetTopUp` to, e.g.:
  ```
  preflight failed: PREFLIGHT_ASSET: asset[erc20] on ring[0] "L1": underfunded wallet(s) -- this run's
  worst-case budget is 0.01 x 40 lap(s) = 0.4 per user (set users.funder.assetTopUp >= 0.4, or fund
  again after raising it): u0 has 40000000000000000 < 400000000000000000; ...
  ```
  This exists because the ring's second/third hop can stall (devnet certificate
  latency, see [Capacity guidance](#capacity-guidance-measured)), so a wallet never
  gets its ERC20 back before the next scheduled bridge — a flat `amount x 4` default
  silently ran out mid-run in validation run #1.
- **`run --fund` funds before it runs `preflight`** (`runner.ts:654-682`), so preflight
  refusals that depend on discovery (`BROWSER_GAS_TOKEN_UNSUPPORTED`, `RING_ETH_START_*`)
  fire only after money has been sent to the user wallets. Run `preflight` first and do not
  use `run --fund` for gas-token (outpost) rings; fund with the separate `fund` command.
- **`--i-know-this-is-mainnet`** must be passed to `fund`/`run` before either will
  spend real funder money on a config whose `env` is `mainnet` — a deliberate,
  unmissable flag rather than an env-based gate. `run` refuses **unconditionally**
  as its first action (before wallet derivation, funding, or preflight) whenever
  `env` is `"mainnet"`, regardless of whether `--fund` is also passed — fixed
  (R0, loadtest/REVIEW.md): the gate previously lived only inside `fund`'s own
  code path, so `run` against an already-funded mainnet config needed no
  confirmation at all.
- **`maxTotalSpend` caps native currency; `maxTotalErc20Spend` caps ERC20
  top-ups (fixed, R19).** `users.funder.gasPerChain`/native top-ups are
  checked against `maxTotalSpend`; ERC20 transfers on the ring's origin chain
  are checked against the separate `maxTotalErc20Spend` (`validate` now
  requires it whenever a non-devnet-anvil fund uses an erc20 asset —
  `FUNDER_MAX_ERC20_SPEND_REQUIRED`). Devnet's `anvil_setBalance` path stays
  deliberately uncapped either way (no real-funds risk — it mints, it doesn't
  transfer real value).

## CLI reference

`pnpm loadtest <command> [args]` (== `tsx loadtest/cli.ts <command> [args]`).

| Command | Purpose | Flags |
|---|---|---|
| `derive-devnet` | Generate `loadtest.config.json` from `tests/devnet/summary.json` + compose port env vars | `--out <path>` (default `loadtest.config.json`) |
| `validate [<path>]` | Parse the config and run the operational checks (placeholder proxy host, ring-starts-at-asset-origin, etc.) | positional config path (default `loadtest.config.json`) |
| `fund [<path>]` | Fund derived wallets — devnet: `anvil_setBalance` + ERC20 transfer from the e2e wallet; testnet/mainnet: capped funder transfer | `--users N`, `--i-know-this-is-mainnet` |
| `preflight [<path>]` | Assert per-user gas on every ring chain, asset budget on the ring's origin chain, allowance state, both-sides `sync-status`, tracker health | `--users N` |
| `build-ui [<path>]` | Build a standalone E2E-enabled static export (`out/`) without touching the repo's committed `config.json` | — |
| `serve-ui [<path>]` | Serve a `build-ui` export on the config's `uiBaseUrl` until interrupted | `--out <dir>` |
| `run` | Full pipeline: load+validate config -> preflight -> (fund if `--fund`) -> serve UI if needed -> drive workers -> write report | `--config <path>`, `--users N`, `--browser N`, `--rate Y`, `--minutes Z`, `--assets eth,erc20`, `--fund` (see the warning in Funding & safety), `--cors-relay` (see [Browser mode and CORS](#browser-mode-and-cors-opt-in-local-relay)), `--i-know-this-is-mainnet`, `--out <dir>` |
| `report` | Re-render `summary.md` (byte-identical to the original) **and** `report.html` from an existing run directory's `results.json` + `activity.ndjson` | `--dir <dir>` (required), `--html` (write only the HTML, leave `summary.md` alone), `--html-out <file>` (default `<dir>/report.html`), `--max-bytes N` (size cap, default 4194304) |
| `campaign-report` | Render one roll-up page comparing several runs (e.g. a ramp's stages, or pump-off vs pump-on) | `--out <file.html>` (required), `--run <label>=<dir>[,<dir>]` (repeatable; several dirs under one label are pooled, e.g. the I and J rings of one stage) |
| `check-stop` | Read-only evaluation of stop criteria SC1-SC13 over a live or finished run. Sends no signal, always exits 0 | `--dir <out dir>` (required, repeatable), `--config <path>`, `--json` |

`--users N`, where accepted, also clamps `users.browser` down to `N` if the config's
own value would exceed it, so `USERS_BROWSER_EXCEEDS_TOTAL` can never fire as a side
effect of the override. `--assets` is comma-separated and case-insensitive
(`--assets eth,erc20`); omitting it runs every asset configured.

**Fixed (was: known bug) — `run` used to hang past `run: complete`.**
Root-caused (loadtest/REVIEW.md R1): `raceOrTimeout` abandons rather than cancels a
driver call, so an abandoned browser-mode call could still be inside
`pool.acquireContext()` -> `launchSlot()` when teardown started; `dispose()` didn't
await that in-flight launch, and neither `launchSlot` nor `acquireContext` refused a
NEW one once disposing had begun — so a relaunch could complete (and hand back a
live Chromium process/WebSocket) *after* teardown finished, with nothing left to
ever close it, and `cli.ts` set `process.exitCode` rather than calling
`process.exit()`. Fixed: `dispose()` now awaits every in-flight launch/crash-recovery
before closing anything, `launchSlot`/`acquireContext` refuse to start a new launch
once disposing, and `cli.ts` calls `process.exit()` once `main()` settles. Script/CI
usage should still prefer polling for the report files (`results.json`,
`activity.ndjson`, `summary.md`) or a bounded wait over an unbounded wait on the
`run` PID, as good practice.

## Report anatomy

Each run writes `loadtest-results/<timestamp>/`. **Read `report.html` first.** It is the
human entrypoint (see [HTML report](#html-report-outreporthtml)); `results.json`,
`activity.ndjson` and `summary.md` below are the machine-readable and debugging artifacts it
is built from.

> **Do not share a `loadtest-results/` directory as-is.** The redaction guarantees below
> cover the human-facing reports (`report.html`, `summary.md`), and `results.json` masks
> keyed RPC URLs and re-shapes secret references at write time — but `activity.ndjson` is
> the raw event stream (transaction hashes, endpoint class names and host names as
> observed at the time), and directories written by older tool versions predate the
> write-time masking entirely. Treat the whole directory as internal until you have
> checked what is in it.

- **`report.html`** — the single-file human report, written at the end of every run
  (including aborted and failed ones). Regenerate it with `pnpm loadtest report --dir <dir>
  --html`.
- **`results.json`** — the full machine-readable snapshot: requested vs. achieved
  throughput, hop outcomes by route, phase/endpoint latency histograms, gate stalls,
  autoclaim policy counters, errors by class, resource samples, environment. Secrets
  in the embedded `config` are re-shaped as `{ref: "env:NAME"}` — never resolved, and
  RPC URLs that carry a key are masked (see [Redaction](#redaction-guarantees)).
- **`activity.ndjson`** — the raw event stream (`hopState`, `txSent`, `txReceipt`,
  `activityRow`, `claimAttempt`, `error`, `hopEnd`, `lapEnd`, `resourceSample`, ...)
  that `results.json` is aggregated from — use it when a summary number needs
  attributing to specific users/hops. The heavy-load kinds (`pump_*`, `wallet_balance`,
  `l1_info_leaf`, `http_window`, `tx_sent`, `tx_receipt`) are listed in
  [Heavy-load measurement](#heavy-load-measurement-pump-samplers-stop-criteria).
- **`summary.md`** — the human-readable report, in this section order:
  Configuration, Throughput, Hop outcomes, Phase latencies, Endpoint latencies, Gate
  stalls, Autoclaim policy, Errors, Resources, Environment, then Claim gas and stage
  latency (see "Measurement" below). Its first line is always
  the pass/abort headline (see below). `pnpm loadtest report --dir <dir>` re-renders
  it from `results.json` alone, byte-identical.
- **Error classes.** The Errors section lists errors by class and a top-10. The
  non-failing class `activity_warning` (the tracker answered 200 but flagged a network
  as "not fully synchronized, some bridges may still be missing") appears in those
  tables, not under "Suppressed", and never fails a hop: a run whose only errors are
  `activity_warning` entries is still `PASS`.

**Measurement (claim gas and stage latency).** Every hop writes one
`hop_measurement` record to `activity.ndjson`, and `results.json` gets a `measurements`
key (`probeIntervalMs`, `hops`, `claimGas`, `stageLatency`, `excludedHops`). Claim gas
(`gasUsed`, `effectiveGasPrice`, the OP `l1Fee*` fields when the receipt carries them,
and whether the claim deployed the wrapper token) is read from the receipt the headless
driver already fetches: no extra RPC. The wrapper deploy is detected from the bridge's
`NewWrappedToken(uint32,address,address,bytes)` log. The optional config block
`measurement: { "stageProbeIntervalMs": 5000 }` (integer >= 1000, default off, headless
users only) starts a harness-origin probe after each bridge receipt that polls
`l1-info-tree-index`, `injected-l1-info-leaf` and `claim-proof` until the proof is
available; probe requests land in the `harness` bucket of the endpoint tables, never the
UI-parity numbers. The other `measurement` fields (`walletBalanceIntervalMs`, `l1InfoTree`,
`httpWindowMs`, `claimPreState`) are documented in
[Heavy-load measurement](#heavy-load-measurement-pump-samplers-stop-criteria).
`summary.md`'s `## Claim gas and stage latency` section (always last,
"No measurements recorded." for an older `results.json`) reports n / min / true median /
max over completed hops only; failed hops are counted beside the tables.

**The throughput identity.** `ticksOffered = lapStartsSubmitted + skippedBackpressure
+ ticksLostToRamp` — all four counted in the same unit (one per scheduler
lap-start-tick, the same unit as the requested `--rate`), and `summary.md` prints
whether the identity holds. **`hopBridgesSubmitted` is a separate, informational-only
counter** (per-hop bridge sends — a 3-hop ring reports roughly 3x `lapStartsSubmitted`)
and is explicitly **not** part of the identity — do not sum it into throughput math.

**`ui` vs `harness` origin split.** Every HTTP sample recorded against
`/tracker/v1/activity` (and other endpoints) carries an origin: `ui` is traffic the
real app UI would generate on its own (the headline figure — what real users
generate); `harness` is the tool's own control-flow polling that happens to hit the
same URL (headless workers have no `harness` component at all — see `PARITY.md`).
Read the `ui` number when asking "how much load does this put on the proxy in
practice"; the `harness` number should stay small relative to it.

**Latency self-disqualification.** If any resource sample's `eventLoopDelayP99Ms`
exceeds a 100ms threshold, `summary.md`'s Phase/Endpoint latency sections prepend a
banner stating the percentiles below are **not usable as server/proxy latency** for
this run (the tool's own single-process event loop was backed up, so the numbers
include queueing delay, not just request/response time) — see [Capacity
guidance](#capacity-guidance-measured).

**`aborted` means SIGINT/fatal only.** A run that served its full requested
`--minutes` and then drained in-flight laps normally is not marked `aborted` just
because laps were still in flight at the moment draining began; when every finished
lap is `LAP_DONE` it reads as `PASS`, e.g. `PASS (drained 12 in-flight laps)`. `aborted: true` (headline `ABORTED
(sigint)` or `ABORTED (fatal)`) is reserved for abnormal termination.

**`PASS` requires every finished lap to be `LAP_DONE`.** Headline precedence is
`ABORTED (...)` > `NO LAPS STARTED` > `FAIL (n of m lap(s) failed: <top failing hop
outcomes>)` (any `LAP_FAILED`) > `INCOMPLETE (n of m lap(s) aborted: <top hop
outcomes>)` (any `LAP_ABORTED`, e.g. `aborted_drain` at the drain deadline) > `PASS`.
A process exit code of 0 does not imply `PASS`; read the first line of `summary.md`.

**`NO LAPS STARTED` is not a pass.** A run that was not aborted but in which
`achieved.lapStartsSubmitted` is `0` is headlined `NO LAPS STARTED (0 lap starts —
nothing was exercised)` instead of `PASS`. This is what `--rate 1 --minutes 1`
produces (see [One lap per user](#one-lap-per-user-coverage-runs-not-load)). Treat
it as "the run proved nothing", not as a tool failure.

**`gasTokenChains` (optional).** When preflight discovered one or more
[gas-token chains](#gas-token-chains-eth-held-as-weth), `results.json` carries a
top-level `gasTokenChains` object keyed by chain key, each value
`{ gasTokenAddress, gasTokenNetwork, wethToken }`. It is omitted entirely when every
ring chain uses ETH as gas, so reports for ETH-only configs are unchanged.

## Heavy-load measurement: pump, samplers, stop criteria

These features exist for the heavy Bali campaign (many wallets, several hours). Every one of
them is **off by default**: a config without the `pump` and `measurement` blocks produces the
same `results.json` and `activity.ndjson` it always did (asserted by a flag-off golden test).

### The `pump` block (L1 deposit pump)

An optional, harness-side loop that sends one `bridgeAsset(destination, self, amount, 0x0,
forceUpdateGlobalExitRoot = true, 0x)` on the L1 every `intervalSeconds`, from a **dedicated
wallet**, so the L1 info tree keeps gaining leaves while the users bridge. It exists to test
whether more frequent L1 info-tree updates shorten the 85-origin `ready_to_claim` wait.

```jsonc
"pump": {
  "enabled": true,
  "chainKey": "SEPOLIA",          // must be the chain with networkId 0 (the L1)
  "destinationNetworkId": 82,     // a configured non-L1 network
  "walletIndex": 99,              // derived from users.wallets.mnemonicRef; outside the user range
  "amount": "0",                  // ETH, decimal string; default "0" (the bridge accepts 0, no dust)
  "intervalSeconds": 600,         // floor 60
  "maxTotalSpend": "0.07",        // ETH, hard cap for the whole run (gas + amount)
  "maxGasPriceGwei": 5            // pause while L1 gas is above this; also the maxFeePerGas of every pump tx
}
```

| Field | Meaning |
|---|---|
| `enabled` | `false` behaves exactly like an absent block, so a template can carry it switched off |
| `chainKey` | L1 chain key; else `PUMP_CHAIN_NOT_L1` |
| `destinationNetworkId` | must be a configured non-L1 network; else `PUMP_DESTINATION_UNKNOWN` |
| `walletIndex` | mnemonic index of the pump wallet. Must not fall in `[startIndex, startIndex + users.total)` (`PUMP_WALLET_OVERLAPS_USERS`, re-checked after `--users`), and needs `mnemonicRef` wallets (`PUMP_WALLET_REQUIRES_MNEMONIC`) |
| `amount` | ETH per deposit, default `"0"` |
| `intervalSeconds` | below 60 is `PUMP_INTERVAL_TOO_SHORT` |
| `maxTotalSpend` | `preflight` fails `PUMP_UNDERFUNDED` unless the pump wallet already holds at least this much on the L1. `fund` never funds the pump wallet; send it ETH yourself |
| `maxGasPriceGwei` | gas-price guard and `maxFeePerGas` of every pump tx |

Behaviour: the first deposit fires at run start, then one per interval until the run ends
(after the drain). One deposit is in flight at a time (`previous_pending` skips the tick). The
spend cap counts a pending deposit at its worst case (`gasLimit x maxFeePerGas + amount`) and
the pump stops for good when the next deposit could exceed it (`cap_reached`); a tick while
the gas price is above `maxGasPriceGwei` is skipped (`gas_price`) and the pump resumes later.
**Pump traffic is not user traffic**: it never counts in hops, laps, ticks or the verdict, and
its RPC requests are recorded in the `harness` origin bucket.

What it writes:

- `activity.ndjson`: `pump_state` (`started` / `stopped`), `pump_deposit` (tx hash, gas used,
  price, cost, cumulative spend) and `pump_skipped` (`gas_price`, `cap_reached`,
  `previous_pending`, `send_error`).
- `results.json` `pump` block (present only when the pump ran): `sender`,
  `destinationNetworkId`, `amountWei`, `intervalSeconds`, `maxTotalSpendWei`, `maxGasPriceWei`,
  `deposits[]`, `skipped{}`, `totalSpendWei`, `pendingAtStop`.
- `report.html`: the "Pump activity" section (spend versus cap, deposits, skips). The 5 s
  status line shows `pump=on(<settled>/<planned>,<spend>ETH)`.

**Measurement caveat: a pump-off baseline means no tool deposits, not no new leaves.** Under
load the PP network (82) settles certificates often, and every settlement that changes 82's
exit root adds an L1 info-tree leaf, which already unblocks 85-origin hops. So the pump may
show little effect, and that is a valid result. To make the comparison readable, enable
`measurement.l1InfoTree` in **both** runs (pump on and pump off): the leaf count in the run
window, split into leaves from the pump and leaves from other sources, is what tells a reader
why the 85 wait moved. Compare `hops.byRoute["BALI_85->BALI_82"].phases.ready_to_claim`
(p50/p90/max) and the `l1-info-tree-index` stage latency between the two runs.

If the ring's wallets run in several processes, put the pump in at most one config (a second
pump would double the deposits).

### New `measurement` fields

`measurement` is an optional block; every field is optional, but `measurement: {}` is still
rejected (`MEASUREMENT_EMPTY`). A field that is absent means that measurement is not taken
and nothing it would write appears in the outputs.

```jsonc
"measurement": {
  "stageProbeIntervalMs": 5000,       // existing: harness-origin stage probe (>= 1000)
  "walletBalanceIntervalMs": 300000,  // new: sample wallet balances every 5 min (>= 60000)
  "l1InfoTree": {                     // new: count L1 info-tree leaves during the run
    "pollIntervalMs": 60000,          //      >= 15000
    "gerManagerAddress": "0x2968D6d736178f8FE7393CC33C87f29D9C287e78"  // optional; default: discovered through the L1 bridge
  },
  "httpWindowMs": 60000,              // new: rolling HTTP stats per endpoint class (>= 10000)
  "claimPreState": true               // new: read wrapped-token state just before a claim
}
```

| Field | Outputs |
|---|---|
| `walletBalanceIntervalMs` | `wallet_balance` ndjson line per chain per sample (`n`, `minWei`, `medianWei`, `maxWei`, and the `lowest` wallets), and `results.json` `walletBalances[]`. Feeds SC9. The user wallets of every non-L1 ring chain are read with `eth_getBalance` |
| `l1InfoTree` | `l1_info_leaf` ndjson lines (block, leaf count, tx hash, `fromPump`), `l1_info_poll_error` on a failed poll, and `results.json` `l1InfoTree` (`gerManagerAddress`, `baselineLeafCount`, `leaves[]`, `pollErrors`). The baseline is read before the pump starts |
| `httpWindowMs` | one `http_window` ndjson line per window with per-class status counts and latency. ndjson only; it is what lets SC4 see proxy errors while the run is still going |
| `claimPreState` | `results.json` `measurements.hops[].claim.preState = { wrappedSupplyBefore, recipientBalanceBefore }`, read just before a wrapped-token claim (headless users only; absent when the read failed). It explains claim-gas differences: a claim that finds the wrapper supply and recipient balance already non-zero writes to non-zero storage slots and uses about 50k less gas than the first claim of that token |
| any field (block present) | `tx_sent` / `tx_receipt` ndjson lines for approve, bridge and claim txs (the SC5 denominator), and `approve` gas on each `hop_measurement` record |

Example with only the samplers and no stage probe:

```json
"measurement": { "walletBalanceIntervalMs": 300000, "l1InfoTree": { "pollIntervalMs": 60000 } }
```

### The `tracker_not_ready` error class

When the tracker answers `GET /tracker/v1/activity/from/{addr}` with **503** and a body
containing "not ready yet" ("activity for this address is not ready yet, retry after
<interval>", seen the first time an address is polled), the sample is classified
`tracker_not_ready`. It is **not** `proxy_5xx`: it never fails a hop, it is excluded from SC4,
and the headless worker does not retry it after 300 ms but backs off to the UI's own 5 s
cadence. It appears as its own row in the Errors table. A differently worded 503 still lands
in `proxy_5xx`, so a real outage is never hidden.

### Chain-key endpoint names

RPC endpoint classes in `results.json` `http`, `summary.md` and the HTML report are named by
chain key, `rpc/<CHAIN_KEY>/<method>` (for example `rpc/BALI_82/eth_getTransactionReceipt`),
instead of the provider host or URL path, so a keyed RPC URL never leaks through an endpoint
name. Runs recorded before this change are repaired at render time (the segment becomes
`rpc/<CHAIN_KEY>`, or `rpc/redacted` when no chain matches). Browser-mode samples fall back to
`rpc/redacted/...`.

### Failure rates and the strict verdict

The verdict is unchanged and strict: **FAIL on any single failed lap**. At several hundred
laps a few failures can happen without anything being wrong, so campaign go/no-go uses the stop
criteria below, not the verdict. The lap failure rate and the hard-hop failure rate are
computed by the exported `failureRates(results)` (`metrics/report.ts`) and shown next to the
verdict in the HTML report.

### Stop criteria SC1-SC13 and `check-stop`

The stop criteria are the campaign's go/no-go rules. They are **evaluated, never enforced**:
nothing in the tool stops a run by itself. The operator runs `check-stop` (every 10 minutes
during a campaign) and decides.

|  ID  | Criterion | Threshold | Action |
|---|---|---|---|
| SC1 | Hard hop failures | at least 5 hard failures (`revert_*`, `tx_revert`, `lbt_underflow`, `bridge_event_missing`, `activity_status_error`, `rpc_error`, `proxy_4xx`, `proxy_5xx`, `internal`), or at least 2% of ended hops once 50 have ended and at least 2 of them failed (judged over the whole run so far: one early failure that the run recovers from is not a rate) | drain |
| SC2 | 82-origin stall | no successful 82>85 hop for 30 min while one is in flight (the window starts at the later of the last success and the moment the route went from idle to in flight) | drain |
| SC3 | 85-origin stall | no successful 85>82 hop for 120 min while one is in flight (same window rule as SC2) | drain |
| SC4 | Proxy errors | at least 30 `proxy_5xx`/`proxy_4xx` errors in any 10 min window (`tracker_not_ready`, `not_ready`, `activity_warning` excluded) | drain |
| SC5 | Nonce conflicts | at least 20 `nonce_conflict` errors in the run | drain, lower `maxInflightLapsPerUser` |
| SC6 | Tool memory | `toolRssMb` above 4096 for 3 consecutive samples | drain |
| SC7 | Event-loop lag | `eventLoopDelayP99Ms` above 500 for 12 consecutive samples; latencies are invalid from then on | drain |
| SC8 | Tool CPU | `toolCpuPct` above 90 for 60 consecutive samples | drain |
| SC9 | Wallet balance floor | any wallet below 20% of `gasPerChain` (needs `walletBalanceIntervalMs`) | drain |
| SC10 | Funding floor | checked before the start: `fund` cap refusal, `PUMP_UNDERFUNDED`, funder balance; shown as `OUTSIDE` | do not start |
| SC11 | Pump spend | cumulative pump spend reaches `maxTotalSpend` (the pump stops before exceeding it, so this fires on a `cap_reached` skip or spend at or above the cap) | pump stops, run continues |
| SC12 | Shared Bali health | Grafana alerts, certificates in error, proxy restarts: **outside the tool**, shown as `OUTSIDE` | abort, tell the user |
| SC13 | Backpressure (gate) | `tick_skipped` is at least 25% of ticks | do not advance to the next stage |

`check-stop` reads `activity.ndjson` (and `results.json` when it exists) of the run directory:

```bash
# one run (the out/ folder of a run), human-readable table
pnpm loadtest check-stop --dir logs/loadtest/ring-I-20261014T170000Z/out

# two rings of one stage, JSON for scripting
pnpm loadtest check-stop --dir logs/loadtest/ring-I-20261014T170000Z/out \
                         --dir logs/loadtest/ring-J-20261014T170500Z/out --json

# explicit config when the run has no results.json yet (a run in progress)
pnpm loadtest check-stop --dir <run>/out --config <run>/config.json
```

Each criterion prints `FIRED`, `ok`, `N/A` (no data) or `OUTSIDE` (SC10 and SC12), with the
observed value. The command exits 0 even when a criterion fired. To act on SC1-SC9, drain
gracefully with one SIGINT (`loadtest.sh stop <ring> --drain` in the workspace runner); a
second SIGINT aborts without waiting for in-flight hops.

**Ctrl-C inside the tmux pane is not a drain.** It reaches the whole process group at once:
`pnpm` exits, `tee` dies, and the tsx parent relays the signal to the runner after only 30 ms,
killing it with no report if the event loop is busy (the runner is single-threaded and
`SC7` is 500 ms). Always use `loadtest.sh stop <ring> --drain` (it signals the one runner
process and records that it did, so a repeat is refused), `loadtest.sh stop` with no ring
drains every running ring (all signalled first, then it waits), and `loadtest.sh stop <ring>
--abort` is the deliberate second SIGINT of a drain in progress. A SIGINT that arrives during
preflight or start-up is held and the run drains as soon as it starts; one that arrives while
the report is being written is ignored.

### Ramp stages (explicit flags)

There is no preset engine in the tool: a stage is a set of explicit flags on `run`
(`--users`, `--rate`, `--minutes`). The campaign ramp used for Bali:

| Stage | Wallets (ring I + ring J) | `--users` I / J | `--rate` I / J | `--minutes` |
|---|---|---|---|---|
| 1 | 5 | 3 / 2 | 0.2 / 0.1 | 90 |
| 2 | 20 | 12 / 8 | 0.2 / 0.1 | 120 |
| 3a (pump off) | 50 | 30 / 20 | 0.2 / 0.1 | 120 |
| 3b (pump on) | 50 | 30 / 20 | 0.2 / 0.1 | 120 |

```bash
pnpm loadtest run --config ring-I.json --users 12 --browser 0 --rate 0.2 --minutes 120
```

Two rings run as two processes with disjoint wallet ranges. A stage advances only when none
of SC1-SC9 fired and SC13 stayed below 25%.

## HTML report (`out/report.html`)

`report.html` is **the human entrypoint** to a run. `results.json`, `activity.ndjson` and
`summary.md` exist for debugging and scripting; open the HTML first. It is written to
`<out>/report.html` at the end of every run (in a `finally`, so aborted and failed runs get one
too; a failure to render only logs a warning and never changes the run's result), and the
runner prints its path.

Sections, in page order:

1. **Verdict** banner (PASS / FAIL / INCOMPLETE / ABORTED / NO LAPS STARTED) with run identity
   and the reminder that go/no-go uses the stop criteria
2. **Key figures** (KPI cards)
3. **Throughput** (requested vs achieved, the throughput identity)
4. **Hop outcomes** by route and by mode
5. **Latency distributions per route** (min / median / p90 / max, per-stage breakdown)
6. **Lap and hop timeline**
7. **Claim gas**
8. **Gate stalls**
9. **Errors by class** (`tracker_not_ready` and `activity_warning` on their own rows)
10. **Proxy and endpoint health**
11. **Tool resources over time** (RSS, CPU, event loop, with the SC6-SC8 thresholds)
12. **Pump activity** (a one-line "pump off" note when the pump did not run)
13. **Stop criteria (post-hoc)**: SC1-SC13 plus the stage gate, evaluated read-only
14. **Wallet balances**
15. **Configuration (redacted)**
16. **Environment and report notes**

Guarantees:

- **Single self-contained file**: inline CSS, inline SVG charts, one inline script, no charting
  library. It makes **no network request** and works offline; the page ships a
  `Content-Security-Policy` of `default-src 'none'` (inline style, the one hashed script and
  `data:` images only), and it reads without scripts. It adapts to phone width and dark mode
  and has a print stylesheet.
- **Size cap**: 4 MiB by default (`--max-bytes N`). A larger run is downsampled in tiers
  (fewer timeline rows and per-hop points); the verdict banner and the Environment section say
  when that happened, so a thinned chart is never presented as complete.
- **Every dynamic value is HTML-escaped**, and the embedded data is escaped for a `<script>`.

### Redaction guarantees

- **Allowlisted config view.** The Configuration section is built from an allowlist of config
  keys, never by copying the config. RPC, proxy and UI addresses appear as host only
  (`https://host (path/query redacted)`), secret references as their name (`env:NAME`,
  `file:<basename>`), the output directory as its last path segment. A unit test walks the zod
  schema and fails when a new config field has no policy, so a new field cannot reach a report
  by accident.
- **Endpoint names by chain key** (above) and abbreviated transaction hashes.
- **Write-time scan.** Before the file is written the generator refuses (`ReportSecretError`,
  naming the field or kind, never the value) when the HTML contains a path segment, userinfo or
  query value taken from the unredacted config URLs, any 64-hex-character string (private-key
  shape), or a mnemonic-shaped string in the data. Nothing is written in that case.
- **`results.json` `config`.** The writer masks every chain `rpcUrl` that has a path, query or
  userinfo to `scheme://host/<redacted>`; a bare origin such as `http://203.0.113.10:8545` is
  kept. Other URL fields are masked only when they look secret-shaped, and secret references
  are `{ref: "env:NAME"}`. Run directories written before this change are **not rewritten**:
  they may still hold the original URL in `config`, but their reports and `summary.md` are
  redacted at render time, so regenerate and share the HTML, never an old `results.json`.

### Regenerating reports

```bash
# one run: HTML only, default path <dir>/report.html (dir is the run's out/ folder)
pnpm loadtest report --dir logs/loadtest/ring-G-20261013T145201Z/out --html

# write it somewhere else, with a smaller size cap
pnpm loadtest report --dir <run>/out --html --html-out reports/ring-G.html --max-bytes 2000000

# both summary.md (byte-identical re-render) and report.html
pnpm loadtest report --dir <run>/out

# roll-up of a campaign: label=dir[,dir]; the two rings of one stage share a label
pnpm loadtest campaign-report --out campaign.html \
  --run stage2=<I-run>/out,<J-run>/out \
  --run stage3a=<I-run3a>/out,<J-run3a>/out
```

`report --dir` reads `results.json` and `activity.ndjson` from `--dir`, and a `meta.txt` one
level up when the workspace runner wrote one (ring, users, minutes, rate). The roll-up
(`campaign-report`) puts the runs in one offline page (verdicts, failure rates, achieved rate,
pump state, stop criteria fired, ready-wait per route, L1 leaves per hour, comparison charts)
and links each row to that run's `report.html` by relative path.

## Autoclaim semantics

**Manual claim is the default.** Every route in the shipped examples and in the generated devnet config is
`{"expected": false}`: the tool claims each hop itself, with the user's own wallet, as soon as the hop is
`READY_TO_CLAIM` (outcome `hop_completed_manual`). The `autoclaim` map is still required by the schema (exactly
one entry per ring hop), but autoclaim itself is **optional** per hop: `{"expected": true, "waitMs": 120000}`
remains valid and makes the tool wait up to `waitMs` for a service-side claim before escalating to a manual one.
Use it only against an environment that actually runs an autoclaimer.

- **Devnet.** The vendored devnet runs aggkit `v0.11.0-rc17`, which removed the built-in autoclaim component
  ([agglayer/aggkit#1901](https://github.com/agglayer/aggkit/pull/1901)); `config/config.ci.devnet.json` sets
  `expectedAutoclaim: false` on every route. `autoclaimOverdue`, `unexpectedAutoclaim`, `hop_completed_auto` and
  `hop_completed_escalated` are all expected to be `0` (`tests/loadtest-e2e/run.spec.ts` asserts this).
- **Bali / testnet.** Default to `expected: false` too. Evidence from the Bali ring A run of 2026-10-06
  (0.00001 ETH): with autoclaim expected, hop 0 (Sepolia -> BALI_82) bridged at 12:04:24Z and was claimed after
  an `AWAITING_AUTOCLAIM` wait that ended 12:23:22Z (~16 min); hop 1 (82 -> 85, bridged 12:23:24Z) was claimed
  ~45 min later (~13:08Z). Waiting on a service-side claim is slow and unpredictable, so the tool claims manually.
- **`.claude/bin/loadtest.sh`.** Its `render()` forces `expected: false` and drops `waitMs` on every route
  (aggkit rc17 has no autoclaimer), whatever the template says.

Each ring hop (`"L1->L2A"`, etc.) has a configured autoclaim expectation:
`{"expected": false}` (manual claim, the default) or, optionally, `{"expected": true, "waitMs": 120000}`.

- **`autoclaim_overdue`** (only possible on a hop configured `expected: true`: the autoclaim didn't happen inside `waitMs`) and
  **`unexpected_autoclaim`** (a hop configured `expected: false` got auto-claimed
  anyway) are **counters, and neither one fails a hop.**
- An overdue autoclaim **escalates to a manual claim** and, if that succeeds, the
  hop still completes — recorded as outcome `hop_completed_escalated`, not a
  failure.
- If the network's own autoclaim wins a race against the tool's manual-claim attempt
  (`AlreadyClaimed` on submit), that is still a success: outcome
  `hop_completed_raced`.
- The full outcome set: `hop_completed_auto`, `hop_completed_manual`,
  `hop_completed_escalated`, `hop_completed_raced` — all four are successes; only
  `timeout_*`/`internal`/etc. outcomes are failures.

**What `unexpectedAutoclaim = 0` does and does not prove for an `expected: false`
(manual-claim) hop.** The tool claims such a hop itself, with the user's own wallet
(paid from that user's `gasPerChain` on the destination chain). A `0` therefore
means only that *autoclaim was not shown to act on the hop*; it does not prove autoclaim
did not claim it. The tool claims as soon as it first sees the hop `READY` (`core/ring.ts:751-759`),
and `unexpectedAutoclaim` is counted only when the row is already `CLAIMED` the first time
the tool sees it as ready (`core/ring.ts:699-705`, `applyAwaitingReady`: `!expected &&
!claimSubmitted`). An autoclaim that loses the race to the tool's own claim is invisible
(its transaction reverts `AlreadyClaimed` on the service's side), and a late autoclaim is not
detected; a service claim that lands after the tool has observed `READY` shows up at best as
`hop_completed_raced` / `claimRaceLost`. If such a hop ends `timeout_ready_to_claim` or
`aborted_drain` it was **not reached**, which is not a pass.

**A tracker `claimed` is verified before a hop completes (issue #53).** A tracker row that
reads `claimed` / `claim_status: claimed` is trusted only if it carries a claim object (claim
tx hash) or the destination bridge's `isClaimed` returns true (`confirmClaimedRows` in
`workers/headless/uiCallset.ts`, applied to every activity read in both modes). Otherwise the row
is treated as `PENDING` and the hop keeps waiting, ending with the usual timeout outcome instead
of a false `hop_completed_auto`. A failing `isClaimed` read counts as not claimed. Rows with a
claim object cost no extra RPC call.

**A `PASS` headline is not an autoclaim pass.** The headline only says the run was
not aborted and started at least one lap. Read `policy.autoclaimOverdue` and
`policy.unexpectedAutoclaim` as well.

## Gas-token chains (ETH held as WETH)

Some Agglayer chains (e.g. outposts such as Bali 63, whose native currency is Base
Sepolia ETH registered in the bridge as a token with origin `(63, sentinel)`) do not
use ETH as their gas token. There, bridged L1 ETH arrives as the bridge's own
`WETHToken()` ERC20, not as native currency, and bridging it back out is a privileged
**burn** of that WETH. The `eth` asset keeps its identity (leaf origin
`(networkId 0, 0x0)`) on every chain; only the form it is held in changes. This is the
same model the dev-ui app uses with `currency.wethToken` (`config/configSchema.mjs`,
`app/hooks/useBridgeExecution.ts`).

**There is no config field for this.** `preflight` discovers it live
(`wallets/preflight.ts`, `checkGasToken`), for every **ring** chain:

| `gasTokenAddress()` on the chain's `bridgeAddress` | Result |
|---|---|
| zero | ETH-gas chain — unchanged behaviour (`GAS_TOKEN` column `pass`) |
| non-zero, and `gasTokenNetwork()` + `WETHToken()` resolve (WETH non-zero) | **gas-token chain**: `pass`; identity recorded |
| non-zero but `WETHToken()` is zero / `gasTokenNetwork()` has no data, or the call fails / returns no data | `GAS_TOKEN_NOT_ETHER` (the only remaining way to get this code) |

When a gas-token chain is found, `preflight` (and the preflight step inside `run`) prints
one extra line below the table, and `results.json` records the same under
`gasTokenChains`:

```
gas-token chain "BALI_63": gasToken=0x0000003f0000003f0000003f0000003f0000003f originNetwork=63 weth=0x77290275947f166793b8d10428670e1fca26960a (eth held as WETH)
```

(`weth=` is the chain's own `WETHToken()`, lower-cased; the values shown are what Bali 63 returned on 2026-10-01.) The tool
asserts nothing about the discovered values; read the line and confirm it is the chain you
meant. Non-ring chains (e.g. the L1 in a ring that does not include it) are not probed.

What changes per hop, for the `eth` asset (`runner.ts` `buildHopSpecs`,
`workers/headless/headlessUser.ts` `bridge`):

| Hop leaves | Bridge call | Arrives on the destination as |
|---|---|---|
| an ETH-gas chain | `bridgeAsset(token = 0x0, msg.value = amount)` (unchanged) | native ETH on an ETH-gas chain; **WETH minted** on a gas-token chain |
| a gas-token chain | `bridgeAsset(token = WETHToken)`, `msg.value` 0, **no approval** | native ETH on an ETH-gas chain; WETH on another gas-token chain |

**Leaf identity check.** For every hop that touches a gas-token chain, the `BridgeEvent`
decoded from the bridge receipt must carry origin `(0, 0x0)` for the `eth` asset. Otherwise
the hop fails with an error whose message starts with `ASSET_IDENTITY_MISMATCH:` (it is
not a dedicated error class; expect it under `errors.byClass.internal`). This is the check
that would catch the tool silently bridging the chain's gas token instead of ETH. There is
no arrival-balance assertion: a hop still succeeds on tracker status plus `isClaimed`.

**Rules and refusals**

- `RING_ETH_START_ON_GAS_TOKEN_CHAIN` (`preflight`): an `eth` asset whose `ring[0]` is a
  gas-token chain is refused. Users would have to hold WETH before the first hop and the
  funder cannot supply it. Start the ring on an ETH-gas chain.
- `BROWSER_GAS_TOKEN_UNSUPPORTED` (`run`, after preflight passes): `users.browser > 0`
  together with a gas-token ring chain is refused. The browser build has no WETH currency
  entry for such a chain, so those users would bridge the native token. Use
  `--browser 0` (headless only). `fund` and `preflight` do not raise this code.
- A plain ETH-gas config (no gas-token chain among the ring chains) behaves and validates
  exactly as before; `validate` never talks to a chain, so a config containing a
  gas-token chain passes `validate` and only meets the rules above at `preflight`/`run`.
- Per-chain `bridgeAddress` was already supported; a gas-token chain commonly has a
  different bridge address from the L1 (Bali 63 does). Preflight's bytecode and gas-token
  reads use each chain's own `bridgeAddress`.

**Funding.** `users.funder.gasPerChain[<key>]` / `maxTotalSpend[<key>]` always mean that
chain's **native** currency, so for a gas-token chain they are denominated in the gas
token (Bali 63: Base Sepolia ETH). The funder must hold that currency on that chain.
WETH on a gas-token chain is never pre-funded: it arrives on the inbound hop.

**`LocalBalanceTreeUnderflow` (LBT).** Burning WETH out of a gas-token chain decrements
that chain's `localBalanceTree[(0, 0x0)]`, which inbound hops credit first, so a ring that
enters the gas-token chain before leaving it is safe. The `validate` check
`RING_MUST_START_AT_ASSET_ORIGIN` covers `erc20` assets only; for an `eth` asset a ring that
**starts on an L2** is not checked. Its first hop bridges that L2's own native ETH, so that
bridge's `localBalanceTree(keccak256(abi.encodePacked(uint32(0), address(0))))` (key
`0x827b659bbda2a0bdecce2c91b8b68462545758f3eba2dbefef18e0daf84f5ccd`) must already be at
least the bridge amount; check it with an `eth_call` before such a run. A revert that
comes back as raw selector data (`0x14603c01`, `LocalBalanceTreeUnderflow(uint32,address,
uint256,uint256)`) is classified `lbt_underflow` just like the decoded name.

(`DESIGN.md` §10 still describes the old behaviour — "refused at `validate`". The refusal
was never at `validate`, and it is now replaced by the discovery above.)

## One lap per user: coverage runs, not load

For route coverage (every route exercised once, not throughput) you want exactly one lap
per user. The scheduler's first tick for a user fires one full period after that user is
admitted (its token bucket starts empty), and nothing is issued at or after the offer
window's end (`core/scheduler.ts`; the pump runs every second in `runner.ts`). So:

| `--rate` | `--minutes` | `rampUpSeconds` | Laps per user |
|---|---|---|---|
| 1 | 1 | any | **0** — first tick lands exactly at the end; headline is `NO LAPS STARTED` |
| 1 | 2 | 0 (any `< 60`) | **exactly 1**, for any `--users`, independent of lap latency |
| 1 | 3 | 30 | 1 here only because of `maxInflightLapsPerUser: 1` back-pressure (2nd tick dropped as `skipped_backpressure`) |

The recommended coverage profile is `load: { bridgesPerMinutePerUser: 1, durationMinutes:
2, rampUpSeconds: 0, maxInflightLapsPerUser: 1 }` run as `--users 1 --browser 0 --rate 1
--minutes 2`. The report will show `ticksExpected = 2 x users` against `ticksOffered =
users`; that gap is cosmetic. Note that `--rate`/`--minutes` are applied after the schema
parse, so `RAMP_UP_EXCEEDS_DURATION` does not guard them.

**Wall clock is the drain, not `--minutes`.** After the offer window the run drains
in-flight laps. The drain deadline is the earlier of `drainStart + hopMs` and the latest
`hopStart + hopMs` over in-flight hops (`core/scheduler.ts`, `computeDrainDeadline`), and
when it passes, the current hop **and every later hop of that lap** end `aborted_drain`
(`core/ring.ts`, T29). In practice the whole lap must finish within about `hopMs` of its
current hop's start. On testnets with slow L2 -> L1 settlement, size `hopMs` (and `lapMs`,
which should be at least as large) to the expected lap time, or the negative-case last hop
is the one that gets cut. `Ctrl-C` depends on the phase (`runner.ts:1088-1097,1129-1141`,
`core/scheduler.ts:274-282`): during the offer window (`--minutes`) the first `Ctrl-C` starts a
normal drain and a second skips the grace period and writes the report; **after the offer
window has ended a single `Ctrl-C` aborts the run immediately** (the drain is already running, so
`beginDrain` just sets the deadline to now). Either way the headline is `ABORTED (sigint)`.

## Capacity guidance (measured)

From the target-scale validation runs (500 users/150 browser/30min and 1000
users/150 browser/15min, this host: 64 cores / 62 GiB RAM) — see `VALIDATION-1.md`
for the analysis behind them.

- **150 browser users is confirmed safe** on a host this size: 19 Chromium
  processes, peak host RAM 66% at 500 total users (40% at 1000). The **true ceiling
  was not reached** — both runs fixed `--browser 150`. Measured marginal cost is
  **~207 MB RSS per browser user**, which **extrapolates** to roughly **190-215
  browser users** before an 80%-RAM gate would trip — this is explicitly an
  extrapolation, not a measurement; do not treat it as a validated limit.
- **Headless: keep it to ~50 users per Node process.** All headless users in one
  `run` invocation share **one** event loop, so headless capacity does **not** scale
  with host core count the way browser capacity (multiple Chromium processes) does.
  Above the cap, hop/lap accounting stays correct (it's timer-based), but **latency
  percentiles become invalid and the report self-disqualifies them** — one run
  measured `eventLoopDelayP99Ms` at **35,433 ms** with 350 headless users against the
  100ms disqualification threshold (354x over).
- **Multi-process sharding across headless workers is a known, deferred item** — the
  tool does not yet have an inter-process collector-aggregation protocol. Until it
  does, run headless-heavy load tests as multiple invocations against disjoint user
  ranges (`users.wallets.startIndex`) rather than one oversized `--users`.

## Troubleshooting

Every item below cost real time during development — check these before assuming a
tool bug.

1. **`.env.local` overrides exported env vars and can hold stale Kurtosis values.**
   Next.js's config loading reads `.env.local` and it takes precedence over your
   shell's exported vars. This repo's own `.env.local` (once moved aside as
   `.env.local.bak`) has been deleted (R21/R12, loadtest/REVIEW.md — the
   `.bak` copy held a plaintext devnet key and was not gitignored); regenerate it
   with `node scripts/kurtosisDevnetEnv.mjs` against a running Kurtosis enclave if
   you need it, and if you do restore a `.env.local`, expect it to silently
   redirect the app at a dead ephemeral enclave port unless you know it's
   current. `.gitignore` now covers `.env.local*` / `.env*.bak` either way.
2. **Ensure `shm_size` is set on the `agglayer` service — otherwise network 1 can
   wedge, and preflight cannot see it.** Docker's default 64 MB `/dev/shm` starves
   agglayer's SP1 local prover's shared-memory mapping, and the prover crashes with
   **SIGBUS** (`CrashDetails { signal: 7 }`) on the first certificate that advances
   the local exit root, retries every 5 minutes, and never recovers
   (`RetryCertAfterInError=false`). This repo's `tests/devnet/docker-compose.yml`
   now sets `shm_size: '4gb'` on the `agglayer` service, which eliminates this
   crash entirely (root-caused and fixed, confirmed via
   `docker exec <agglayer> df -h /dev/shm`: 64M → 4.0G, zero `signal: 7` across a
   run that reliably crashed before). **If you are on an older checkout without
   that setting, add it** rather than treating this as expected behaviour. While
   this is happening, `/bridge/v1/sync-status` still reports `is_synced: true` —
   invisible to `preflight`. The check that **does** see it:
   ```bash
   curl -s http://127.0.0.1:9092/metrics | grep latest_certificate_in_error
   # also compare pending vs settled height:
   curl -s http://127.0.0.1:9092/metrics | grep 'agglayer_node_network_height'
   ```
   **Fallback recovery for an already-wedged instance** (e.g. you hit this before
   `shm_size` was set, or on an environment you don't control the compose file
   for): `docker compose -f tests/devnet/docker-compose.yml down && docker
   compose -f tests/devnet/docker-compose.yml up -d --wait`, then re-run
   `devnetReady`. **Run the certificate-health gate above before any load run** —
   otherwise you will measure a broken devnet and misattribute every
   `timeout_ready_to_claim` to the tool or to load. See `VALIDATION-1.md`'s C1
   retraction note for the full root-cause writeup.
3. **Stale wallet balances can mask funding bugs.** Low-index wallets accumulate
   tokens across repeated runs against the same devnet (one session's u0-u2 reached
   0.63 E2E after many runs). If you're specifically testing funding/budget
   behaviour, use a fresh `users.wallets.startIndex` so you're not looking at
   leftover balance from a previous run.
4. **`LocalBalanceTreeUnderflow` when bridging an L1-origin token from an L2.**
   That L2's LocalBalanceTree must already hold the token — the ring's first hop
   (L1 -> that L2) is what provides this. Surfaces at `eth_estimateGas`. If you
   see this, check the ring order: it must start at the asset's origin chain
   (enforced by `validate`'s `RING_MUST_START_AT_ASSET_ORIGIN` for `erc20` assets
   only — for `eth`, a ring starting on an L2 is not checked; see
   [Gas-token chains](#gas-token-chains-eth-held-as-weth)).
5. **`getByTestId` can silently match nothing in a hand-rolled Playwright page.**
   `testIdAttribute: 'data-test-id'` (this repo's convention) only applies to the
   Playwright `test`-fixture's page object. A page opened via a bare
   `chromium.launch()` (as the browser worker does) defaults to `data-testid`
   unless you configure it explicitly.
6. **`--rate 1 --minutes 2` specifically never reaches a second configured
   asset — this is a rate/duration artefact, not an asset round-robin defect
   (corrected in loadtest/REVIEW.md, "verified correct" §5).** The asset
   round-robin (`core/scheduler.ts`'s `pickAsset`) genuinely is round-robin
   and advances correctly. At `--rate 1`, each user gets exactly one
   lap-start tick per `60_000`ms period; over a 120-second (`--minutes 2`)
   window the first tick fires at ~t=60s (asset index 0) and the second's due
   instant is exactly `t=120s` — `pump()`'s strict `now >= stopAt` check
   excludes it, so it never fires at all, leaving every user parked on asset
   0. **`--rate 1 --minutes 3` (or any higher rate/duration) exercises every
   configured asset correctly** — size `--rate`/`--minutes` so every
   requested asset actually gets a turn (or check `activity.ndjson` to see
   which assets were exercised).
   The same arithmetic means `--rate 1 --minutes 1` starts **zero** laps and
   reads `NO LAPS STARTED` (see [One lap per user](#one-lap-per-user-coverage-runs-not-load)).
7. **aggkit's own `/metrics` is not exposed by this compose devnet** (`404` on
   both aggkit containers' metrics ports). Only **agglayer's** `:9092` is
   reachable — use it for the certificate-health check in item 2.
8. **`run` used to hang past `run: complete` without releasing its browser
   pool — fixed (R1)**, see the CLI reference note above. Still prefer
   waiting for the report files over the `run` PID as good practice.
9. **Gas-token chain codes.** `GAS_TOKEN_NOT_ETHER` now means only "this ring
   chain's `gasTokenAddress()` is non-zero but its WETH could not be resolved"
   (a non-zero gas token alone is accepted); `RING_ETH_START_ON_GAS_TOKEN_CHAIN`
   (`preflight`) and `BROWSER_GAS_TOKEN_UNSUPPORTED` (`run`, after preflight) are
   refusals; `ASSET_IDENTITY_MISMATCH:` is a hop error message prefix. All four are
   explained in [Gas-token chains](#gas-token-chains-eth-held-as-weth).
10. **`PREFLIGHT_SYNC_STATUS` never passes against a live testnet proxy.** The
    proxy's L1 bridge syncer trails the L1 head by its finality window (~12
    blocks), so with continuous deposits `is_synced` is never `true`. Opt in to a
    tolerance in blocks: `LOADTEST_PREFLIGHT_SYNC_LAG_BLOCKS=24 pnpm loadtest preflight ...`.
    A side (`l1_info`/`l2_info`) then also passes when `is_active` is `true` and
    `network_block - last_processed_block` is between 0 and N (missing block fields
    or a larger lag still fail); each tolerated side prints a `sync tolerance: ...`
    line. Unset (default `0`) keeps the strict check. A non-integer or negative
    value fails with `PREFLIGHT_SYNC_LAG_INVALID`. Not a secret; no credentials involved.

## Browser mode and CORS (opt-in local relay)

In browser mode the page reads tracker activity from the aggkit proxy cross-origin, so
the proxy must send CORS headers for the page's origin. The shared proxies only allow
their own domain family (e.g. `https://*.polygon.technology`), so a UI served from the
default local `uiBaseUrl` (`http://127.0.0.1:<port>`) can load, send transactions and
bridge, but cannot read tracker activity — the lap then fails with
`timeout_appears_in_activity`. Headless users are unaffected (no browser, no CORS).

- **When to use the relay:** local browser-mode runs against a shared proxy whose CORS
  allowlist does not include the origin the UI is served from. Enable it with
  `run --cors-relay` or `"browser": { "corsRelay": true }`. It is **off by default**.
- **What it does:** `run` starts a forwarder on `127.0.0.1` (random port), builds the UI
  with that URL as its proxy, and shuts the forwarder down when the run ends (including on
  SIGINT or a failed run). It forwards method, path, query, body and headers to
  `aggkitProxyUrl` unchanged (except `Host`, `Origin` and `Referer`), answers `OPTIONS`
  preflights itself, and replaces the response's CORS headers with ones for the UI's own
  origin. Browser users' own tracker polling runs inside the page, so it goes through the
  relay too; headless users, preflight and the harness samplers still go straight to the
  real proxy. It logs one `local-only CORS shim` line at start-up and the
  `browser.corsRelay: true` setting appears in the run's `results.json`.
- **Not needed in production-style deployments:** where the dev-ui is served under the
  allowlisted domain (e.g. `agglayer-dev-ui-devnet.polygon.technology` against
  `aggkit-proxy-devnet.polygon.technology`) the browser's request is cross-origin but
  already allowlisted, so run without the relay.
- **Security:** the relay adds **no authentication**. It only binds loopback, rejects
  non-loopback `Host` headers and sends CORS headers only for the UI's own origin — do not
  forward its port, bind it elsewhere or leave it running. It cannot be applied to a UI
  that is already being served (the relay URL is baked into the build `run` makes), so
  `run` refuses `corsRelay` when something already answers on `uiBaseUrl`.
- **Cost:** the proxy URL is part of the UI build, and the relay port is random, so a
  relay run does a fresh UI build each time instead of reusing the build cache.

## Two dev-ui changes this branch makes

This branch touches two files outside `loadtest/` — both scoped and gated so
nothing outside the load-test tool is affected:

1. **`app/context/e2eAccount.ts`** — a runtime E2E private-key override,
   `window.__AGGLAYER_E2E_PRIVATE_KEY__`, checked in addition to the build-time
   `NEXT_PUBLIC_E2E_PRIVATE_KEY`. It lets one E2E build serve many distinct signer
   keys (one per load-test browser worker) without a rebuild per key. It is honoured
   **only** when `IS_E2E_ENABLED` (`NEXT_PUBLIC_E2E_ENABLED=true` at build time) —
   production builds never read that `window` property. Set it via Playwright's
   `context.addInitScript` **before** calling `newPage()`, since it must run before
   the app bundle evaluates this module. An invalid override (not a `0x`-prefixed
   32-byte hex key) throws at module load rather than silently falling back.
2. **`next.config.ts`** — a gated Turbopack persistent build cache
   (`experimental.turbopackFileSystemCacheForBuild`), active **only** when the
   environment variable `LOADTEST_UI_BUILD=true` is set (which `loadtest/ui/build.ts`
   does itself). Dev, `pnpm run build`, `build:production`, the Docker image build,
   and the Cloudflare deploy are all unaffected — the flag is a no-op unless this
   tool sets it. It exists because `run` rebuilds the same app once per load-test
   invocation, and without the cache repeated builds showed zero reuse.

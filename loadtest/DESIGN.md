# Bridge load test — design

Status: normative.
Written during the initial design phase against branch `feat/bridge-loadtest` @ `d5529b3`.

This document fixes the contracts the implementation follows and that audits
check it against. Every claim here is written to be **falsifiable**: each one
either cites a file (`path:line`) that can be re-read, a measured number with
its measurement, or names the test that must verify it. Where a fact could not
be established when this document was written, it is marked **[VERIFY]** with
the exact check that settles it — an unmarked claim is asserted as true today,
and an audit may treat a contradiction as a finding.

Terminology: **hop** = one bridge from one ring chain to the next, including
its claim. **lap** = one full traversal of the ring (all hops), returning the
asset to the ring's start chain. **user** = one wallet + one driver (browser
or headless). **driver** = the `userDriver` interface both worker kinds
implement.

---

## 0. Sources of truth

| Subject | Authoritative source | Notes |
|---|---|---|
| UI call set and cadences | `app/services/activity.ts`, `app/hooks/*.ts` (read in full during the initial design phase, see §9) | §9 is a line-cited table |
| Devnet topology (ports, ids, addresses, keys) | `tests/devnet/summary.json` + `tests/devnet/docker-compose.yml` port env vars | never hardcode; derive |
| Devnet autoclaim expectations | `config/config.ci.devnet.json` → `autoclaim` | maps 1:1 onto `RouteType`; all `expected: false` on the rc17 devnet |
| Autoclaim defaults when config omits a route | `app/config.ts:22-27` (`DEFAULT_AUTOCLAIM_CONFIG`) | l1→l2 60 s, l2→l1 disabled, l2→l2 120 s |
| Testnet topology | repo `config.json` → `chains.SEPOLIA`, `chains.BOKUTO`, `appModes.configs.testnet` | **its `aggkitProxy` is a placeholder** — see §2.4 |
| Route classification | `app/utils/autoclaim.ts:11-17` (`getRouteType`) | keyed on **recording** network, not token origin |
| Devnet phase timings | the measured devnet ranges (§3.3) + `app/constants/e2e.ts:88-161` | **not** `BASELINE.md`'s "<30 s" (see §0.1) |
| SDK wire behaviour | `node_modules/@agglayer/sdk` @ `1.0.0-snapshot-ca6df75e` | the pinned snapshot, never `../sdk` HEAD |
| Hop-ring shape, gas offset, gate-stall accounting | aggkit `origin/feat/bridge-loop-tester:tools/bridge_loop_tester/{DESIGN,README}.md` | **reference only**, no code dependency |
| `BridgeEvent` → `depositCount` decode | `sdk/scripts/aggkit-smoke.ts:539-563` | scan all receipt logs; ERC20 also emits `Transfer` |
| LocalBalanceTree seeding rationale | `tests/bridge/models/bridge-page.ts:253-275`, `sdk/scripts/aggkit-smoke.ts:566-608` | first ring hop L1→L2 provides the credit |

### 0.1 Two facts this document deliberately does **not** take from `BASELINE.md`

1. `loadtest/BASELINE.md:80` records "L1→L2 Autoclaim Latency <30 s" (an rc8, built-in-autoclaimer
   figure, now historical). That is
   the **whole `claim-autoclaim.spec.ts` (since renamed `claim-l1-to-l2.spec.ts`) wall clock** (page load + connect +
   deposit + autoclaim), not an isolated autoclaim measurement. Every timeout
   in §3.3 is sized from the measured devnet ranges and from
   `app/constants/e2e.ts`, never from that figure.
2. `loadtest/BASELINE.md:52` embeds the devnet E2E private key in plaintext.
   That key is the committed devnet fixture already present in
   `tests/devnet/summary.json:accounts.e2e_wallet.private_key`, so it is not
   a secret — but **this document does not repeat it and the config schema
   forbids inline private keys entirely** (§2.2, `secretRef` rule). An audit should
   classify the `BASELINE.md` occurrence as *accepted, devnet-fixture-only*.

---

## 1. Component map

```
cli.ts run
  └─ config/load.ts ──> validated LoadtestConfig (§2)
  └─ wallets/{derive,fund,preflight}.ts (§4)
  └─ core/scheduler.ts (§3.5) ──ticks──> core/ring.ts (§3) per user
                                            │
                              userDriver (§1.1) implemented by
                              ├─ workers/headless/headlessUser.ts (§9 parity)
                              └─ workers/browser/browserUser.ts  (§7 pool)
  └─ metrics/collector.ts (§5) ──> metrics/report.ts (§6)
```

### 1.1 `userDriver` interface (implemented twice, identically observable)

```ts
interface UserDriver {
  readonly userId: string;          // deterministic: `u{index}` (§4.1)
  readonly mode: 'browser' | 'headless';
  readonly address: Address;

  init(): Promise<void>;            // browser: launch context, navigate, connect
  bridge(hop: HopSpec): Promise<BridgeSubmission>;   // approve? + bridgeAsset
  observeActivity(): Promise<ObservedRow[]>;         // the UI's activity poll
  claim(hop: HopSpec, row: ObservedRow): Promise<ClaimSubmission>;
  dispose(): Promise<void>;
}
```

Both implementations MUST emit the same `Phase` timers (§5.1) and the same
`endpointClass` HTTP samples (§5.2). `gas.bridgeGasOffset` used to be the one
permitted behavioural divergence, because the UI could not apply it; **that
was closed** — the UI's bridge send now adds the same `+300_000` as
`BRIDGE_GAS_BUFFER` (§9.3 finding **C5**), so the two modes send identical gas
headroom and §9.4 lists no gas divergence. Any divergence is a bug an audit
should flag.

---

## 2. Configuration schema (`loadtest.config.json`)

One schema, two producers: `loadtest derive-devnet` (generated) and a
hand-written file for testnet/mainnet. Implemented as zod in
`loadtest/config/schema.ts`, style-matched to
`config/configSchema.mjs`.

**Round-trip definition** (`config/schema.test.ts`):
for each example file `X` in §2.3/§2.4,
`schema.parse(JSON.parse(serialize(schema.parse(JSON.parse(read(X))))))` deep-equals
`schema.parse(JSON.parse(read(X)))`, where `serialize` is
`JSON.stringify(value, null, 2)`. This is asserted for **both** examples, so
the schema may not have defaults that are lost on write-back.

### 2.1 Field reference

| Path | Type | Required | Default | Validation |
|---|---|---|---|---|
| `env` | `'devnet' \| 'testnet' \| 'mainnet'` | yes | — | — |
| `uiBaseUrl` | url | only if `users.browser > 0` | — | http(s) |
| `aggkitProxyUrl` | url | yes | — | no trailing `/`; must NOT end in `/bridge/v1` or `/tracker/v1` (the SDK and `fetchActivity` append those — `app/services/activity.ts:341`) |
| `chains[]` | array, ≥2 | yes | — | see below |
| `chains[].key` | string | yes | — | unique, matches `^[A-Z0-9_]+$` |
| `chains[].chainId` | int >0 | yes | — | unique across `chains` |
| `chains[].networkId` | int ≥0 | yes | — | unique across `chains`; **exactly one** chain may have `networkId === 0` |
| `chains[].rpcUrl` | url | yes | — | — |
| `chains[].bridgeAddress` | address | yes | — | non-zero |
| `chains[].explorerUrl` | string | no | `''` | — |
| `chains[].nativeSymbol` | string | no | `'ETH'` | report labelling only |
| `ring[]` | array of `chains[].key`, ≥3 entries | yes | — | closed: `ring[0] === ring[at(-1)]`; ≥2 hops; every consecutive pair distinct; every key present in `chains` |
| `autoclaim` | record keyed `"<FROM>-><TO>"` | yes | — | **exactly** one entry per ring hop, no extras (the schema rejects both directions of mismatch) |
| `autoclaim[hop].expected` | bool | yes | — | `false` = manual claim (the default everywhere); `true` = optionally wait for a service-side autoclaim |
| `autoclaim[hop].waitMs` | int >0 | required iff `expected` | — | grace window before escalation (§3.4) |
| `assets[]` | array, ≥1 | yes | — | at most one `kind:'eth'`; `address` unique per `kind:'erc20'` |
| `assets[].kind` | `'eth' \| 'erc20'` | yes | — | — |
| `assets[].address` | address | iff `erc20` | — | non-zero |
| `assets[].originNetworkId` | int ≥0 | iff `erc20` | — | must match some `chains[].networkId` |
| `assets[].amount` | decimal string | yes | — | >0; parsed with `assets[].decimals` |
| `assets[].decimals` | int 0–36 | no | `18` | — |
| `users.total` | int ≥1 | yes | — | — |
| `users.browser` | int ≥0 | yes | — | ≤ `users.total` |
| `users.wallets` | `{mnemonicRef, startIndex}` \| `{privateKeysRef}` | yes | — | exactly one variant (§2.2) |
| `users.funder.privateKeyRef` | secret ref | required unless `env==='devnet' && users.devnetFunding==='anvil_setBalance'` | — | §2.2 |
| `users.funder.gasPerChain` | record `chainKey → decimal string` | yes if funder present | — | one entry per **ring** chain |
| `users.funder.assetTopUp` | decimal string | no | `assets[i].amount × (ceil(load.bridgesPerMinutePerUser × load.durationMinutes) + load.maxInflightLapsPerUser)` (see VALIDATION-1.md A1; was a flat `× 4`) | per asset, applied to the ring's start chain |
| `users.funder.maxTotalSpend` | record `chainKey → decimal string` | yes if funder present | — | hard cap, §4.3 |
| `users.devnetFunding` | `'anvil_setBalance' \| 'transfer'` | iff `env==='devnet'` | `'anvil_setBalance'` | **rejected when `env !== 'devnet'`** |
| `load.bridgesPerMinutePerUser` | number >0 | yes | — | — |
| `load.durationMinutes` | number >0 | yes | — | — |
| `load.rampUpSeconds` | int ≥0 | no | `60` | — |
| `load.maxInflightLapsPerUser` | int ≥1 | no | `3` | §3.5 |
| `browser.contextsPerBrowser` | int 1–8 | no | `8` | cap is a hard schema max — lowered from 25 to 8 (VALIDATION-1.md A3: 25 let `slotCount` collapse to 1 Chromium for a 20-browser-user run, so one crash took out every browser user) |
| `browser.headless` | bool | no | `true` | — |
| `browser.trace` | bool | no | `false` | **Not yet wired up (R25, loadtest/REVIEW.md)** — accepted by the schema but no call site reads it (no `context.tracing.start()`/`stop()` anywhere in `loadtest/`). Whoever wires it up must route the Playwright trace file through redaction first: a trace at higher verbosity records the literal arguments passed to `context.addInitScript(fn, key)` — i.e. the raw per-user private key. |
| `browser.recycleContextAfterLaps` | int ≥1 | no | `10` | §7.4 |
| `browser.corsRelay` | bool | no | off (absent) | §8.1 — local-only CORS shim for browser mode; also `run --cors-relay` |
| `timeouts.*` | ints (ms) | no | §3.3 table | every key has a default; all overridable |
| `gas.bridgeGasOffset` | int ≥0 | no | `300000` | headless only (§9.4) |
| `gas.claimGasOffset` | int ≥0 | no | `60000` | headless only, claim send only (§9.4); additive margin on the SDK claim `gas` (or one `eth_estimateGas`); `0` = viem's own estimate, as the UI does |
| `measurement` | object (optional) | no | absent = off | strict; at least one field when present (`MEASUREMENT_EMPTY`). Every field below is optional; an absent field takes no measurement and writes nothing |
| `measurement.stageProbeIntervalMs` | int ≥1000 | no | — | harness-origin stage probe, headless users only |
| `measurement.walletBalanceIntervalMs` | int ≥60000 | no | — | periodic `eth_getBalance` of every user wallet on every non-L1 ring chain (heavy-load M1; feeds SC9) |
| `measurement.l1InfoTree` | `{pollIntervalMs, gerManagerAddress?}` | no | — | `pollIntervalMs` ≥15000; polls the L1 GER manager's `UpdateL1InfoTreeV2` logs; `gerManagerAddress` (non-zero) skips discovery through the L1 bridge (M3) |
| `measurement.httpWindowMs` | int ≥10000 | no | — | per-window HTTP status/latency records, ndjson only (M4) |
| `measurement.claimPreState` | bool | no | — | read wrapped-token supply and recipient balance just before a wrapped-token claim, headless only (M9) |
| `pump` | object (optional) | no | absent = off | the L1 deposit pump (§4.6); strict. `enabled: false` behaves like an absent block |
| `pump.enabled` | bool | iff `pump` | — | — |
| `pump.chainKey` | chain key | iff `pump` | — | must name the chain with `networkId 0` (`PUMP_CHAIN_NOT_L1`) |
| `pump.destinationNetworkId` | int ≥0 | iff `pump` | — | the `networkId` of a configured non-L1 chain (`PUMP_DESTINATION_UNKNOWN`) |
| `pump.walletIndex` | int ≥0 | iff `pump` | — | mnemonic index of the pump wallet; outside `[startIndex, startIndex + users.total)` (`PUMP_WALLET_OVERLAPS_USERS`, re-checked after `--users`); requires `mnemonicRef` wallets (`PUMP_WALLET_REQUIRES_MNEMONIC`) |
| `pump.amount` | decimal string ≥0 | no | `"0"` | ETH per deposit; the bridge accepts 0 |
| `pump.intervalSeconds` | int >0 | iff `pump` | — | ≥60 (`PUMP_INTERVAL_TOO_SHORT`) |
| `pump.maxTotalSpend` | decimal string >0 | iff `pump` | — | ETH; hard spend cap for the run. Preflight needs the pump wallet to hold at least this much (`PUMP_UNDERFUNDED`) |
| `pump.maxGasPriceGwei` | number >0 | iff `pump` | — | pause threshold and `maxFeePerGas` of every pump tx |
| `output.dir` | path | no | `loadtest-results/<ISO-8601 basic timestamp>` | `validate` **warns** (does not fail) when `output.dir` is inside the repo and not matched by `.gitignore`. `.gitignore` covers `loadtest.config.json` and `loadtest-results/` |
| `output.activityLog` | bool | no | `true` | writes `activity.ndjson` |

Cross-field validations the schema must reject with a readable message (each gets a
named negative test):

- `ring` not closed → `RING_NOT_CLOSED`
- `ring` shorter than 3 entries / fewer than 2 hops → `RING_TOO_SHORT`
- `ring` key not in `chains` → `RING_UNKNOWN_CHAIN`
- duplicate `chains[].networkId` or `chainId` → `CHAIN_ID_DUPLICATE`
- zero or >1 chain with `networkId === 0` → `L1_CHAIN_AMBIGUOUS`
- `autoclaim` missing a ring hop → `AUTOCLAIM_HOP_MISSING`
- `autoclaim` entry not a ring hop → `AUTOCLAIM_HOP_UNKNOWN`
- `expected: true` without `waitMs` → `AUTOCLAIM_WAIT_REQUIRED`
- `users.browser > 0` without `uiBaseUrl` → `UI_BASE_URL_REQUIRED`
- `devnetFunding` set on a non-devnet env → `DEVNET_FUNDING_NOT_ALLOWED`
- any string in the parsed document matching `/^0x[0-9a-fA-F]{64}$/` → `INLINE_PRIVATE_KEY_FORBIDDEN` (§2.2)

### 2.2 Secrets never live in the config file

Every private key is a **`secretRef`**, one of:

- `{"env": "LOADTEST_FUNDER_PRIVATE_KEY"}`
- `{"file": "/abs/path/to/key"}` (file contents trimmed; must be mode `0600` or the loader refuses)

The schema rejects any 32-byte hex literal anywhere in the document
(`INLINE_PRIVATE_KEY_FORBIDDEN`). Consequences:

- `derive-devnet` writes `{"env": "LOADTEST_DEVNET_FUNDER_KEY"}` and prints a
  one-line hint naming `tests/devnet/summary.json`'s
  `accounts.e2e_wallet.private_key` as the value to export — it does **not**
  copy the key into the generated file.
- `metrics/errors.ts` redacts any `0x[0-9a-fA-F]{40,}` run to
  `0x…<last4>` before a message reaches a log, `results.json`,
  `activity.ndjson` or `summary.md` (asserted by tests on every log path).

### 2.3 Worked example — devnet (generated by `derive-devnet`)

```jsonc
{
  "env": "devnet",
  "uiBaseUrl": "http://127.0.0.1:3100",
  "aggkitProxyUrl": "http://127.0.0.1:8555/aggkitapi",
  "chains": [
    { "key": "L1",  "chainId": 271828, "networkId": 0,
      "rpcUrl": "http://127.0.0.1:8555/l1rpc",
      "bridgeAddress": "0xC8cbEBf950B9Df44d987c8619f092beA980fF038",
      "explorerUrl": "" },
    { "key": "L2A", "chainId": 20201, "networkId": 1,
      "rpcUrl": "http://127.0.0.1:8555/l2rpc-001",
      "bridgeAddress": "0xC8cbEBf950B9Df44d987c8619f092beA980fF038",
      "explorerUrl": "" },
    { "key": "L2B", "chainId": 20202, "networkId": 2,
      "rpcUrl": "http://127.0.0.1:8555/l2rpc-002",
      "bridgeAddress": "0xC8cbEBf950B9Df44d987c8619f092beA980fF038",
      "explorerUrl": "" }
  ],
  "ring": ["L1", "L2A", "L2B", "L1"],
  "autoclaim": {
    "L1->L2A":  { "expected": false },
    "L2A->L2B": { "expected": false },
    "L2B->L1":  { "expected": false }
  },
  "assets": [
    { "kind": "eth", "amount": "0.001", "decimals": 18 },
    { "kind": "erc20", "address": "0xe293A6b8F558422813499bb5C89B60adD8c54636",
      "originNetworkId": 0, "amount": "0.01", "decimals": 18 }
  ],
  "users": {
    "total": 400, "browser": 100,
    "wallets": { "mnemonicRef": { "env": "LOADTEST_MNEMONIC" }, "startIndex": 0 },
    "funder": {
      "privateKeyRef": { "env": "LOADTEST_DEVNET_FUNDER_KEY" },
      "gasPerChain": { "L1": "0.05", "L2A": "0.05", "L2B": "0.05" },
      "maxTotalSpend": { "L1": "500", "L2A": "500", "L2B": "500" }
    },
    "devnetFunding": "anvil_setBalance"
  },
  "load": { "bridgesPerMinutePerUser": 2, "durationMinutes": 30,
            "rampUpSeconds": 60, "maxInflightLapsPerUser": 3 },
  "browser": { "contextsPerBrowser": 8, "headless": true, "trace": false,
               "recycleContextAfterLaps": 10 },
  "timeouts": {
    "txReceiptMs": 60000, "appearsInActivityMs": 60000,
    "readyToClaimMs": 900000, "claimedMs": 900000, "hopMs": 1200000,
    "lapMs": 3600000, "pageLoadMs": 30000, "walletConnectMs": 15000
  },
  "gas": { "bridgeGasOffset": 300000 },
  "output": { "dir": "loadtest-results/20260910T120000Z", "activityLog": true }
}
```

Field provenance — every value above has a named source:

| Field | Source |
|---|---|
| `aggkitProxyUrl` | `tests/devnet/summary.json` `.aggkit_proxy.rest_url_via_proxy`; host port overridden by compose env `DEVNET_PROXY_PORT` (`tests/devnet/docker-compose.yml:210`, default `8555`). Direct alternative `.aggkit_proxy.rest_url` (`AGGKIT_PROXY_PORT`, default `8556`, `docker-compose.yml:172`) |
| `chains[].chainId` | `.chain_ids.{l1,l2_001,l2_002}` = 271828 / 20201 / 20202 |
| `chains[].networkId` | `.network_ids.{l1,l2_001,l2_002}` = 0 / 1 / 2 |
| `chains[].rpcUrl` | `.networks.l1.rpc.via_proxy`, `.networks.l2.001.rpc.via_proxy`, `.networks.l2.002.rpc.via_proxy` (env `L1_RPC_PORT` / `L2_001_HTTP_PORT` / `L2_002_HTTP_PORT` select the direct ports 8545 / 11545 / 12545 instead — `docker-compose.yml:43,56,69`) |
| `chains[].bridgeAddress` | `.networks.l1.contracts.bridge` and `.networks.l2.00N.contracts.sovereign_bridge` (all three identical, CREATE2 — cross-checked by `scripts/devnetReady.mjs:42`) |
| `autoclaim.*` | `config/config.ci.devnet.json` → `autoclaim` (all three routes `expectedAutoclaim: false` since the devnet moved to aggkit rc17, which has no autoclaimer; it used to be `l1_to_l2` true/120000, `l2_to_l2` true/300000, `l2_to_l1` false), mapped per ring hop through `getRouteType` (`app/utils/autoclaim.ts:11-17`). Routes omitted from that file fall back to `app/config.ts:22-27` |
| `assets[0].amount` | `app/constants/e2e.ts:140` devnet `DEFAULT_NATIVE_BRIDGE_AMOUNT = '0.001'` |
| `assets[1].address` | `.erc20_address` = `0xe293A6b8F558422813499bb5C89B60adD8c54636` ("Agglayer E2E Token"/`E2E`, 18 dp) |
| `assets[1].amount` | `app/constants/e2e.ts:145` `E2E_ERC20_BRIDGE_AMOUNT = '0.01'` |
| `assets[1].originNetworkId` | 0 — the token is deployed on L1 (`.accounts.e2e_wallet.description`: holder of `erc20_address`; L1 is the only chain it exists natively on) |
| `users.funder.privateKeyRef` | env indirection; the value to export is `.accounts.e2e_wallet.private_key` (address `0xE34aaF64b29273B7D567FCFc40544c014EEe9970`) — **not written into the file** (§2.2) |
| `users.funder.assetTopUp` | omitted — `wallets/fund.ts`'s `defaultAssetTopUp` derives it from this file's own `load.bridgesPerMinutePerUser`/`durationMinutes`/`maxInflightLapsPerUser` (VALIDATION-1.md A1); for the `load` values above that is `0.01 × (60 + 3) = 0.63` |
| `timeouts.readyToClaimMs`, `timeouts.claimedMs` | originally `app/constants/e2e.ts:103,106` (`DEFAULT_L2_TO_L2_CLAIM_TIMEOUT_MS`, `DEFAULT_PROOF_READY_TIMEOUT_MS`, both 600 000); **raised to 900 000 by a live acceptance-run measurement** — see §3.3 |
| `timeouts.txReceiptMs` | `app/constants/e2e.ts:151` devnet `DEFAULT_BRIDGE_SUCCESS_TIMEOUT_MS = 60_000` |
| `gas.bridgeGasOffset` | aggkit `bridge_loop_tester` README `GasLimitOffset` row: "300000 is a good starting point … `forceUpdateGlobalExitRoot = true`, so two bridges in the same block make the second one cost more than its own estimate predicted and revert `OutOfGas` inside `updateExitRoot`" |
| `uiBaseUrl`, `output.dir`, `users.total/browser`, `load.*`, `browser.*` | loadtest-owned; no upstream source. `browser.contextsPerBrowser ≤ 8` bounds crash blast radius and Playwright memory creep, lowered per VALIDATION-1.md A3 |

### 2.4 Worked example — testnet (hand-written)

```jsonc
{
  "env": "testnet",
  "uiBaseUrl": "http://127.0.0.1:3100",
  "aggkitProxyUrl": "https://REPLACE-ME-testnet-aggkit-proxy",
  "chains": [
    { "key": "SEPOLIA", "chainId": 11155111, "networkId": 0,
      "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
      "bridgeAddress": "0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582",
      "explorerUrl": "https://sepolia.etherscan.io" },
    { "key": "BOKUTO", "chainId": 737373, "networkId": 37,
      "rpcUrl": "https://rpc-katana-bokuto.t.conduit.xyz",
      "bridgeAddress": "0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582",
      "explorerUrl": "https://bokuto.katanascan.com/" }
  ],
  "ring": ["SEPOLIA", "BOKUTO", "SEPOLIA"],
  "autoclaim": {
    "SEPOLIA->BOKUTO": { "expected": false },
    "BOKUTO->SEPOLIA": { "expected": false }
  },
  "assets": [
    { "kind": "eth", "amount": "0.00001", "decimals": 18 }
  ],
  "users": {
    "total": 2, "browser": 1,
    "wallets": { "mnemonicRef": { "env": "LOADTEST_MNEMONIC" }, "startIndex": 0 },
    "funder": {
      "privateKeyRef": { "file": "/run/secrets/loadtest-sepolia-funder" },
      "gasPerChain": { "SEPOLIA": "0.01", "BOKUTO": "0.005" },
      "assetTopUp": "0.00004",
      "maxTotalSpend": { "SEPOLIA": "0.2", "BOKUTO": "0.1" }
    }
  },
  "load": { "bridgesPerMinutePerUser": 1, "durationMinutes": 5,
            "rampUpSeconds": 30, "maxInflightLapsPerUser": 1 },
  "browser": { "contextsPerBrowser": 1, "headless": true, "trace": true,
               "recycleContextAfterLaps": 10 },
  "timeouts": {
    "txReceiptMs": 120000, "appearsInActivityMs": 120000,
    "readyToClaimMs": 1800000, "claimedMs": 1800000, "hopMs": 2400000,
    "lapMs": 5400000, "pageLoadMs": 60000, "walletConnectMs": 30000
  },
  "gas": { "bridgeGasOffset": 300000 },
  "output": { "dir": "loadtest-results/testnet-smoke", "activityLog": true }
}
```

Field provenance:

| Field | Source |
|---|---|
| `chains.SEPOLIA.*` | repo `config.json` → `chains.SEPOLIA` (`id` 11155111, `networkId` 0, `rpcUrl`, `explorerUrl`) |
| `chains.BOKUTO.*` | repo `config.json` → `chains.BOKUTO` (`id` 737373, `networkId` 37, `rpcUrl`, `explorerUrl`) |
| `chains[].bridgeAddress` | `config.json` → `appModes.configs.testnet.bridgeAddress` = `0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582`. Neither `SEPOLIA` nor `BOKUTO` declares a per-chain override, so `buildModeConfig` (`app/config.ts:157-165`) resolves both to the mode default — the loadtest config flattens that resolution |
| `autoclaim.*` | manual claim by default: both routes `expected: false` (the app's `config.json` → `autoclaim` has `l1_to_l2` true/120000, but the Bali ring A run of 2026-10-06 showed autoclaim taking ~16 min then ~45 min, see §3.4), mapped through `getRouteType`: Sepolia is `networkId 0` so `SEPOLIA->BOKUTO` is `l1_to_l2` and `BOKUTO->SEPOLIA` is `l2_to_l1` |
| `assets[0].amount` | `app/constants/e2e.ts:140` testnet `DEFAULT_NATIVE_BRIDGE_AMOUNT = '0.00001'` |
| `timeouts.*` | scaled from `app/constants/e2e.ts:151-152` testnet defaults (`120_000` bridge success, `300_000` claim) plus real-testnet settlement headroom; `readyToClaimMs`/`claimedMs` are deliberately 3× the devnet value and are **[VERIFY]** — the testnet smoke run records the observed values in its report and this table is updated from them |
| `aggkitProxyUrl` | **NOT available from the repo.** `config.json` → `appModes.configs.testnet.aggkitProxy` is the literal string `https://PLACEHOLDER-testnet-aggkit-proxy`. It must be supplied by the operator (or via the app's `NEXT_PUBLIC_AGGKIT_PROXY` override, read at `app/config.ts:65` and applied at `:108`). `config/examples/testnet.loadtest.json` therefore ships the value `https://REPLACE-ME-testnet-aggkit-proxy`, and `loadtest validate` **fails** on any host containing `PLACEHOLDER` or `REPLACE-ME` (`PROXY_URL_PLACEHOLDER`) |

Two structural notes on testnet, both consequences of `config.json` and not
choices:

- Testnet mode has **two** chains, so the ring has exactly 2 hops
  (`SEPOLIA→BOKUTO→SEPOLIA`); the 3-chain `L1→L2A→L2B→L1` shape is
  devnet-only. The schema's `ring` rules already permit this.
- Bokuto's `networkId` is **37**, not 1. Nothing may assume L2 network ids are
  small or contiguous.

---

## 3. Hop and lap state machine

Pure, I/O-free, injected clock; lives in `loadtest/core/ring.ts`. Every
state is re-derivable from `(bridgeTxHash, sourceNetworkId)` plus idempotent
reads, following aggkit `bridge_loop_tester` DESIGN.md §4's resumability rule.

### 3.1 States

| State | Meaning |
|---|---|
| `PLANNED` | hop selected, not yet started |
| `APPROVE_BUILD` | building the ERC20 `approve` (ERC20 hops with `allowance < amount` only) |
| `APPROVE_PENDING` | approve tx sent, awaiting receipt |
| `BRIDGE_BUILD` | building `bridgeAsset` |
| `BRIDGE_PENDING` | bridge tx sent, awaiting receipt |
| `AWAITING_ACTIVITY` | receipt mined; waiting for the row to appear in the tracker activity response |
| `AWAITING_READY` | row observed `PENDING`; waiting for `READY_TO_CLAIM` **or** a direct jump to `CLAIMED` (autoclaim can beat our poll) |
| `AWAITING_AUTOCLAIM` | route `expected: true`, row `READY_TO_CLAIM`; grace window running |
| `CLAIM_BUILD` | `isClaimed` → `getClaimInputs` → `buildClaimAsset` |
| `CLAIM_PENDING` | claim tx sent, awaiting receipt |
| `AWAITING_CLAIMED` | claim receipt success; waiting for the activity row to report `CLAIMED` |
| `DONE` | terminal success |
| `FAILED` | terminal failure |

Lap states: `LAP_RUNNING` → `LAP_DONE` (all hops `DONE`) | `LAP_FAILED`
(any hop `FAILED`) | `LAP_ABORTED` (drain/SIGINT, §3.6).

### 3.2 Transition table

Every row has an explicit timeout key and both a success outcome and a
timeout outcome. "—" in the timeout column means the transition is
synchronous within the previous state's budget and cannot itself hang; the
`hopMs` umbrella (last row) still bounds it.

| # | From | Trigger / guard | To | Timeout key | On timeout → outcome | Recorded on success |
|---|---|---|---|---|---|---|
| T1 | `PLANNED` | asset is ERC20 **and** `allowance < amount` | `APPROVE_BUILD` | — | — | phase `allowance` |
| T2 | `PLANNED` | asset is ETH, **or** `allowance ≥ amount` | `BRIDGE_BUILD` | — | — | phase `allowance` (ERC20 only) |
| T3 | `APPROVE_BUILD` | build + send succeeds | `APPROVE_PENDING` | `txReceiptMs` (build+send share it) | `timeout_approve_submit` | phase `approve_submit` |
| T4 | `APPROVE_BUILD` | build/send throws | `FAILED` | — | — | outcome from §5.3 classifier |
| T5 | `APPROVE_PENDING` | receipt `status === 'success'` | `BRIDGE_BUILD` | `txReceiptMs` | `timeout_approve_receipt` | phase `approve_receipt` |
| T6 | `APPROVE_PENDING` | receipt `status === 'reverted'` | `FAILED` | `txReceiptMs` | `timeout_approve_receipt` | outcome `revert_approve` |
| T7 | `BRIDGE_BUILD` | build + send succeeds | `BRIDGE_PENDING` | `txReceiptMs` | `timeout_bridge_submit` | phase `bridge_submit` |
| T8 | `BRIDGE_BUILD` | build/send throws | `FAILED` | — | — | classifier; `LocalBalanceTreeUnderflow` in the message ⇒ outcome `lbt_underflow` (§3.7) |
| T9 | `BRIDGE_PENDING` | receipt `status === 'success'`; `BridgeEvent` decoded from logs → `depositCount` | `AWAITING_ACTIVITY` | `txReceiptMs` | `timeout_bridge_receipt` | phase `bridge_receipt`; `depositCount` checkpointed |
| T10 | `BRIDGE_PENDING` | receipt `status === 'reverted'` | `FAILED` | `txReceiptMs` | `timeout_bridge_receipt` | outcome `revert_bridge` |
| T11 | `BRIDGE_PENDING` | receipt success but no `BridgeEvent` log | `FAILED` | `txReceiptMs` | `timeout_bridge_receipt` | outcome `bridge_event_missing` |
| T12 | `AWAITING_ACTIVITY` | activity row with matching `transactionHash` observed | `AWAITING_READY` | `appearsInActivityMs` | `timeout_appears_in_activity` | phase `appears_in_activity` |
| T13 | `AWAITING_READY` | row `status === 'READY_TO_CLAIM'` **and** `autoclaim[hop].expected === true` | `AWAITING_AUTOCLAIM` | `readyToClaimMs` | `timeout_ready_to_claim` | phase `ready_to_claim`; gate `claim-proof` |
| T14 | `AWAITING_READY` | row `status === 'READY_TO_CLAIM'` **and** `expected === false` | `CLAIM_BUILD` | `readyToClaimMs` | `timeout_ready_to_claim` | phase `ready_to_claim`; gate `claim-proof` |
| T15 | `AWAITING_READY` | row `status === 'CLAIMED'` (autoclaim beat our poll) | `DONE` | `readyToClaimMs` | `timeout_ready_to_claim` | phases `ready_to_claim`+`claimed_observed`; outcome `hop_completed_auto` |
| T16 | `AWAITING_READY` | row `status === 'ERROR'` (`claimed === 'error'`, `app/services/activity.ts:151`) | `FAILED` | `readyToClaimMs` | `timeout_ready_to_claim` | outcome `activity_status_error` |
| T17 | `AWAITING_AUTOCLAIM` | row `status === 'CLAIMED'` before `waitMs` elapses | `DONE` | `autoclaim[hop].waitMs` | escalation, see T18 | phase `claimed_observed`; outcome `hop_completed_auto` |
| T18 | `AWAITING_AUTOCLAIM` | `now − readyAt ≥ waitMs`, still unclaimed | `CLAIM_BUILD` | `autoclaim[hop].waitMs` | **not a failure** — counter `autoclaim_overdue`++, gate `claimed` stall recorded | — |
| T19 | `CLAIM_BUILD` | `isClaimed` returns `true` before we build | `DONE` | `claimedMs` | `timeout_claim_build` | counter `claim_race_lost`++; outcome `hop_completed_raced` (aggkit DESIGN §8: race lost is still success) |
| T20 | `CLAIM_BUILD` | `getClaimInputs` returns `claimable: false` | `AWAITING_READY` (re-enter; keeps polling) | `claimedMs` | `timeout_not_claimable` | counter `not_yet_claimable`++, gate from `reason` (§5.4) |
| T21 | `CLAIM_BUILD` | `getClaimInputs` returns `claimable: true`, build + send succeeds | `CLAIM_PENDING` | `claimedMs` | `timeout_claim_submit` | phases `claim_inputs`, `claim_submit` |
| T22 | `CLAIM_BUILD` | build/send throws | `FAILED` | `claimedMs` | `timeout_claim_submit` | classifier; if the post-throw `isClaimed` re-check (§9.3 finding C3) reads `true` ⇒ `DONE`, counter `claim_race_lost`++, outcome `hop_completed_raced` |
| T23 | `CLAIM_PENDING` | receipt `status === 'success'` | `AWAITING_CLAIMED` | `txReceiptMs` | `timeout_claim_receipt` | phase `claim_receipt` |
| T24 | `CLAIM_PENDING` | receipt `status === 'reverted'`; post-revert `isClaimed` re-check `true` | `DONE` | `txReceiptMs` | `timeout_claim_receipt` | counter `claim_race_lost`++; outcome `hop_completed_raced` |
| T25 | `CLAIM_PENDING` | receipt reverted; re-check `false` | `FAILED` | `txReceiptMs` | `timeout_claim_receipt` | outcome `revert_claim` |
| T26 | `AWAITING_CLAIMED` | activity row `status === 'CLAIMED'` | `DONE` | `claimedMs` | `timeout_claimed_observed` | phase `claimed_observed`; outcome `hop_completed_manual` (or `hop_completed_escalated` if T18 fired) |
| T27 | `AWAITING_ACTIVITY` … `AWAITING_READY` (R32/loadtest/REVIEW.md: NOT `AWAITING_CLAIMED` — the `AWAITING_CLAIMED` half was confirmed dead code and deleted; the only entry to `AWAITING_CLAIMED` is T23, reachable only after `claimSubmitted` is already `true`, so `unexpected_autoclaim` can never fire from there) | route `expected === false` but the row reaches `CLAIMED` without our claim tx | `DONE` | as per state | as per state | counter `unexpected_autoclaim`++; outcome `hop_completed_auto` — **reported, not failed** (see §3.4) |
| T28 | any non-terminal | `now − hopStartedAt ≥ hopMs` | `FAILED` | `hopMs` | `timeout_hop` (the per-phase timeout outcome is recorded too, when one also fired) | — |
| T29 | any non-terminal | drain requested (§3.6) and hop cannot finish within remaining drain budget | `FAILED` | remaining drain budget | `aborted_drain` | — |
| T30 | any non-terminal (browser mode) | context/browser crash | `FAILED` | — | — | outcome `browser_crash` (§7.3) |

Lap-level:

| # | From | Trigger | To | Timeout key | On timeout → outcome |
|---|---|---|---|---|---|
| L1 | `LAP_RUNNING` | hop `i` `DONE`, `i < hops−1` | `LAP_RUNNING` (hop `i+1`) | `lapMs` | `timeout_lap` |
| L2 | `LAP_RUNNING` | last hop `DONE` | `LAP_DONE` | `lapMs` | `timeout_lap` |
| L3 | `LAP_RUNNING` | any hop `FAILED` | `LAP_FAILED` | — | — |
| L4 | `LAP_RUNNING` | drain deadline reached with hops outstanding | `LAP_ABORTED` | drain budget | `aborted_drain` |

`lapMs` default (devnet) = `3 600 000` (60 min) = 3 × `hopMs`; it is a
separate umbrella so a lap whose individual hops each stay inside `hopMs` but
whose total drags is still reported. The tool **never** starts hop `i+1`
before hop `i` is `DONE` (requirement: nothing is burned except
gas; the value must actually be at the next chain).

<!-- R33 (loadtest/REVIEW.md): this paragraph used to say `2 700 000`
(45 min), contradicting §3.3's table (`3 600 000`/60 min) below, which is
the value `deriveDevnet.ts` actually emits and the one no code disagrees
with — this paragraph was stale (not updated when the timeouts were raised
past their earlier value). The table is authoritative; this prose now matches it. -->

### 3.3 Timeout defaults and their justification

| Key | Devnet default | Justification |
|---|---|---|
| `pageLoadMs` | 30 000 | measured load+connect at 50 contexts = 21.6 s (initial feasibility measurement) |
| `walletConnectMs` | 15 000 | E2E `connectWallet` is a local `setState(true)` in the app, so this only covers render |
| `txReceiptMs` | 60 000 | `app/constants/e2e.ts:151` devnet `DEFAULT_BRIDGE_SUCCESS_TIMEOUT_MS` |
| `appearsInActivityMs` | 60 000 | tracker indexing after a ~1 s-block-time anvil; conservative. **[VERIFY]** — record the observed p99 and re-tune |
| `readyToClaimMs` | 900 000 (15 m) | **Superseded 2026-09-11 by a live acceptance-run measurement.** The 600 000 default (worst measured L2→L1 ready-to-claim 8 m 34 s, `app/constants/e2e.ts:104-106`; L2→L2 source-side settlement 87–330 s, `e2e.ts:90-102`) was too tight: a real acceptance run against the compose devnet timed out on `L2A->L2B` at ~607 s for both surviving users, and the orchestrator measured the bridge actually reaching `claimed=true` **31 s after** the harness gave up — true latency ≈ 638 s (10 m 38 s). Root cause: aggsender `MinimumNewCertificateInterval: 5m0s`, and an L2→L2 hop needs network 1 to certify *and settle* before network 2 imports; a bridge landing just after a certificate window waits for the next one, across **two** hops (source-certify, dest-import). The earlier 87–330 s figure was measured just after a certificate window and understates the tail — the real spread is ~95 s to ~640 s+. 900 000 gives ~40% headroom over the measured 638 s |
| `claimedMs` | 900 000 (15 m) | same gate on the far side of the hop, same measured-latency justification as `readyToClaimMs` above |
| `hopMs` | 1 200 000 (20 m) | must strictly bound `readyToClaim` + claim submit + receipt now that either sub-timeout alone can be 900 000; 20 min is the deliberate cap so a stuck hop is reported rather than absorbed. A hop that legitimately needs more must raise `hopMs` explicitly |
| `lapMs` | 3 600 000 (60 m) | 3 × `hopMs`, per the rule below |

**Invariant:** `readyToClaimMs < hopMs < lapMs` must always hold — a unit test asserts
this on the derived devnet config so a future edit
cannot reintroduce the earlier defect (a `hopMs` too close to
`readyToClaimMs` silently truncates the claim-build/submit/receipt budget
that has to fit after `readyToClaimMs` elapses).

Revised context on the aggsender heartbeat: `MinimumNewCertificateInterval
= 5 m` is documented (`app/constants/e2e.ts:100-102`) as a maximum-idle
heartbeat, not a floor on certificate spacing — but the measurement above
shows it **behaves like a floor in practice** for a bridge that lands just
after a certificate has already gone out: the next certificate is not cut
until the interval elapses, so that bridge's source-side certify time is
effectively `[0, 5m]` uniform, and an L2→L2 hop pays this twice (once on
each side). Timeout sizing above accounts for this; do not read the
"not a floor" framing as license to shrink `readyToClaimMs`/`claimedMs`
back toward 600 000.

### 3.4 Autoclaim escalation and the two policy counters

**Manual claim is the default; autoclaim is an optional per-hop setting.** Every
shipped config (devnet and the Bali/testnet example) sets `expected: false`, and
`.claude/bin/loadtest.sh` `render()` forces it (dropping `waitMs`) because aggkit
rc17 has no autoclaimer. `expected: true` + `waitMs` remain valid in the schema and
engine (T13/T17/T18 below) for environments that do run one. Timing datum, Bali
ring A run of 2026-10-06 (0.00001 ETH): hop 0 (Sepolia -> BALI_82) bridged
12:04:24Z and was claimed after an `AWAITING_AUTOCLAIM` wait ending 12:23:22Z
(~16 min); hop 1 (82 -> 85, bridged 12:23:24Z) was claimed ~45 min later
(~13:08Z). That latency is why manual claim is the default.

The UI's own gate is mirrored exactly (`app/hooks/useAutoclaimGate.ts:22-62`,
`app/utils/autoclaim.ts:28-38`): the grace window starts at
**first-observed `READY_TO_CLAIM`** (`readyAt`), not at bridge submit, and
`overdue` is `now ≥ readyAt + waitMs`.

Deliberate divergence from aggkit `bridge_loop_tester`, which treats both
policy surprises as **fatal claim-mode violations**: this tool treats them as
**recorded counters that do not fail the hop**, because its purpose is load
generation with honest reporting, not a policy assertion suite:

- `autoclaim_overdue` (T18) — only on a route configured `expected: true`: autoclaim was expected, grace window elapsed,
  we escalate to a manual claim so the ring keeps moving.
- `unexpected_autoclaim` (T27) — route expected **no** autoclaim, something
  else claimed it. The hop succeeds; the counter is surfaced in `summary.md`'s
  policy section.

Both are surfaced prominently in the report so a post-run analysis can attribute them to
(a) tool, (b) devnet capacity or (c) a genuine aggkit finding.

### 3.5 Scheduler semantics

`loadtest/core/scheduler.ts`. One token bucket per **user**, plus a
global admission gate.

- **Bucket**: capacity 1 token (no bursting — bursting would defeat the "Y
  bridges per minute" contract); refill rate `bridgesPerMinutePerUser / 60000`
  tokens per ms, continuous. A tick consumes 1 token and starts one **hop**.
  Over `Z` minutes at steady state each user therefore emits
  `Y·Z ± 1` bridge submissions — a unit test asserts exactly this bound
  with a fake clock.
- **Ramp-up**: user `k` (0-based, of `users.total`) becomes admissible at
  `t = rampUpSeconds × 1000 × k / users.total`. Its bucket starts empty and
  begins refilling at that instant, so no user front-loads a token earned
  before it existed.
- **Backpressure**: a user may have at most `maxInflightLapsPerUser` laps
  in flight. When a tick fires and the user is at that limit, the tick is
  **dropped, not queued**, and counted as `skipped_backpressure` with the
  gate that the oldest in-flight hop is sitting on (§5.4). Dropping rather
  than queueing keeps "achieved rate" honest: a queued tick would later fire
  as a burst and misreport the offered load.
- **New lap vs. continue**: a tick starts hop `i+1` of an existing lap only
  via T-L1 (driven by hop completion, not by the bucket). A bucket tick always
  starts **hop 0 of a new lap** with a fresh slice of the asset. This is what
  sustains the requested rate while earlier laps wait on claims.
- **Asset interleaving**: each user runs one independent ring **per asset
  kind**. A tick picks the asset round-robin among those whose ring is not at
  its in-flight limit; if all are, the tick is `skipped_backpressure`.
- **Stop**: at `t = durationMinutes × 60000` no further ticks are issued and
  drain begins (§3.6).

### 3.6 Drain and abort

On `durationMinutes` elapsing or SIGINT:

1. Stop issuing bucket ticks immediately; record `runEndedAt`.
2. Allow in-flight hops to finish, bounded by `hopMs` measured from **each
   hop's own start**, and by an overall drain deadline of
   `min(hopMs, remaining hop budget across all in-flight hops)`.
3. Every hop still non-terminal at the drain deadline transitions T29 →
   `FAILED` with outcome `aborted_drain`; its lap becomes `LAP_ABORTED`.
4. The report is written with `"aborted": true` and the abort cause
   (`duration_elapsed` | `sigint` | `fatal`). A SIGINT run **always** writes a
   report.
5. A second SIGINT during drain skips step 2 and writes immediately.

### 3.7 LocalBalanceTree ordering constraint

Bridging an L1-origin asset **out of** an L2 requires that L2's
`LocalBalanceTree[originNetwork][token]` to hold it; otherwise
`bridgeAsset` reverts `LocalBalanceTreeUnderflow` inside `eth_estimateGas`
(`tests/bridge/models/bridge-page.ts:256-267`;
`sdk/scripts/aggkit-smoke.ts:566-575`). Consequences, all structural:

- The ring's **first hop must originate on the chain with
  `networkId === 0`** whenever any asset's `originNetworkId === 0`. `validate`
  enforces this (`RING_MUST_START_AT_ASSET_ORIGIN`) rather than relying on a
  separate seeding step — the L1→L2A hop *is* the seeding.
- No separate LBT-seeding code exists (deliberate non-goal). Both worked
  examples satisfy the rule (`ring[0]` is `L1` / `SEPOLIA`, both
  `networkId 0`).
- A `LocalBalanceTreeUnderflow` observed at runtime is classified as its own
  outcome `lbt_underflow` (T8), never as a generic `tx_revert`, so the post-run analysis can
  tell an ordering bug apart from a chain problem.

---

## 4. Funding strategy per environment

### 4.1 Wallet derivation

`wallets/derive.ts`: `userId = 'u' + index`, `index ∈ [0, users.total)`.

- `{mnemonicRef, startIndex}` → BIP-44 path `m/44'/60'/0'/0/{startIndex+index}`
  (viem `mnemonicToAccount`). Deterministic: the same config yields the same
  `userId → address` mapping on every run, which is what makes a re-run
  comparable and makes funding idempotent.
- `{privateKeysRef}` → the file's Nth line for user N; the loader refuses if
  the file has fewer lines than `users.total`.

### 4.2 Devnet: `anvil_setBalance` (default)

Gas, per ring chain, via that chain's `rpcUrl` (the haproxy routes work — the
RPC is a plain JSON-RPC pass-through, `tests/devnet/summary.json`
`.proxy.routes[].kind === 'json-rpc'`). **[VERIFIED]**:
`anvil_setBalance` DOES reach anvil through haproxy unmodified — verified
live with a raw JSON-RPC POST to each of
`http://127.0.0.1:8555/{l1rpc,l2rpc-001,l2rpc-002}` (`method:
"anvil_setBalance"`), each returning `{"result":null}` and a subsequent
`eth_getBalance` confirming the balance actually changed. `wallets/fund.ts`
therefore always goes through the haproxy `rpcUrl` from the config, never
the direct ports (`L1_RPC_PORT` 8545 / `L2_001_HTTP_PORT` 11545 /
`L2_002_HTTP_PORT` 12545) — the fallback this paragraph originally reserved
was not needed and is not implemented.

`anvil_setBalance` **sets**, it does not add. So funding must never lower a
wallet: read `eth_getBalance` first and set
`max(current, targetGasPerChain)`. A test asserts a second `fund` run does not
reduce any balance.

ERC20: `anvil_setBalance` cannot mint. The asset is transferred from the
funder (`.accounts.e2e_wallet`, the declared holder of `erc20_address`) with
**one serialized sender per chain** (§4.4). If `erc20_address` turns out
unusable (no bytecode / zero funder balance), fall back to the existing
dockerized-forge deploy path in `tests/e2e/globalSetup.ts` and record the new
address in the generated config.

Devnet target: `fund --users 20` completes in **< 60 s**.

### 4.3 Testnet / mainnet: funder wallet, capped

No `anvil_*`. `users.funder` sends:

- native gas `gasPerChain[chainKey]` to each user on each **ring** chain;
- `assetTopUp` of each ERC20 asset to each user on the ring's **start** chain
  (`ring[0]`), which is also the asset's origin chain by §3.7.

Rules, each with a named test:

1. **Spend cap**: before any send, the total planned outlay per chain is
   compared against `maxTotalSpend[chainKey]`. Over cap ⇒ refuse the whole
   `fund` with `FUNDING_CAP_EXCEEDED`, sending nothing. The cap is also
   enforced *incrementally* during sending, so a mid-flight gas-price spike
   cannot exceed it.
2. **Skip-if-funded**: a user already at or above target on a chain is
   skipped (idempotent re-runs; cheap on a real testnet).
3. **Serialized nonces per chain** (§4.4).
4. **No key ever logged** — the funder address is logged, the key is not, and
   the redactor (§2.2) is applied to every error message from the funding
   path.
5. `env === 'mainnet'` additionally requires an explicit
   `--i-know-this-is-mainnet` CLI flag; without it `fund` refuses.

### 4.4 Funder nonce discipline

**Risk — shared funder nonce contention**: the funder maintains one
in-memory nonce counter **per chain**, seeded from
`eth_getTransactionCount(pending)`, and all its sends on a chain go through a
single-slot queue. Different chains proceed concurrently. On any send error
the counter is re-seeded from the node rather than incremented blindly.

### 4.5 Preflight

`wallets/preflight.ts`, run automatically by `run` and available as a CLI
command. Prints a per-chain table and fails with the first unmet assertion
named:

| Check | Failure code |
|---|---|
| every user has ≥ `gasPerChain[c]` native on every ring chain `c` | `PREFLIGHT_GAS` |
| every user has ≥ `assets[i].amount` of asset `i` on `ring[0]` | `PREFLIGHT_ASSET` |
| `eth_chainId` on each `chains[].rpcUrl` equals `chains[].chainId` | `PREFLIGHT_CHAIN_ID` |
| bridge contract has bytecode at `chains[].bridgeAddress` on each chain | `PREFLIGHT_BRIDGE_BYTECODE` |
| `GET {proxy}/bridge/v1/sync-status?network_id=N` reports synced **and** active for every `chains[].networkId` | `PREFLIGHT_SYNC_STATUS` |
| `GET {proxy}/tracker/v1/health` is 2xx | `PREFLIGHT_TRACKER_HEALTH` |
| ERC20 allowance state recorded (not asserted) | — |

`PREFLIGHT_CHAIN_ID`, `PREFLIGHT_BRIDGE_BYTECODE` and
`PREFLIGHT_SYNC_STATUS` are exactly the three checks
`scripts/devnetReady.mjs` performs (9 checks = 3 chains × 3 assertions);
`PREFLIGHT_TRACKER_HEALTH` is **not** in `devnetReady.mjs` and comes from
the tracker's own route list — **[VERIFIED]**:
`GET {proxy}/tracker/v1/health` DOES exist and returns 2xx on this devnet —
verified live via `curl http://127.0.0.1:8555/aggkitapi/tracker/v1/health`
→ `HTTP 200`, body
`{"status":"ok","instance_id":"…","config_sha1":"…","version":{"version":"v0.11.0-rc8",...}}`
(confirmed identical through the direct port `http://127.0.0.1:8556/tracker/v1/health`
too). `wallets/preflight.ts` therefore implements `PREFLIGHT_TRACKER_HEALTH`
as a real hard gate, not dropped.

These are **preflight-only** endpoints: `sync-status` and tracker health are
explicitly **absent** from the steady-state call set (§9.2), because the UI
never calls them.

---

### 4.6 The L1 deposit pump

Optional (`pump` block, §2.1), off by default. A harness-side loop (`workers/pump/l1Pump.ts`,
schedule in `core/pumpSchedule.ts`) sending one `bridgeAsset(destinationNetworkId, self,
amount, 0x0, forceUpdateGlobalExitRoot = true, 0x)` on the L1 per `intervalSeconds` from the
mnemonic wallet at `pump.walletIndex`. Without `forceUpdateGlobalExitRoot` the GER would not
change and the deposit would add no L1 info-tree leaf.

- **Not user traffic.** It never touches a hop, lap, tick or the verdict; records are `pump_*`
  ndjson kinds and the `results.json` `pump` block (§6.1); its RPC requests run in a `harness`
  fetch context.
- **One tx in flight.** The nonce is read from `pending` before each send; a tick while a
  deposit has no receipt is skipped (`previous_pending`).
- **Spend cap.** Committed spend = actual cost of settled deposits plus the worst case
  (`1.2 x estimate x maxFeePerGas + amount`) of a pending one. When the next deposit could
  exceed `maxTotalSpend` the pump stops (`cap_reached`). `maxGasPriceGwei` is both the pause
  threshold (`gas_price` skip) and the `maxFeePerGas` of every pump tx, so a sent tx can never
  pay more.
- **Funding.** `fund` does not fund the pump wallet. Preflight fails `PUMP_UNDERFUNDED` when it
  holds less than `maxTotalSpend` on the L1 (this is the tool half of SC10).
- **Lifetime.** Starts after the L1 info-tree baseline is read, stops at the end of the run
  after the drain (bounded receipt wait); on a failure path it stops without waiting.

**Measurement caveat.** A pump-off baseline means *no tool deposits*, not *no new L1 info-tree
leaves*: under load the PP network settles certificates often and each settlement that changes
its exit root adds a leaf that also unblocks 85-origin hops. The comparison is therefore only
readable with `measurement.l1InfoTree` on in both runs, which counts the leaves in the window
and attributes each to the pump or to another source (`fromPump`).

## 5. Metrics and error taxonomy

### 5.1 Phase timers (histograms: p50/p90/p99/max, count)

Keyed `(phase, mode, hopRoute, assetKind)`; `hopRoute` is the ring hop label
(`"L1->L2A"`), and every histogram is additionally emitted split by `mode`
(`browser` / `headless`) so parity gaps are visible.

`page_load`, `wallet_connect`, `allowance`, `approve_submit`,
`approve_receipt`, `bridge_submit`, `bridge_receipt`,
`appears_in_activity`, `ready_to_claim`, `claim_inputs`, `claim_submit`,
`claim_receipt`, `claimed_observed`, `hop_total`, `lap_total`.

`page_load` and `wallet_connect` are browser-only and are recorded as
`null`/absent for headless users rather than as 0 — a zero would corrupt the
combined percentile.

**Censored samples (loadtest/REVIEW.md R2).** A phase that TIMES
OUT (rather than completing) contributes a sample tagged `censored: true`
(`core/ring.ts`'s `recordCensoredTimeoutPhase`), NOT no sample at all —
previously the timed-out tail was silently discarded, which biased every
phase's percentiles optimistically (and, combined with a since-fixed
re-recording defect on `ready_to_claim`'s fast head — R28 — biased that one
metric from both ends at once, the exact metric §3.3 sizes its timeouts
from). Censored samples are kept OUT of the percentile arrays in
`results.json`'s `phases` (a duration capped at the configured timeout is not
a latency measurement) but counted separately in `phaseCensoredCounts`, and
`summary.md`'s Phase latencies table renders both side by side with a
disclosure note.

### 5.2 HTTP samples

One record per request: `{ts, userId, mode, endpointClass, method, status, durationMs, attempt}`.

- browser: `page.on('request')` / `page.on('response')` / `page.on('requestfailed')`
- headless: a `fetch` wrapper (aggkit REST) and a viem transport wrapper (RPC)

`endpointClass` normalization:

| Real URL | `endpointClass` |
|---|---|
| `{proxy}/tracker/v1/activity/from/0x…?includeTracking=true` | `tracker/activity` |
| `{proxy}/tracker/v1/network/{id}/tx/{hash}` | `tracker/tx[{id}]` |
| `{proxy}/tracker/v1/health` | `tracker/health` |
| `{proxy}/bridge/v1/{route}?network_id=N&…` | `bridge/{route}[N]` |
| JSON-RPC POST to `chains[].rpcUrl` | `rpc/{method}[{chainKey}]` |
| anything else | `other/{host}{path}` |

The address is stripped from `tracker/activity` and the hash from
`tracker/tx` so the class has bounded cardinality. `attempt > 0` marks an SDK
internal retry (§9.5) so retries are visible instead of inflating the
apparent request count silently.

### 5.3 Error taxonomy

Classified by `metrics/errors.ts` on **typed** evidence (HTTP status, viem
error class, Playwright error class, SDK `reason` union), never on free-text
matching, except where a revert selector or a documented aggkit prose pattern
is the only signal available — and those cases are listed here explicitly.

| Class | Trigger | Notes |
|---|---|---|
| `not_ready` | `/bridge/v1/l1-info-tree-index` 404/500 with the documented "not been included on the L1 Info Tree yet" body; `/bridge/v1/injected-l1-info-leaf` 404 "GER not yet injected"; `/bridge/v1/claim-proof` 404 "has not indexed" | **Not an error.** Same allowlist `tests/bridge/console-hygiene.spec.ts:66-77` already applies. Counted as a gate stall (§5.4), excluded from the error report |
| `tracker_not_ready` | **Heavy-load addition.** `/tracker/v1/activity` answers **503** with a body containing "not ready yet" (an address the tracker has not registered yet) | **Not a failure and not `proxy_5xx`.** Never fails a hop, excluded from SC4, own row in the errors table. The headless activity poller does not retry it after 300 ms; the runner backs off to the UI cadence (5 s). Keyed on the body text, so a differently worded 503 fails safe into `proxy_5xx` |
| `proxy_4xx` | any other 4xx from `{proxy}/…` | 400 = missing `network_id`; 404 = unknown network (aggkit-proxy contract) |
| `proxy_5xx` | any other 5xx from `{proxy}/…` | 502 = backend down |
| `activity_warning` | **Finding C13.** A per-network `warnings[]` entry on a *successful* (200) `tracker/activity` response, e.g. "bridge service for network N is not fully synchronized, some bridges may still be missing" | Recorded as `activity_warning[network_id=N]: …`; **not** `proxy_5xx` (no 5xx occurred) and never fails a hop. Appears in the error-by-class table |
| `rpc_error` | JSON-RPC error response or transport failure on a `chains[].rpcUrl` | subdivided by JSON-RPC error code in the report |
| `nonce_conflict` | **R3 (loadtest/REVIEW.md).** An `rpc_error`/submit-throw whose message mentions "nonce" | **Originally a deliberate decision, REVERSED (2026-09-14) — kept below for the history, not as current policy.** ~~There is no per-(user, chain) nonce serialization on the user send path (`wallets/chainClients.ts`'s `ChainNonceManager` is funder-only) — `load.maxInflightLapsPerUser` (default 3, up to 6 per user with two assets per §3.5's asset-interleaving clause) puts multiple concurrent sends on one EOA by design, matching a real user's wallet (`app/utils/transaction.ts`'s dropped-nonce parity, finding C4). A live run logged 19 nonce-too-low + 70 viem `-32003` rejections from exactly this. Chosen resolution: **keep parity** (do not serialize sends — that would diverge from the UI) and instead **attribute honestly**: a nonce-shaped message is classified separately from plain `rpc_error` (a class that reads as "the chain/proxy rejected us") rather than serializing sends.~~ **Later finding: concentrated on the `L2B->L1` claim hop alone (not diluted across all hops as R3's "89/1985" framing implied) this was ~39% of attempts failing (33/85 and 11/29 across two full 3-hop runs) — not tolerable.** The re-diagnosis walked viem's `.cause` chain on real failures and captured the actual anvil rejection text underneath the generic `-32003` shortMessage: **`"replacement transaction underpriced"`** — direct confirmation of same-EOA nonce contention, not a genuine chain/proxy rejection. **The parity argument is now judged backwards: a real user does not submit several concurrent bridges from one wallet, so serializing sends per (user, chain) is MORE faithful to real usage, not less** — the identical reasoning already used to justify browser mode's per-page `runExclusive`. `workers/headless/headlessUser.ts`'s `sendAndWait` is now wrapped in a per-(user, chain) FIFO queue (`workers/headless/uiCallset.ts`'s `KeyedSerialQueue`, the same shape as `runExclusive`), so concurrent sends on one EOA/chain no longer race the nonce at all. This class is left wired in `metrics/errors.ts` (a nonce-shaped message is still theoretically possible from a genuine node-side nonce issue) but should now fire rarely to never on this hop; see `loadtest/REVIEW.md`'s updated R3 entry for the full decision record. |
| `tx_revert` | receipt `status === 'reverted'` not otherwise classified | see the two specialisations below |
| `lbt_underflow` | revert whose decoded reason is `LocalBalanceTreeUnderflow`, or an `eth_estimateGas` failure carrying it | §3.7 |
| `already_claimed` | revert selector `0x646cf558` (`AlreadyClaimed()`), the one selector match this taxonomy permits (aggkit DESIGN §4 S5submit; `app/hooks/useClaimExecution.ts:228-229`) | resolves to `claim_race_lost` + hop success, not a failure |
| `timeout_<phase>` | a §3.2 timeout fired | one class per phase key in §3.2 |
| `autoclaim_overdue` | T18 | counter, hop still succeeds |
| `unexpected_autoclaim` | T27 | counter, hop still succeeds |
| `claim_race_lost` | T19 / T22 / T24 | counter, hop still succeeds |
| `not_yet_claimable` | `getClaimInputs` → `claimable: false` | counter; `reason` recorded verbatim (it is an **open** union — branch with a default, never `assertNever`; SDK `getClaimInputs` doc) |
| `ui_assertion` | Playwright locator/expect failure, browser mode only | carries the test-id that failed |
| `browser_crash` | §7.3 | |
| `console_error` | a page `console.error` / `pageerror` not on the console-hygiene allowlist | recorded, does not fail a hop |
| `funding` | anything from `wallets/fund.ts` | `FUNDING_CAP_EXCEEDED` is its own sub-code |
| `config` | schema/validate failure | run never starts |
| `internal` | anything unclassified | An audit should treat a non-trivial `internal` count as a finding — the classifier is meant to be exhaustive |

### 5.4 Gate-stall accounting

Mirrors aggkit `bridge_loop_tester`'s `gate_stalls_total{gate}` idea. Gate
names, and the observable that assigns them:

| Gate | Assigned when |
|---|---|
| `activity-index` | state `AWAITING_ACTIVITY` |
| `l1-info-tree-index` | `getClaimInputs` `reason` = `SOURCE_NOT_ON_L1_INFO_TREE`, or a `not_ready` on that endpoint |
| `injected-l1-info-leaf` | `not_ready` on `/injected-l1-info-leaf` (only reachable when destination `networkId !== 0`; the SDK skips this call entirely for destination 0 — `resolveInjectedLeafIndex`) |
| `claim-proof` | `not_ready` on `/claim-proof`, or state `AWAITING_READY` with no more specific signal |
| `claimed` | states `AWAITING_AUTOCLAIM` / `AWAITING_CLAIMED` |
| `syncer-inconsistent` | `reason` = `SYNCER_INCONSISTENT` (503) |

Each gate records: hops that entered it, total time spent, p50/p90/p99, and
how many hops were sitting on it when a `skipped_backpressure` tick fired.
That last number is the one that answers "was the devnet or the tool the
bottleneck"

### 5.5 Honesty invariants (audit targets)

1. `bridges_submitted = Σ hop bridge_submit successes`, and
   `ticks_offered = bridges_submitted + skipped_backpressure + ticks_lost_to_ramp`.
   The report prints all four and asserts the identity; a mismatch is a bug.
2. `hops_total = Σ outcomes` over the disjoint outcome set in §3.2. Every hop
   has **exactly one** terminal outcome.
3. `achieved_rate` is computed over the steady-state window
   `[rampUpSeconds, durationMinutes×60]` only, and the ramp window is reported
   separately — never averaged in to flatter the number.
4. An aborted run sets `"aborted": true` at the top level of `results.json`
   **and** in `summary.md`'s first line.
5. No histogram is emitted with `n = 0`; percentiles for `n = 1` are all equal
   to the single sample (edge-case test).

---

## 6. Report layout

Written to `output.dir` (default `loadtest-results/<timestamp>/`, gitignored).

### 6.1 `results.json`

```jsonc
{
  "schemaVersion": 1,
  "run": {
    "startedAt": "…Z", "endedAt": "…Z", "durationMs": 0,
    "aborted": false, "abortCause": null,
    "toolVersion": "<git describe>", "sdkVersion": "1.0.0-snapshot-ca6df75e",
    "host": { "cores": 64, "totalMemMb": 63488, "platform": "linux" }
  },
  "config": { /* the validated config, with every secretRef replaced by {"ref":"env:NAME"} */ },
  "requested": { "users": 400, "browser": 100, "ratePerUserPerMin": 2, "minutes": 30 },
  "achieved": {
    "ticksOffered": 0, "bridgesSubmitted": 0,
    "skippedBackpressure": 0, "ticksLostToRamp": 0,
    "steadyStateRatePerUserPerMin": 0.0
  },
  "hops":  { "byOutcome": { "hop_completed_auto": 0, "…": 0 },
             "byRoute": { "L1->L2A": { "byOutcome": {}, "phases": {} } } },
  "laps":  { "byOutcome": { "LAP_DONE": 0, "LAP_FAILED": 0, "LAP_ABORTED": 0 } },
  "phases": { "bridge_submit": { "browser": {"n":0,"p50":0,"p90":0,"p99":0,"max":0},
                                 "headless": {…} } },
  "http":   { "tracker/activity": { "browser": {"n":0,"p50":0,"p90":0,"p99":0,"max":0,
                                                "byStatus": {"200":0}},
                                    "headless": {…} } },
  "gates":  { "claim-proof": { "hopsEntered":0,"totalMs":0,"p50":0,"p90":0,"p99":0,
                               "blockedTicks":0 } },
  "errors": { "byClass": { "proxy_5xx": 0 },
              "top": [ { "class":"proxy_5xx","count":0,
                         "firstSeen":"…Z","lastSeen":"…Z",
                         "sample":"<redacted message>","endpointClass":"bridge/claim-proof[1]" } ] },
  "policy": { "autoclaimOverdue": 0, "unexpectedAutoclaim": 0, "claimRaceLost": 0 },
  "resources": { "samples": [ { "ts":"…Z","toolRssMb":0,"toolCpuPct":0,
                                "browserProcesses":[{"pid":0,"rssMb":0}] } ] }
}
```

**Heavy-load additions.** All are optional and absent when the feature is off, so a
run without a `pump` or `measurement` block keeps the shape above (flag-off golden test):

- `pump` (only when the pump ran): `enabled`, `sender`, `destinationNetworkId`, `amountWei`,
  `intervalSeconds`, `maxTotalSpendWei`, `maxGasPriceWei`, `deposits[]`
  (`txHash`, `blockNumber`, `depositCount`, `status`, `gasUsed`, `effectiveGasPrice`, `costWei`,
  `sentAt`, `minedObservedAt`), `skipped{gas_price, cap_reached, previous_pending, send_error}`,
  `totalSpendWei`, `pendingAtStop`.
- `walletBalances[]` (`measurement.walletBalanceIntervalMs`): `ts`, `chainKey`, `n`, `minWei`,
  `medianWei`, `maxWei`, `lowest[]`.
- `l1InfoTree` (`measurement.l1InfoTree`): `gerManagerAddress`, `baselineLeafCount`, `leaves[]`
  (`blockNumber`, `leafCount`, `txHash`, `minTimestamp`, `fromPump`), `pollErrors`.
- `measurements.hops[].claim.preState` (`measurement.claimPreState`):
  `{wrappedSupplyBefore, recipientBalanceBefore}`; `measurements.hops[].approve`
  (`txHash`, `gas`) whenever a `measurement` block is present.
- RPC endpoint classes in `http` are named `rpc/<CHAIN_KEY>/<method>` (§6.4).
- `exports`: `computeVerdict(results)` (the §6.3 headline) and `failureRates(results)`
  (`lapFailureRate`, `hardHopFailureRate`), so the strict verdict can be read next to the rates.

**Config redaction in `results.json`.** `config` is the validated config with (a) every secret
reference re-shaped to `{"ref": "env:NAME"}`, (b) every `chains[].rpcUrl` that has a path, query,
fragment or userinfo cut to `scheme://host[:port]/<redacted>` (a bare origin is kept), and (c)
`explorerUrl`, `aggkitProxyUrl` and `uiBaseUrl` masked the same way only when they look
secret-shaped (userinfo, query, fragment or a token-like path segment). A run directory written by an older tool version
may still hold the unmasked URL; it is not rewritten, and every human-facing report
(`summary.md`, `report.html`) redacts at render time (`metrics/redactReport.ts`).

### 6.2 `activity.ndjson`

Append-only, one JSON object per line, flushed as events occur so a killed
process still leaves a usable log. Every line has `{ts, kind, userId, mode}`
plus kind-specific fields. Kinds:

`run_start`, `user_ready`, `tick`, `tick_skipped`, `hop_state` (with `from`,
`to`, `transition` = the T-number from §3.2), `tx_sent`, `tx_receipt`,
`activity_row` (hash, status, tracking step name), `claim_attempt`,
`error`, `hop_end` (outcome), `lap_end` (outcome), `resource_sample`,
`run_end`.

**Written vs still not written ** The kinds actually written are: `run_start`,
`user_ready`, `tick`, `tick_skipped`, `hop_state`, `error`, `hop_end`, `lap_end`,
`resource_sample`, `run_end`, `hop_measurement` (one per hop), plus the heavy-load kinds
`tx_sent` and `tx_receipt` (**only when a `measurement` block is configured**, one per approve,
bridge and claim tx, so SC5 has a denominator), `pump_state`, `pump_deposit`, `pump_skipped`
(pump on), `wallet_balance` (`walletBalanceIntervalMs`), `l1_info_leaf` and
`l1_info_poll_error` (`l1InfoTree`), and `http_window` (`httpWindowMs`). **Still not written**,
though the kinds list above names them: **`activity_row`** and **`claim_attempt`** (their
collector methods have no caller). They are a known DESIGN/code mismatch, deferred; nothing in
the reports reads them.

Carrying the T-number is what makes the run auditable against §3.2: an audit can
assert every `hop_state` line names a transition that exists in this document.

### 6.3 `summary.md`

Fixed section order (a test asserts each heading is present; `report --dir`
regenerates it **byte-identical** from `results.json`):

1. `# Bridge load test — <startedAt>` — one line stating the verdict
   (`ABORTED` > `NO LAPS STARTED` > `FAIL` on any `LAP_FAILED` > `INCOMPLETE` on any
   `LAP_ABORTED` > `PASS`), users, rate, duration.
2. `## Configuration` — env, proxy URL, ring, assets, autoclaim map, timeouts.
   Secrets shown as `env:NAME`.
3. `## Throughput` — requested vs achieved table, plus the §5.5 identity
   check with an explicit `OK` / `MISMATCH`.
4. `## Hop outcomes` — outcome × route matrix.
5. `## Phase latencies` — p50/p90/p99/max per phase, browser vs headless
   side by side.
6. `## Endpoint latencies` — per `endpointClass`, with status breakdown.
7. `## Gate stalls` — §5.4 table, sorted by total time.
8. `## Autoclaim policy` — the three §3.4/§5.3 counters with per-route detail.
9. `## Errors` — count by class, then top-10 with first-seen/last-seen/count
   and one redacted sample each.
10. `## Resources` — peak/mean tool RSS and CPU, per-browser-process RSS.
11. `## Environment` — tool version, SDK version, image tags, host facts.

### 6.4 `report.html`

The human entrypoint of a run; `results.json`, `activity.ndjson` and `summary.md` are for
debugging and scripting. Written to `<out>/report.html` by `run` in a `finally` (aborted and
failed runs included; a render failure only logs a warning), and regenerated from an existing
run with `pnpm loadtest report --dir <out> --html [--html-out <file>] [--max-bytes N]`.
Code: `metrics/html/` (`model.ts` builds a pure model from `results.json` plus a streaming digest
of `activity.ndjson`; `render.ts`, `svg.ts`, `styles.ts` and `client.ts` turn it into one page).

Sections, in order: Verdict (banner, run identity, strict verdict, failure rates), Key figures,
Throughput, Hop outcomes, Latency distributions per route, Lap and hop timeline, Claim gas, Gate
stalls, Errors by class, Proxy and endpoint health, Tool resources over time, Pump activity,
Stop criteria (post-hoc), Wallet balances, Configuration (redacted), Environment and report
notes.

Guarantees:

1. **Offline.** One file: inline CSS, inline SVG, one inline script, no library, no `<link>`,
   no image URL, no font URL. The CSP meta tag is `default-src 'none'; style-src
   'unsafe-inline'; img-src data:; script-src <hash of the one script>`; the page also reads
   with scripts disabled.
2. **Bounded size.** Default cap 4 MiB. Over the cap the renderer re-runs at a higher
   downsampling tier (timeline rows, per-hop points); the applied tiers are stated in the
   verdict banner and in the Environment section.
3. **Escaping.** Every dynamic value goes through `metrics/html/escape.ts`; the embedded JSON is
   made `</script>`-safe.
4. **Redaction.** The configuration shown is an allowlist view (`CONFIG_KEY_POLICY` in
   `metrics/redactReport.ts`; a test fails when a schema leaf has no policy). URLs print as host
   only, secret refs as `env:NAME` / `file:<basename>`, tx hashes abbreviated, endpoint classes
   by chain key. Before writing, `assertNoSecrets` throws `ReportSecretError` (naming a field or
   a kind, never the value) if the HTML contains a URL path segment/userinfo/query value of the
   unredacted config, a 64-hex string, or a mnemonic-shaped data string; then no file is written.

`pnpm loadtest campaign-report --out <file.html> --run <label>=<dir>[,<dir>] [--run ...]` renders
the roll-up page (`metrics/html/campaign.ts`): one row per label (several dirs under a label
are pooled, e.g. the I and J rings of a stage) with verdict, failure rates, pump state, stop
criteria fired, per-route ready-wait, L1 leaves per hour and comparison charts, linking to each
run's `report.html` by relative path.

### 6.5 Stop criteria SC1-SC13

`metrics/stopCriteria.ts` evaluates the campaign's stop criteria **read-only** over a digest of
`activity.ndjson` plus `results.json` where present. It sends no signal and stops nothing; the
operator decides. Thresholds (exported as `SC`): SC1 at least 5 hard hop failures
(`HARD_HOP_FAILURE_OUTCOMES`) or at least 2% of ended hops once 50 ended; SC2 no successful
82>85 hop for 30 min with one in flight; SC3 the same for 85>82 at 120 min; SC4 at least 30
`proxy_5xx`/`proxy_4xx` errors in a 10 min window (`tracker_not_ready`, `not_ready` and
`activity_warning` excluded); SC5 at least 20 `nonce_conflict`; SC6 `toolRssMb` > 4096 for 3
samples; SC7 `eventLoopDelayP99Ms` > 500 for 12 samples; SC8 `toolCpuPct` > 90 for 60 samples;
SC9 a wallet below 20% of `gasPerChain`; SC10 funding floor and SC12 shared Bali health are
**outside the tool** (reported as `OUTSIDE`); SC11 pump spend reached `maxTotalSpend`; SC13
`tick_skipped` at least 25% of ticks (a gate: do not advance the stage). A criterion with no
data is `N/A`, not `ok`.

The `check-stop` command prints them (`pnpm loadtest check-stop --dir <out> [--dir <out>]
[--config <path>] [--json]`, exit code always 0), and `report.html` shows them post-hoc.

---

## 7. Browser pool and sharding

### 7.1 Sharding arithmetic

`browsers = ceil(users.browser / browser.contextsPerBrowser)`; contexts are
distributed round-robin so a crash loses at most
`contextsPerBrowser` users. Rationale from the initial measured feasibility
study: marginal RSS is ~150 MB/user with **one browser and N contexts** vs
~470 MB/user with **N browsers**, so contexts-per-browser is the right axis;
`contextsPerBrowser` is capped at 8 (schema max, lowered from 25
after a 20-browser-user run with `contextsPerBrowser: 25` collapsed to a
single Chromium — VALIDATION-1.md A3) to bound crash blast radius and
Playwright memory creep.

Launch flags: `--disable-dev-shm-usage` (mandatory — the default `/dev/shm`
is too small for tens of contexts in a container), plus
`--no-sandbox` only when `process.getuid?.() === 0`.

Each context: its own storage state, and
`context.addInitScript` setting `window.__AGGLAYER_E2E_PRIVATE_KEY__`
**before any app script runs**, which is what gives each context a
distinct wallet. The acceptance run proved distinct addresses per context.

### 7.2 Sizing guidance (to be replaced by measurement)

From the initial feasibility study: ~150 MB marginal RSS and 0.005 core idle per browser user
against a dead backend; budget **0.05–0.1 core** per browser user against a
live backend. Practical ceiling on this host ~**150–200** browser users
(memory-bound near 300). These are the numbers the scaled validation runs must confirm or replace;
until then they are the documented planning figures, not measurements of a
live run. **[VERIFY]**

### 7.3 Crash detection and recovery

Detected by, in order: `browser.on('disconnected')`, `context.on('close')`
without a `dispose()` request, and any Playwright
`TargetClosedError` / `Target page, context or browser has been closed` from
an operation.

Recovery: the affected users' in-flight hops go T30 → `FAILED` with outcome
`browser_crash`; the pool relaunches the browser process (bounded to
`maxBrowserRelaunches = 3` per process slot, then that slot's users are
retired with outcome `browser_crash_permanent`) and re-creates each context
with the same `addInitScript` key, so the user's wallet and therefore its ring
position are recovered from chain state on the next tick.

**All three detection signals drive the SAME relaunch path, deduped
(the acceptance-run retry fix).** A real process kill fires more than one of
the three signals for the same incident — empirically, every `context.on
('close')` for the slot's users, then (measurably later — not
simultaneously) the browser's own `disconnected` event. Attempt #1's
`pool.ts` only routed `browser.on('disconnected')` through the
relaunch/recreate logic; `context.on('close')` merely emitted the
`browser_crash` event without relaunching. That let a caller which reacts
to the (earlier-arriving) context-close event and immediately calls
`acquireContext()`/reconnects race ahead of the relaunch, reading a
still-set but already-dead `slot.browser` reference and failing with
`browser.newContext: ... Browser closed`, i.e. criterion 3's "the pool
re-creates the context" never actually happened before the caller tried to
use it. Fixed by routing `context.on('close')`'s crash branch through the
identical `handleSlotCrash` path `browser.on('disconnected')` uses, guarded
two ways: (a) a per-slot `crashInFlight` promise so concurrent signals for
the same incident dedupe onto one relaunch instead of each incrementing
`relaunches`/re-emitting; (b) the `disconnected` listener captures its own
browser instance and no-ops if `slot.browser` has already moved to a newer
incarnation, so a late-arriving `disconnected` for an already-recovered
slot cannot spuriously tear down the fresh contexts. With this fix, by the
time ANY crash event is observed by a caller, `slot.browser` is already
null and a relaunch is already in flight, so `acquireContext` always waits
on the live relaunch rather than a stale reference — verified live (the acceptance run's crash-recovery
phase: both affected users' next lap completed
after recovery).

The pool never reuses a wallet across two live contexts — that would produce
nonce collisions on the same account.

### 7.4 Context recycling

After `browser.recycleContextAfterLaps` completed laps, a context is closed
and re-created between laps (never mid-hop). This is the Playwright
memory-creep mitigation. Recycles are counted and reported so a run where
recycling dominates is visible.

---

## 8. UI build and serve (browser mode)

Recorded here because §9's parity claim depends on it: the baked
`agglayer-dev-ui-002` compose container is **not** E2E-enabled, so
browser mode builds and serves its own static export with
`NEXT_PUBLIC_E2E_ENABLED=true`, a throwaway default key, and
`NEXT_PUBLIC_AGGKIT_PROXY=<config.aggkitProxyUrl>`, writing a generated
`config.json` into `out/` (served `Cache-Control: no-store`) without touching
the repo's committed `config.json`.

The generated `config.json` must set the `autoclaim` block to the same values
as the loadtest config's `autoclaim` map — otherwise the browser users' gate
(`useAutoclaimGate`) and the headless users' gate (§3.4) would use different
`waitMs` values and the two modes would not be comparable. A test asserts this.

### 8.1 Optional local CORS relay (`browser.corsRelay`)

The page calls the proxy cross-origin, and the shared proxy's CORS allowlist only
matches its own domain family, so a UI served from a local `uiBaseUrl` can't read
`tracker/activity`. With `browser.corsRelay: true` (`run --cors-relay`; off by default,
absent from the config means off) `run` starts `ui/corsRelay.ts` — a forwarder bound to
`127.0.0.1` on a random port — **before** the UI build and passes its URL to `buildUi`
as the proxy URL (`NEXT_PUBLIC_AGGKIT_PROXY` and the generated `config.json`'s
`aggkitProxy`). The browser driver's own tracker poll runs inside the page
(`page.evaluate(fetch)`), so browser users are also constructed with the relay URL as their
proxy URL (which also makes it a known host for page-traffic classification). Headless users,
preflight and the samplers keep using `aggkitProxyUrl` directly.
The relay forwards method/path/query/body/headers unchanged (dropping `Host`,
`Origin`, `Referer` and hop-by-hop headers), answers `OPTIONS` itself, replaces any
upstream CORS headers, grants CORS only to the UI's own origin and rejects non-loopback
`Host` headers. It has no authentication and is a measurement-path hop that real
deployments do not have (their UI and proxy are on allowlisted domains), so browser
latencies recorded through it include one extra local hop. It cannot be combined with an
already-served UI (`run` refuses). Torn down with the run.

---

## 9. UI call-set parity

**Verification statement.** The table below was built by reading the
following files in full, not from a summary:
`app/services/activity.ts`, `app/services/tokenMetadata.ts`,
`app/services/claimProof.ts`, `app/hooks/useTransactions.ts`,
`app/hooks/useReadyToClaimCount.ts`, `app/hooks/useBridgeTracking.ts`,
`app/hooks/useClaimExecution.ts`, `app/hooks/useBridgeExecution.ts`,
`app/hooks/useTokenMetadata.ts`, `app/hooks/useTokenBalance.ts`,
`app/hooks/useGasEstimate.ts`, `app/hooks/useCheckAllowance.ts`,
`app/hooks/useAutoclaimGate.ts`, `app/utils/transaction.ts`,
`app/utils/autoclaim.ts`, `app/config.ts`,
`app/components/transactions/transactionListItem.tsx`,
`app/components/transactions/transactionDetailsModal/transactionDetailsModal.tsx`,
plus the pinned SDK's `dist/index.js` (the call bodies of `getClaimInputs`,
`getTokenMetadata`, `getL1InfoTreeIndex`, `getInjectedL1InfoLeaf`,
`getClaimProof`, `getTokenMappings`, `Bridge.isClaimed`,
`Bridge.buildBridgeAsset`, `Bridge.buildClaimAsset`, `ERC20.buildApprove`,
`ERC20.bridgeTo`, `ERC20.getBalance/getAllowance/getMetadata`,
`BaseContract.getNonce/estimateGas`, `fetchRawText`) and
`node_modules/viem/_cjs/actions/wallet/prepareTransactionRequest.js`.
The expected-call inventory is reproduced faithfully in rows P1–P9 and the additional
rows P10–P14 are calls that inventory does **not** list — each is a §9.3 finding, not
a silent addition.

### 9.1 The call set the headless worker must replay

| # | Call | Trigger | Cadence / cache | Source | Headless obligation |
|---|---|---|---|---|---|
| P1 | `GET {proxy}/tracker/v1/activity/from/{addr}?includeTracking=true` | transactions view mounted, or header badge mounted | burst `500/1000/2000/3000 ms` after a submit (`useTransactions.ts:12`, counter reset on the false→true edge, `:59-64`); then `5000 ms` while any row `status !== 'CLAIMED'` (`:21,24-25,95-97`), else `10000 ms` (`:22`); badge polls a constant `15000 ms` (`useReadyToClaimCount.ts:32`). Both hooks use queryKey `['activity', mode, address]` so react-query **dedupes them into one request** (`useTransactions.ts:66-72`, `useReadyToClaimCount.ts:8-11,22`); `staleTime: 30_000` on both (`:80`, `:29`) | `app/services/activity.ts:336-369` | Replay exactly, including the 30 s staleTime (a mount inside 30 s issues **no** request) and the dedup rule: when a user is "on the transactions page", the effective interval is `min(pageInterval, 15000)`, **one** request per interval, not two |
| P2 | `GET {proxy}/tracker/v1/network/{id}/tx/{hash}` | user opens the details modal of a **CLAIMED** row and clicks "Show bridge steps" | on demand, then `5000 ms` until terminal (`tracking_status === 'finished'`, or `'error'` with `bridge_status === null`) | `app/hooks/useBridgeTracking.ts:14,22-27,81-88` | **Not implemented** (R26, loadtest/REVIEW.md — corrected: this row previously read "replay at a configurable low probability, default 0", implying a defaulted-off KNOB. There is no such knob anywhere in `loadtest/` — `grep -rn 'tracker/v1/network\|useBridgeTracking\|bridgeTrackingProbability' loadtest/` returns nothing outside this doc). The UI only issues this call when a user opens a **CLAIMED** row's steps modal, which neither worker ever does — zero traffic either way, matching §9.2's never-called list, but as an absent code path, not a probability-0 setting. Note this GET **registers** the tx with the tracker (aggkit DESIGN.md gap **G2**) and occupies a slot in the bounded `MaxTrackedBridges` registry — relevant if P2 is ever implemented |
| P3 | `GET {proxy}/bridge/v1/l1-info-tree-index?network_id={recording}&deposit_count={n}` | manual claim, first step after `isClaimed` | once per claim attempt | SDK `getL1InfoTreeIndex`, via `getClaimInputs`, called from `app/hooks/useClaimExecution.ts:127-131` | Same, via the same SDK method — `recordingNetworkId = transaction.sourceNetwork`, never the token's origin network |
| P4 | `GET {proxy}/bridge/v1/injected-l1-info-leaf?network_id={dest}&leaf_index={I}` | as P3, **skipped when destination `networkId === 0`** | once per claim attempt | SDK `resolveInjectedLeafIndex` (early-returns for destination 0) | Same |
| P5 | `GET {proxy}/bridge/v1/claim-proof?network_id={recording}&leaf_index={I'}&deposit_count={n}` | as P3 | once per claim attempt | SDK `getClaimProof` | Same; `I'` is the index P4 actually returned, not the one requested |
| P6 | `GET {proxy}/bridge/v1/token-mappings?network_id={originTokenNetwork}&origin_token_address={addr}` | a non-native activity row whose token is **not** in the local token list | `staleTime 5 min`, `retry: 1`, keyed `['token-metadata', mode, chainId, address]` (`useTokenMetadata.ts:22-31`); `enabled` only when `!isNative && !localToken` (`transactionListItem.tsx:59-63`, `transactionDetailsModal.tsx:55-59`) | `app/services/tokenMetadata.ts:22-34` → SDK `getTokenMetadata` | Replay once per (mode, chainId, token) per 5 min. **Note the `enabled` guard**: for an ERC20 seeded into the local token list (which is what browser mode does via `seedCustomToken`), the UI issues **no** token-mappings call at all — see finding **C6** |
| P7 | `eth_getBalance` (native) / `balanceOf` (ERC20) | balance display for the selected token | `staleTime 15_000`; `refetchOnMount/WindowFocus/Reconnect: false`, `retry: 0` (`useTokenBalance.ts:44-51`) | `useTokenBalance.ts:52-66` (SDK `getNativeBalance` / `ERC20.getBalance`) | One read per (chain, token, address) per 15 s, no refetch on mount |
| P8 | `eth_gasPrice` | bridge form mounted | `staleTime 15_000`, same no-refetch flags (`useGasEstimate.ts:28-32`) | `useGasEstimate.ts:33-37` | One per chain per 15 s. Note the UI's *displayed* fee uses hardcoded gas units (`app/constants/gasValues.ts`), not an estimate — no extra call |
| P9 | `allowance` (ERC20 `eth_call`) | ERC20 selected **and** `amount > 0` (`useCheckAllowance.ts:26`) | no `staleTime`; `refetchOnMount/WindowFocus/Reconnect: false`; keyed including `amount.toString()` (`:29`) — so **each distinct amount is a fresh cache entry and a fresh call** | `useCheckAllowance.ts:35-45` | One per (chain, token, owner, spender, **amount**) |
| P10 | `eth_getTransactionCount` + `eth_estimateGas` — **first pair**, from the SDK's tx builder | every `approve` / `bridgeAsset` / `claimAsset` build | once per build, issued in parallel (`Promise.all`) | SDK `buildApprove` / `buildBridgeAsset` / `buildClaimAsset` → `BaseContract.getNonce` + `BaseContract.estimateGas` | Replay |
| P11 | `eth_getTransactionCount` — **second call, from viem's `prepareTransactionRequest`** re-deriving the nonce `mapTransactionRequest` still doesn't forward (deliberate, see C4/C5 below); **`eth_estimateGas` no longer duplicates here as of the C4 fix in the app** (see C4 — `mapTransactionRequest` now forwards the SDK's `gas`, so viem's own default-parameter estimate is skipped) **in the real UI**, where `useBridgeExecution.ts`/`useClaimExecution.ts` spread `mapTransactionRequest`'s full return value into `sendTransaction`. **Not observed in the headless loadtest harness**: `headlessUser.ts`'s `sendAndWait` builds its own `sendTransaction` argument object field-by-field and never reads `mapped.gas`, so headless approve/claim sends still pay the second `eth_estimateGas`; headless bridge sends already skipped it before the fix too, via the pre-existing `opts.gasOverride` (`bridgeTxParams.gas` + `bridgeGasOffset`), unrelated to this fix | same builds | once per build (nonce only, post-fix) | `app/utils/transaction.ts:26-45` (`mapTransactionRequest`, post-fix) forwards `gas` when present, still omits `nonce`; `prepareTransactionRequest.js`'s default parameters include both, but only fills whichever the request didn't already supply | Replay the nonce re-derivation always. Replay the SDK-plus-viem doubled `eth_estimateGas` **only for headless approve/claim** (not bridge, not browser-mode's other two build kinds) — this is finding **C4**, fixed for the real UI by the C4 fix, deliberately NOT extended to `headlessUser.ts`'s own send call (out of that fix's scope) |
| P12 | Fee derivation for the send: an `eth_fillTransaction` attempt first (support cached per client uid), and on failure `eth_getBlockByNumber(latest)` + `eth_maxPriorityFeePerGas` (fallback `eth_gasPrice`) | same builds | once per send; EIP-1559-ness cached per client uid | `prepareTransactionRequest.js:80-101` (fill attempt), `:191-197,230-283` (block/fees/gas), `estimateMaxPriorityFeePerGas.js:18-40` | Replay through the same viem version so the fill/fallback decision matches. **[VERIFIED] — settled against the compose devnet and reconfirmed in the retried acceptance run.** The headless side was confirmed live against the compose devnet's anvil (headless-trace.ndjson from a real run: 2 users, L1→L2A→L2B→L1, ETH + ERC20 laps). Every send takes the **fallback branch**: viem issues `eth_fillTransaction` first (HTTP 200, but a JSON-RPC-level `MethodNotFoundRpcError`/`MethodNotSupportedRpcError` — anvil does not implement `eth_fillTransaction`; the HTTP status alone does not show this, only the JSON-RPC error body does), catches it, sets `supportsFillTransaction.set(client.uid, false)`, and falls through to `eth_getBlockByNumber('latest')` + `eth_maxPriorityFeePerGas` (which succeeds — anvil is EIP-1559 — so the `eth_gasPrice` fallback is never reached). The `eth_fillTransaction` attempt is cached **per viem client uid**, i.e. per (chain, wallet-client-instance): the first send on a given chain for a given user pays for the wasted `eth_fillTransaction` round-trip, every subsequent send on that same chain+user skips straight to `eth_getBlockByNumber`+`eth_maxPriorityFeePerGas`. Confirmed identical on L1 (`l1rpc`) and L2A (`l2rpc-001`) sends. **The browser build (same pinned viem version, driven through the real UI via Playwright) was confirmed to take the identical branch**: the acceptance run's `accept-collector-snapshot.json` records `rpc/{l1rpc,l2rpc-001,l2rpc-002}/eth_fillTransaction` alongside `eth_getBlockByNumber` and `eth_maxPriorityFeePerGas` for every chain, with `eth_gasPrice` present separately only from `useGasEstimate.ts`'s own 15s-cadence UI call (P8), never as a fee-derivation fallback — i.e. `eth_gasPrice` is never reached as a fallback in either mode. As predicted, the decision is purely a function of what anvil supports, not of which caller invokes `sendTransaction`. |
| P13 | `eth_sendRawTransaction`, then `eth_getTransactionReceipt` polling | every approve / bridge / claim | wagmi `useSendTransaction` then viem `waitForTransactionReceipt` (`useBridgeExecution.ts:119-121,161`, `useClaimExecution.ts:166-180`) | as cited | Replay; poll interval must match viem's default for the chain |
| P14 | `isClaimed` (`eth_call` on the destination bridge) | manual claim: **once** before building (`useClaimExecution.ts:97-100`); on **any** non-user-rejection throw, **up to 3 more times** with `0 / 400 / 1000 ms` backoff, stopping at the first `true` (`:244-258`) | as described | `useClaimExecution.ts:94-100,244-258` | Replay both — the retry loop is finding **C3** |

### 9.2 Calls the UI never makes (steady state)

`/bridge/v1/bridges`, `/bridge/v1/claims`, `/bridge/v1/claim-candidates`,
`/bridge/v1/sync-status`, `/tracker/v1/health`, any proxy health endpoint.
Ready-to-claim is derived **client-side** from the activity response's
tracking step (`app/services/activity.ts:134-153`: current step
`WaitingClaim` with `status !== 'done'` ⇒ `READY_TO_CLAIM`). The headless
worker MUST derive it the same way and MUST NOT call any of the above during
the run. `sync-status` and `tracker/health` are permitted **only** in
preflight (§4.5), which runs before the measurement window opens.

Two response-parsing behaviours are part of parity, not optional:

- The activity response is read as **text** and passed through
  `quotePrecisionUnsafeIntegers` before `JSON.parse`
  (`app/services/activity.ts:273-329,355-357`). `response.json()` would round
  every L1-origin `global_index` (≈2^64 + deposit_count) to the same double
  and a manual claim built from it would be short by exactly
  `deposit_count`. The headless worker MUST use the same
  `parseActivityResponse`.
- Row identity is `tx_hash:deposit_count` (`activity.ts:191`), **not**
  `bridge_hash` (a content hash shared by every deposit of the same amount to
  the same receiver — a load test sending identical amounts will collide on it
  constantly) and **not** `global_index` (precision-unsafe). The ring state
  machine keys rows on `tx_hash:deposit_count`.

### 9.3 Findings — where the `app/` sources contradict or under-specify the call set in §9.1

Reported, not silently corrected. Each is falsifiable at the cited line.

- **C1 — activity `staleTime: 30_000` is missing from the bare call list.**
  `useTransactions.ts:80` and `useReadyToClaimCount.ts:29`. A worker replaying
  only the `refetchInterval` values would issue requests the UI suppresses on
  mount/remount. Affects request-count parity, not cadence at steady state.
- **C2 — the badge/page dedup changes the effective interval.** Both hooks
  share queryKey `['activity', mode, address]`; react-query runs the shortest
  interval among live observers, so a user on the transactions page polls at
  `min(5000|10000, 15000)` with **one** request, while a user on the bridge
  page polls at `15000`. The "badge 15 s (deduped by queryKey)" note is
  right about the dedup but does not state the min-interval consequence.
- **C3 — the post-throw `isClaimed` re-check is a bounded retry loop, not a
  single call.** `useClaimExecution.ts:251-257` iterates `[0, 400, 1000]` ms.
  The original harness wording "the UI's post-throw `isClaimed` re-check" (singular) undercounts
  by up to 3 `eth_call`s per failed claim — which matters precisely under the
  concurrency a load test creates.
- **C4 — every tx build costs *two* `eth_estimateGas` and *two*
  `eth_getTransactionCount`, plus fee-derivation calls.** **FIXED
  (2026-09-15).** `app/utils/transaction.ts:26-38` (`mapTransactionRequest`)
  used to return only `{to, data, value}`, discarding the `gas` and `nonce`
  the SDK just computed (`buildBridgeAsset`/`buildClaimAsset`/`buildApprove`
  each do `Promise.all([getNonce, estimateGas])`); viem's
  `prepareTransactionRequest` then re-derived both because they are in its
  default parameter set. The original inventory lists one pair — **this was the largest
  single correction to the RPC accounting**, and the parity diffs
  showed the doubled pair in both modes. The fix forwards the SDK's `gas`
  (a `bigint`, conditional on presence — see the `mapTransactionRequest`
  diff) so viem's `prepareTransactionRequest` no longer needs to re-estimate
  it; `nonce` is **deliberately still not forwarded** (see C5's note below
  and the code comment at `transaction.ts`). See §9.1 P11 for the measured
  before/after `eth_estimateGas` count.

  **Measured, live against the compose devnet (2026-09-15):** a single-lap
  headless run's L1 anvil logs, compared byte-for-byte before/after the
  fix with the devnet reset between them, show the identical
  `eth_getTransactionCount, eth_estimateGas, eth_getTransactionCount,
  eth_sendRawTransaction` cluster per build in BOTH states for headless mode
  — see the finding two paragraphs below for why (`headlessUser.ts`'s own
  send call never reads `mapTransactionRequest`'s new `gas` field). The real
  saving was instead confirmed **in the actually-affected code path** — a
  live `tests/bridge/manual-claim.spec.ts` run (real browser, real wagmi
  `useSendTransaction`, driving the real app UI) — whose L1 anvil log shows
  **every one of its 4 builds** (top-up bridge, and the manual claim) as a
  clean `eth_getTransactionCount, eth_estimateGas, eth_getTransactionCount,
  eth_sendRawTransaction` cluster: **one** `eth_estimateGas` per build, down
  from the two documented pre-fix traces (P10/P11 above), with
  `eth_getTransactionCount` still appearing twice (nonce still re-derived,
  as expected since `nonce` is not forwarded). This is also independently
  provable from viem's own source
  (`viem/_cjs/actions/wallet/prepareTransactionRequest.js`): `if
  (parameters.includes('gas') && typeof gas === 'undefined') request.gas =
  await estimateGas(...)` — once `mapTransactionRequest` supplies a
  `bigint` `gas`, that branch never runs.

  **Finding: the headless loadtest harness itself does not exhibit this
  saving**, and should not be expected to. `loadtest/workers/headless/
  headlessUser.ts`'s `sendAndWait` builds its `sendTransaction` argument by
  hand (`{ to: mapped.to, data: mapped.data, value: mapped.value,
  ...(opts.gasOverride ...) }`) rather than spreading `mapped` — so
  `mapped.gas` (the field the C4 fix added) is never read there. Two identical
  single-lap ERC20 headless runs (devnet reset between them, one on the
  pre-fix code, one on post-fix) confirmed this empirically: **approve**
  sends cost 2 `eth_estimateGas` calls in both states (unaffected — approve
  passes no `opts.gasOverride`, and `sendAndWait` doesn't read `mapped.gas`
  either), and **bridge** sends already cost only 1 in both states (already
  forwarding gas via the pre-existing `opts.gasOverride` =
  `bridgeTxParams.gas` + `bridgeGasOffset`, computed straight from the raw
  SDK response, independent of `mapTransactionRequest`). Extending
  `headlessUser.ts` to also spread `mapped.gas` for approve/claim was
  considered and **rejected as out of scope** (that fix was restricted to
  `app/utils/transaction.ts`, its tests, docs, and comments
  only) — flagged here for future work, not fixed now.
- **C5 — the `+300000` gas offset could not be applied in browser mode.**
  **CLOSED (2026-09-17).** Not closed by the C4 fix: it was once claimed
  that forwarding the SDK's `gas` would close this, and **that claim was
  wrong** — the SDK's estimator is a bare, bufferless pass-through
  (`client.estimateGas(...)` returned as-is, no headroom — see
  `@agglayer/sdk`'s `BaseContract.estimateGas`), so forwarding it changed
  *which* estimate got sent, not whether it had any margin.
  **What closed it:** `app/utils/transaction.ts` now exports
  `BRIDGE_GAS_BUFFER = 300_000n` and `mapTransactionRequest` takes an opt-in
  `{ gasBuffer }`, which `useBridgeExecution.ts`'s **bridge send only** passes.
  Approve and claim are deliberately left unbuffered — neither races the
  global exit root, and neither produced a single out-of-gas revert in the
  measurement below. `gas.bridgeGasOffset` is therefore **no longer a
  divergence** (§1.1); a drift guard in `loadtest/config/schema.test.ts`
  asserts the schema default and `BRIDGE_GAS_BUFFER` stay equal.
  **The measurement that sized it** (loadtest/CAPACITY-REPORT.md §5.3;
  browser-only, 20 users, an otherwise idle system): 46 of 1019 L1
  `bridgeAsset` calls — **4.5%** — reverted, all with an inner
  `updateGlobalExitRoot` frame reading `out of gas` in a `callTracer` trace,
  while `eth_call` against the parent block succeeded. EIP-150's 63/64 rule
  leaves the outer frame enough gas to return, so **the receipt shows a plain
  revert with `gasUsed` at only ~97% of the limit** — a gasUsed-vs-gasLimit
  check does not detect it. Successful calls used up to **240,603** gas while
  the bufferless estimates that reverted carried limits of **186,507**
  (median) / 231,281 (max), so a conventional 10–25% multiplier would not have
  covered the gap; +300,000 matches the headless offset, which saw zero such
  reverts across ~40,000 bridges.
  **Verified, not just implemented** (a dedicated verification run, browser-only, 20 users,
  parameters byte-identical to the run that exposed it): `bridgeAsset` reverts
  **79 → 0** across all three chains, browser lap completion **51.5% → 91.1%**,
  hop success **80.1% → 97.0%**, and the `"Transaction failed"` modal
  assertions went **79 → 0** — a 1:1 match with the 79 reverts, which confirms
  the diagnosis rather than merely correlating with it.
  **Residual:** if the SDK ever stops populating `gas`, `mapTransactionRequest`
  emits no `gas` key and viem re-estimates bufferlessly at send time, where the
  buffer cannot apply — asserted by a test rather than assumed away. Separately,
  10 `ui_assertion`s remain in the verification run, all
  `[claim-tokens-button] locator.click: Timeout 30000ms` on the manual-claim
  `L2B→L1` hop — a UI-render/harness-timing issue with no transaction behind it,
  unrelated to C5 and already present before the fix.
- **C6 — `token-mappings` is not "per non-native activity row".** It is
  gated on `!isNative && !localToken` (`transactionListItem.tsx:59-63`). A
  token present in the local/custom token list produces **zero**
  token-mappings calls. Browser mode seeds the devnet ERC20 as a custom token
  (`bridge-page.ts:104-135` `seedCustomToken`), so browser users will make
  *fewer* token-mappings calls than the bare call list implies. The headless worker must
  mirror whichever choice browser mode makes, and the run config records it
  (`headless.seedTokenList: boolean`, default `true` to match browser mode).
- **C7 — `token-mappings` is never issued alone.** SDK `getTokenMetadata`
  composes `/token-mappings` **plus** on-chain `ERC20.getMetadata()`, which is
  `Promise.all([name, symbol, decimals])` then a tolerated `totalSupply` —
  i.e. **3–4 additional `eth_call`s** per metadata fetch. The bare call list records
  only the REST call.
- **C8 — the ERC20 bridge goes through `ERC20.bridgeTo`, not
  `Bridge.buildBridgeAsset` directly.** `useBridgeExecution.ts:148-152`.
  `bridgeTo` wraps `buildBridgeAsset` with `permitData: '0x'` and
  `forceUpdateGlobalExitRoot: true`, so the wire result is equivalent, but
  The original harness wording ("`buildBridgeAsset` (+ `bridgeGasOffset`)") names the
  wrong entry point for the ERC20 path. The native path passes
  `token: wethToken ?? ZERO_ADDRESS` and no `permitData` (defaults to `'0x'`),
  `useBridgeExecution.ts:137-147`.
- **C9 — the `connect-wallet` ambiguity is already resolved in the page
  object.** The initial spec said to use `:visible`; `bridge-page.ts:52` instead scopes
  the locator to `header-desktop`
  (`this.headerDesktop.getByTestId('connect-wallet')`), which is unambiguous.
  Browser mode should reuse the page object as-is and **not** add a `:visible`
  filter.
- **C10 — there is no real testnet proxy URL in the repo.** `config.json`'s
  `appModes.configs.testnet.aggkitProxy` is
  `https://PLACEHOLDER-testnet-aggkit-proxy`, and `mainnet`'s is likewise a
  placeholder. A production aggkit-proxy URL is not something the repo carries;
  the operator needs to supply it alongside the funded
  key. §2.4 encodes this as a `validate` failure rather than a silent
  placeholder run.
- **C11 — testnet mode has only two chains, and Bokuto's `networkId` is
  37.** So the testnet ring is 2 hops, and no code may assume L2 network ids
  are `1..N`. The 3-chain example ring (§2.3) is devnet-shaped only.
- **C12 — activity rows carry a 4th status, `ERROR`.** `deriveStatus`
  (`activity.ts:147-153`) returns `ERROR` when the endpoint's `claimed`
  tri-state is `'error'`, and callers "must not read `error` as `false`"
  (`activity.ts:91-94`). There is no state for it in a plain phase list; §3.2's T16
  adds `activity_status_error`. Tracker `api_revision` 5 drops `claimed` for a
  string `claim_status`; `deriveStatus` also maps `claim_status: "claimed"` to
  `CLAIMED` (no other `claim_status` value is evidenced yet).
- **C13 — the activity response can carry per-network `warnings`.**
  `activity.ts:109-120`: one entry per upstream bridge service that failed, so
  the list may be an incomplete picture for that `network_id` while the
  request itself succeeded. The headless worker must record these as class
  `proxy_5xx`-adjacent counter `activity_warning{network_id}` rather than
  ignore them — otherwise a partially-broken fan-out looks like a clean run
  with missing rows.
- **C14 — an L1-origin ERC20's address is different on every non-origin
  chain, and nothing in the UI call set resolves it (a parity-diff
  finding).** A configured erc20 asset's `address` in `loadtest.config.json`
  is always the **origin** network's address (`config/schema.ts`'s
  `originNetworkId` convention). On any other ring chain the token exists
  only as a wrapped ERC20 at a different, per-chain contract address. The
  headless worker resolves the address to actually use for balance reads,
  `allowance`, `approve` and the bridge call — **lazily, per hop, after
  that chain's inbound claim has landed** (never all three chains up
  front, and never for the destination chain of a hop that hasn't claimed
  yet) — via three tiers, cached per `(originNetworkId, originAddress,
  chain.networkId)`:
  1. `chain.networkId === asset.originNetworkId` → the configured/origin
     address, unresolved. No call.
  2. Otherwise, the UI-parity-correct source (row **P6**): `GET
     {proxy}/bridge/v1/token-mappings?network_id={chain.networkId}&origin_token_address={originAddress}`
     via the pinned SDK's
     `AggkitBridgeAggregator.clientFor(chain.networkId).getTokenMappings(...)`
     → `token_mappings[0].wrapped_token_address`. Verified live against the
     compose devnet: `network_id=1` (L2A) returns a populated mapping
     (`wrapped_token_address: 0xBd0920402b6323Ad6b27A28622f5a63dE5e5E9D1`)
     once the L1→L2A claim has landed there.
  3. If tier 2 comes back empty (`{"token_mappings":[],"count":0}` —
     verified live for `network_id=2`/L2B before its inbound L2A→L2B claim
     had landed) or throws (transient proxy failure), fall back to an
     on-chain read via the pinned SDK's `Bridge.getWrappedTokenAddress`
     (`getTokenWrappedAddress` — a plain deployed-address mapping lookup).
     **Not** `Bridge.getPrecalculatedWrapperAddress`
     (`precalculatedWrapperAddress`): the two differ on this devnet's
     deployed bridge contract — `precalculatedWrapperAddress` **reverts
     with no reason** (confirmed live during the retried acceptance run), while
     `getTokenWrappedAddress` returns the zero address instead of
     reverting when no wrapper is deployed on that chain yet (a plain
     Solidity mapping default, not an error). A zero-address result is
     read as "the wrapper genuinely does not exist yet" — legitimate while
     the corresponding inbound claim is still in flight — and is
     deliberately **not** cached, so a later resolve() call (after that
     claim lands) re-checks instead of being stuck on a stale answer; a
     resolved non-zero address IS cached indefinitely (a wrapped address
     for a given `(originNetwork, originToken, chain)` triple is
     deterministic once deployed).

  This resolution is a **headless-only addition** (§9.4): the UI itself
  never performs it, because browser mode selects the devnet ERC20 via
  `seedCustomToken` (C6) rather than by asset-address lookup, so the UI has
  no equivalent code path to diverge from. Implementation:
  `loadtest/workers/headless/uiCallset.ts`'s `TokenAddressResolver`
  (pure, unit-tested) + `headlessUser.ts`'s `tokenAddressResolver` (wires
  the two tiers above to the pinned SDK).

- **C6 refinement (the headless-vs-browser parity diff) — "zero token-mappings calls" holds
  only for the seeded chain, not the whole lap.**
  `loadtest/workers/browser/browserUser.ts:262-266`'s `bridge()` seeds the
  custom token **per hop, for that hop's `fromChain` only**
  (`bridge-page.ts#seedCustomToken`), lazily, exactly when that hop begins.
  A wrapped-token row for a chain that has **not yet been the `fromChain`
  of a hop** (e.g. the destination row that appears right after an
  auto-claim, before the *next* hop's `bridge()` call seeds that chain) is
  briefly not in the local token list, so `transactionListItem.tsx`'s
  `!isNative && !localToken` gate is briefly `true` and the UI fires a
  transient `bridge/token-mappings[0]` call (network_id 0 = this ERC20's
  origin network, per P6's `originTokenNetwork` convention, regardless of
  which chain's row triggered it) for that row until the next hop's seed
  call lands. The acceptance run (`accept-collector-snapshot.json`)
  shows exactly this: **3** `bridge/token-mappings[0]` calls across 4 users'
  ERC20 laps (0.75/user) — small, transient, and **not** the "the UI issues
  zero token-mappings calls for the seeded ERC20" claim taken literally.
  C6's core claim (no token-mappings for the *actively selected* token on
  its *current* chain) still holds; this refines it rather than reversing
  it, and is not a headless bug (there is nothing to fix — the UI's own gate
  is working exactly as `transactionListItem.tsx` specifies).

- **C15 — `eth_fillTransaction`'s "cached per client uid" resets on every
  real chain switch; headless never switches, so it pays once per chain,
  ever.** P12 already establishes that anvil's non-support is cached per
  viem client uid. What P12 does not say is *how long a client uid lives*.
  Headless holds one long-lived `WalletClient` per chain for the entire
  run (`headlessUser.ts`'s `chainRuntime`), so the wasted
  `eth_fillTransaction` round trip is paid **once per (user, chain) for the
  whole run**, confirmed live: `headless-trace.ndjson` shows exactly 2
  `eth_fillTransaction` samples per chain (1 per user) on `l1rpc`,
  `l2rpc-001` and `l2rpc-002` alike, regardless of how many builds that
  user later does on the same chain. The real wallet/connector driving
  browser mode instead appears to hand out a **fresh** client (new uid)
  each time the active chain context changes — which happens on every hop,
  because a real bridging user's wallet genuinely switches networks per
  hop. `accept-collector-snapshot.json` shows `eth_fillTransaction` counts
  of 16/8/8 (l1rpc/l2rpc-001/l2rpc-002) for 4 users — exactly 2 "chain
  visits" per lap on `l1rpc` (an initial bridge-build visit, then a later
  claim visit after returning from L2B) × 4 users × 2 laps = 16, and 1
  visit per lap on each L2 chain × 4 users × 2 laps = 8. Not a bug in
  either mode — it is the direct, unavoidable consequence of one mode
  holding direct chain clients from the start and the other mode driving a
  real wallet that must switch networks to match the ring's hops.

- **C16 — browser mode's own control-flow polling adds `tracker/activity`
  requests the real UI never issues.** `browserUser.ts`'s `readState()`
  (called to decide when a hop is ready to claim) calls `observeActivity()`,
  which does its own `page.evaluate(() => fetch(...))` against
  `{proxy}/tracker/v1/activity/from/{addr}?includeTracking=true` — a
  request Playwright's `timing.ts` records identically to the UI's own
  background poll (same `classifyEndpoint` result: `tracker/activity`).
  This is deliberate (`browserUser.ts:19-34`'s module doc: there is no DOM
  signal carrying `depositCount`/`sourceNetwork`/`globalIndex`, so the
  driver must ask the same endpoint the UI's `useTransactions` hook already
  asks) but it means the **driver's own polling loop and the real UI's
  `useTransactions`/`useReadyToClaimCount` polling loop run concurrently
  and are not deduped against each other** — unlike headless, where the
  worker's single poll loop **is** the P1 replay, with nothing else
  polling in parallel. This is structural, not fixable without either (a)
  giving the driver a DOM-only signal (it has none, per the module doc) or
  (b) hooking react-query's cache from outside the page (not available to
  Playwright). It is visible in the acceptance HAR as a much higher
  `tracker/activity` request volume per user (200.5/user) than headless
  (107/user) despite comparable per-hop wall-clock budgets, and as
  near-simultaneous (3–20 ms apart) duplicate-looking timestamps where the
  driver's own poll happens to land close to the UI's independent poll
  tick. The underlying cadence *family* (burst 500/1000/2000/3000 ms, then
  5000 ms, then 10000 ms once all rows are terminal) is still present and
  correct in the merged stream (§ PARITY.md P1) — the divergence is in
  request *volume*, not in whether the UI's own cadence rule is honored.

  **The follow-up fix and measurement (mitigated, not eliminated — the structural
  asymmetry above still holds).** Two changes, both scoped to
  `browserUser.ts`, no DOM scraping, no UI cadence change:
  1. **Attribution.** Every HTTP sample now carries `origin: 'ui' | 'harness'`
     (`collector.ts`'s `HttpOrigin`, default `'ui'`). The driver's own
     `observeActivity()` fetch appends a harmless marker query param
     (`_ltPollOrigin=harness`, verified live to be ignored by the backend
     and invisible to `classifyEndpoint`) so `timing.ts` tags that one
     sample `harness` while the UI's own independent background poll to
     the same endpoint (no marker) keeps tagging `ui`. `results.json` and
     `summary.md` now report the two separately, with `ui` as the
     headline.
  2. **Rate.** `observeActivity()`'s real fetch is now single-flight +
     TTL-cached (`fetchActivitySingleFlight()`, ~5s TTL matching
     `harnessPollIntervalMs`): concurrent callers (multiple in-flight laps
     per user under `maxInflightLapsPerUser`) join one shared fetch
     instead of each racing a stale throttle timestamp into firing its
     own — the attempt #1 defect, which paradoxically drove harness volume
     **up** 4.5x (measured ~1s effective interval instead of the intended
     flat 5s). Same dedup shape as `pool.ts`'s `crashInFlight`.
  3. **Retry (retry #1 correction, found by re-measuring).** Sharing one
     fetch across concurrent callers means a single transient failure's
     blast radius is now every joined caller, not just the one unlucky
     caller — first measured live as a same-parameters before/after
     regression from 0 to 33 `internal` hop outcomes, root-caused to
     `page.evaluate: TypeError: Failed to fetch` (almost certainly a
     concurrent lap's own wallet chain-switch navigating this driver's ONE
     shared page mid-fetch; the tracker/activity request itself doesn't
     depend on which chain the wallet is on, so re-issuing it is always
     safe). `fetchActivityTextWithRetry()` retries the real fetch up to 3
     attempts with a short delay, but does NOT retry `isCrashLikeError`
     failures — those still propagate immediately so `runGuarded`'s crash
     race reacts without delay.

  Measured on two independent real 4-browser-user runs (`--rate 2
  --minutes 6`, actual wall-clock ≈16.2 min each including
  ramp/steady/drain), after the retry correction:
  ```
  run A (970 972 ms): ui n=453 (113.3/user, 7.00/user/min, headline)   harness n=195 (48.8/user, 3.01/user/min)
  run B (967 158 ms): ui n=546 (136.5/user, 8.47/user/min, headline)   harness n=192 (48.0/user, 2.98/user/min)
  ```
  Harness traffic is consistently ~3.0/user/min across both runs — down
  from 57.5/user/min in attempt #1's race (an ~19x reduction) and now
  *below*, not above, the UI's own rate — comfortably under the ≤~12/user/min
  target. Run A's regression (0 → 33 `internal` hop outcomes,
  `TypeError: Failed to fetch`) was reproduced, root-caused to the
  single-flight blast-radius effect above, and fixed by the retry: run B
  (identical params, retry code in place) shows **zero**
  `TypeError: Failed to fetch` occurrences. Run B still shows a comparable
  count of `internal` hop outcomes (32), but from an unrelated cause —
  `locator.click`/`locator.getAttribute` UI-interaction timeouts, not
  `observeActivity()` at all — consistent with a documented observation
  that devnet/browser-mode grows flakier after many
  hours of continuous load-testing; flagged as a follow-up, not a
  regression from the mitigation. See `PARITY.md` §2 for the origin-split update to the
  endpoint-class table.

### 9.4 Declared divergences (exhaustive)

| Divergence | Browser | Headless | Why |
|---|---|---|---|
| `gas.bridgeGasOffset` | applied as `BRIDGE_GAS_BUFFER` (C5 fix) | applied | C5 — closed |
| `gas.claimGasOffset` | **not applied** (UI claim has no margin) | applied (+60 000 on the claim gas limit) | Stage-2 ring J: 4/64 first-mint claims reverted out-of-gas (limit 202 542 vs ~228k needed when concurrent claims changed state between estimate and execution). Intentional, load-test-only: it keeps the harness measuring throughput instead of the estimate race. The race itself is a **separate product finding** (the real UI can hit it) |
| `page_load`, `wallet_connect` phases | measured | absent | no page |
| `console_error` capture | yes | n/a | no console |
| `seedTokenList` | always (custom-token seeding is how the UI selects the devnet ERC20); a transient, per-hop seeding gap still yields a small residual `token-mappings[0]` count (0.75/user observed) | config `headless.seedTokenList`, default `true` | C6 |
| Per-chain ERC20 wrapped-address resolution (token-mappings + on-chain fallback) | not performed (no equivalent UI code path — see C6) | `TokenAddressResolver`, three tiers, per-hop lazy resolution | C14 |
| `eth_fillTransaction` wasted-round-trip frequency | paid once per (user, chain) **per real wallet chain-switch visit** (a fresh client uid per hop) | paid once per (user, chain) **for the whole run** (one long-lived client per chain) | C15 |
| `tracker/activity` request volume (not cadence) | UI's own background poll (attributed `origin: 'ui'`) **plus** the driver's independent `readState()`/`observeActivity()` control-flow poll (attributed `origin: 'harness'`, single-flight + ~5s TTL cached) — attributed and rate-bounded, still a second, undeduped poller | the worker's single poll loop **is** the P1 replay — no second poller | C16 |

Anything else that differs between the two modes is a defect.

### 9.5 SDK retry behaviour is part of the load

`fetchRawText` retries a *transport* failure up to `DEFAULT_RETRIES = 3`
times with exponential backoff (`retryDelay × 2^attempt`) and a
`DEFAULT_TIMEOUT = 30_000` ms per attempt. So one logical `/bridge/v1/*` call
can be up to 4 requests. Both modes inherit this (same pinned SDK), and the
HTTP sample's `attempt` field (§5.2) is what makes it visible. A non-2xx
*response* is **not** retried — only transport failures are.

---

## 10. Non-goals (recorded so audits do not report them as gaps)

- No Prometheus exporter or dashboards (deliberate non-goal).
- No distributed / multi-host mode (deliberate non-goal); the report's host section
  is what documents the single-host ceiling.
- No mainnet run.
- No LBT seeding step — §3.7 makes it structural instead.
- No `bridgeMessage` / `bridgeMessageWETH` path. A ring chain whose
  `gasTokenAddress() != 0x0` is **refused at `validate`** with
  `GAS_TOKEN_NOT_ETHER`, mirroring aggkit `bridge_loop_tester` DESIGN.md §6's
  recommendation. **[VERIFY]** — `preflight` reads `gasTokenAddress()`
  live on every ring chain rather than trusting the devnet's expected zero
  address.
- No changes to `tests/bridge/models/bridge-page.ts` beyond additive,
  backward-compatible helpers (deliberate non-goal).

# Bridge Load Test Baseline — Devnet Snapshot

## Devnet Topology

This baseline captures the E2E test performance against the vendored devnet snapshot bundle (`tests/devnet/`) as the reference for load-test development.

### Container Images (Digest-Pinned)

The devnet is immutable, all images are pinned by `@sha256:<digest>` (not mutable tags). Snapshot produced 2026-09-02T14:44:26Z from kurtosis-cdk `feat/aggkit-bridge-ui-backend` (commit b119c76e56bd53f73f2d0da1647ff7b148b74183).

| Service | Image | Digest | Size | Tag/Version |
|---------|-------|--------|------|------------|
| **anvil-001** (L1) | ghcr.io/foundry-rs/foundry | sha256:cfbba3fcb53185f6c6fa9f15289bae267b74e639821262cd0626fc9d3c6cfe40 | 479MB | v1.5.1-1788360503 |
| **l2-anvil-001** | ghcr.io/foundry-rs/foundry | sha256:08a6a589f96f5a72e0a05170f730f49facd3e9a6aaf413a0d50900d4f1a887da | 441MB | v1.5.1-1788360503 |
| **l2-anvil-002** | ghcr.io/foundry-rs/foundry | sha256:731e672f4900a2f2f3fbced47b32972e2af89899a4070279d7cd463e7b4aac66 | 422MB | v1.5.1-1788360503 |
| **agglayer** | ghcr.io/agglayer/agglayer | sha256:ceb548438d50f022475ed35056c9ccda0c58ec0242035a12cb5ff1354e843279 | 3.15GB | 0.6.0-rc.8-1788360503 |
| **aggkit-001** | ghcr.io/agglayer/aggkit | sha256:4a981cc5fca3a2d281ed6c9ff4aef9c5ccf48f509086c06c422ce810808a8a44 | 365MB | 0.11.0-rc8-1788360503 |
| **aggkit-002** | ghcr.io/agglayer/aggkit | sha256:9b002f96acebfbe46e95b98283be54a10dc67fd5bfdfffd2eff58df3ae5dc348 | 365MB | 0.11.0-rc8-1788360503 |
| **aggkit-proxy-001** | ghcr.io/agglayer/aggkit | sha256:dfc9019cda81f86e3996984b8f030610db13484d1401371100b1a1efb04b9775 | 365MB | 0.11.0-rc8-1788360503 |
| **agglayer-dev-ui-proxy-002** | haproxy (via gcp artifact) | sha256:215f07b29e3da1cf9a4838eeadbd855932ab524bc665b4c1f3470c30da8ab639 | 108MB | 3.2-bookworm-1788360503 |
| **agglayer-dev-ui-002** | ghcr.io/agglayer/agglayer-dev-ui | sha256:233cb48d67fc6d9760bd059cd221100315a092b9ee75f7e91f183b67769e0f77 | 72.2MB | dispatch-feat-aggkit-backend-8563dd4ba87-1788360503 |

### Chain & Network Configuration

| Chain | Chain ID | Network ID | RPC Port | Status |
|-------|----------|------------|----------|--------|
| **L1 (Ethereum fork)** | 271828 | 0 | 8545 (direct), 8555/l1rpc (via proxy) | Healthy ✓ |
| **L2-001 (Katana)** | 20201 | 1 | 11545 (direct), 8555/l2rpc-001 (via proxy) | Synced & Active ✓ |
| **L2-002 (Katana)** | 20202 | 2 | 12545 (direct), 8555/l2rpc-002 (via proxy) | Synced & Active ✓ |

### Network Endpoints

- **Dev-UI CORS Origin (CI endpoint):** http://127.0.0.1:8555 (port 8555, haproxy)
- **Aggkit Proxy REST API:** http://127.0.0.1:8555/aggkitapi (bridge + tracker)
- **Aggkit REST (direct, L2-001):** http://127.0.0.1:11577 (port 11577)
- **Aggkit REST (direct, L2-002):** http://127.0.0.1:12577 (port 12577)
- **Aggkit Proxy (direct):** http://127.0.0.1:8556 (port 8556)

### Bridge Contract

| Field | Value |
|-------|-------|
| **Contract Address** | 0xC8cbEBf950B9Df44d987c8619f092beA980fF038 |
| **Deployment (L1)** | Block 254 (at snapshot time) |
| **Network Sync Status** | Settlement-free (no in-flight bridge activity at capture) |

## Test Wallet & ERC20

| Field | Value |
|-------|-------|
| **E2E Wallet Address** | 0xE34aaF64b29273B7D567FCFc40544c014EEe9970 |
| **E2E Private Key** | 0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625 |
| **ERC20 Address** | 0xe293A6b8F558422813499bb5C89B60adD8c54636 |
| **ERC20 Name** | Agglayer E2E Token |
| **ERC20 Symbol** | E2E |
| **ERC20 Decimals** | 18 |
| **ERC20 Holder Balance** | 1000 E2E tokens (0x00...3635c9adc5dea00000 wei) |

## E2E Test Baseline

### Test Execution

**Date:** 2026-09-10
**Command:** `pnpm exec playwright test tests/e2e/preflight.spec.ts tests/bridge/smoke.spec.ts tests/bridge/claim-autoclaim.spec.ts`

### Test Results

| Spec | Result | Details |
|------|--------|---------|
| **tests/e2e/preflight.spec.ts** | ✓ PASS | 4 tests: funded wallet balance (L1), aggkit sync-status (networks 0, 1, 2) |
| **tests/bridge/smoke.spec.ts** | ✓ PASS | 2 tests: load homepage, connect wallet |
| **tests/bridge/claim-autoclaim.spec.ts** | ✓ PASS | 1 test: L1→L2 deposit via aggkit autoclaim |

**Total Tests:** 7 passed in **28.9 seconds**

### Observed Latencies

| Metric | Value | Notes |
|--------|-------|-------|
| **L1→L2 Autoclaim Latency** | <30s | Inclusive of homepage load, wallet connection, deposit initiation, and autoclaim completion |
| **Devnet Ready (devnetReady.mjs)** | ~2min 30s | 9 checks: 3 chains (chainId verify), 3 chains (bridge bytecode), 3 networks (sync-status active) |
| **Test Suite Startup** | ~1s | Playwright launch + browser setup |

## Environment Hazards

### .env.local Override Issue

**Status:** ⚠️ KNOWN HAZARD — `.env.local.bak` (stale Kurtosis values)

The repository's `.env.local` file (now `.env.local.bak`) contains stale Kurtosis enclave variables that **will override exports** set for the devnet docker-compose tests if present. This file was moved aside during initial setup and must remain excluded:

```
.env.local.bak  # DO NOT USE — contains stale values like:
                # DEVNET_KURTOSIS_AVAILABLE_MEMORY_MB=...
                # DEVNET_KURTOSIS_CPU_ALLOCATION=...
```

**Resolution:** Keep `.env.local.bak` as-is (not `.env.local`), and ensure tests export E2E/NEXT_PUBLIC vars *before* running them. The `.env.example` template does not contain devnet values, so copying it to `.env.local` is safe and recommended for manual/local devnet runs.

## Config Files

- **Dev-UI Config:** `config/config.ci.devnet.json` (chains: DEVNET_L1, DEVNET_L2_001, DEVNET_L2_002)
- **Devnet Bundle:** `tests/devnet/docker-compose.yml`, `tests/devnet/summary.json`
- **Devnet Readiness Gate:** `scripts/devnetReady.mjs`

## References

- Kurtosis CDK Snapshot Docs: [Anvil-Flavor Devnet Snapshot](https://github.com/0xPolygon/kurtosis-cdk/blob/feat/aggkit-bridge-ui-backend/docs/docs/advanced/anvil-devnet-snapshot.md)
- Plan: `plans/dev-ui-ci-snapshot-plan.md`
- E2E Setup: `README.md` §Testing


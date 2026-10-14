#!/usr/bin/env node
// CI readiness gate for the vendored anvil devnet bundle (tests/devnet/,
// wired up by S13) -- and equally usable against any devnet exposing the
// same haproxy contract (e.g. a local Kurtosis `cdk` enclave with the
// bridge_ui haproxy on its default port).
//
// Usage:
//   node scripts/devnetReady.mjs [--base-url http://127.0.0.1:8555]
//                                 [--timeout-ms 120000] [--interval-ms 2000]
//
// Ports/routes are FIXED (no `kurtosis port print`, no `kurtosis enclave
// inspect` -- no Kurtosis CLI dependency at all), because this gate targets
// the CI-vendored docker-compose bundle (S13), whose haproxy is always
// published on a known host port, not a live enclave's ephemeral ports.
// scripts/kurtosisDevnetEnv.mjs remains the tool for the latter.
//
// Replicates the same three checks kurtosisDevnetEnv.mjs performs against a
// live enclave (chainId per route, bridge bytecode per chain, sync-status
// per network), upgraded to also assert `is_active` per the dev-ui contract
// table (plans/dev-ui-ci-snapshot-plan.md §1 "The contract the snapshot must
// satisfy") and preflight.spec.ts's assertSyncStatusOk -- `is_synced` alone
// is not sufficient; a network can be synced but not actively processing.
//
// Every check retries on failure until --timeout-ms elapses, because the
// services behind haproxy (aggkit, aggkit-proxy, the three anvils) can still
// be warming up for a few seconds after `docker compose up --wait` reports
// containers healthy (container healthy != aggkit fully synced). On timeout,
// prints one line per check with its last-seen failure so a human/CI log
// can tell "nothing is listening at all" apart from "L2-002 never
// synced" apart from "wrong bridge address" at a glance, then exits 1.

import { setTimeout as sleep } from 'node:timers/promises';

// kurtosis-cdk's fixed network_id convention (also asserted live by
// kurtosisDevnetEnv.mjs): L1 is always network_id 0; each L2's network_id is
// Number(deployment_suffix) (-001 -> 1, -002 -> 2).
const L1_NETWORK_ID = 0;

// Deterministic (CREATE2) bridge contract address, identical on every
// chain -- see the dev-ui contract table (plans/dev-ui-ci-snapshot-plan.md
// §1) and config.json's committed `appModes.configs.devnet.bridgeAddress`.
const BRIDGE_ADDRESS = '0xC8cbEBf950B9Df44d987c8619f092beA980fF038';

// One CORS-safe haproxy origin fronts every route below (contract table
// §1). `/aggkitapi` is shared by every network -- `?network_id=` on the
// request picks the network, not the host/path.
const ROUTES = [
  { path: '/l1rpc', label: 'L1', networkId: L1_NETWORK_ID, expectedChainId: 271828 },
  { path: '/l2rpc-001', label: 'L2-001', networkId: 1, expectedChainId: 20201 },
  { path: '/l2rpc-002', label: 'L2-002', networkId: 2, expectedChainId: 20202 }
];
const AGGKIT_API_PATH = '/aggkitapi';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8555';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 2_000;
// Per-attempt network timeout, independent of the overall retry deadline --
// bounds how long one hung fetch can block a single retry cycle, so a
// half-open connection can't itself eat the whole --timeout-ms budget in one
// attempt.
const REQUEST_TIMEOUT_MS = 5_000;

const parseArgs = (argv) => {
  let baseUrl = DEFAULT_BASE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let intervalMs = DEFAULT_INTERVAL_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url') {
      baseUrl = argv[++i];
    } else if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--timeout-ms=')) {
      timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
    } else if (arg === '--interval-ms') {
      intervalMs = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--interval-ms=')) {
      intervalMs = Number.parseInt(arg.slice('--interval-ms='.length), 10);
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/devnetReady.mjs [--base-url http://127.0.0.1:8555] ' +
          '[--timeout-ms 120000] [--interval-ms 2000]\n'
      );
      process.exit(0);
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (!baseUrl) throw new Error('--base-url requires a value');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('--interval-ms must be a positive integer');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), timeoutMs, intervalMs };
};

/** fetch with a per-attempt timeout, so one hung request can't itself consume the whole retry budget. */
const fetchWithTimeout = async (url, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const rpcCall = async (url, method, params = []) => {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!response.ok) {
    throw new Error(`RPC call ${method} to ${url} failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.error) {
    throw new Error(
      `RPC call ${method} to ${url} returned an error: ${JSON.stringify(body.error)}`
    );
  }
  return body.result;
};

/**
 * Retries `attempt()` until it resolves, or `timeoutMs` elapses, whichever
 * comes first. On timeout, throws the LAST error `attempt()` raised (so the
 * failure message reflects the current state of the world, not the first
 * transient hiccup) tagged with the check's own `label`.
 */
const retryUntilReady = async ({ label, timeoutMs, intervalMs, attempt }) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  // Always try at least once, even if timeoutMs is very small -- a
  // deliberately tiny --timeout-ms (e.g. for a fast-fail smoke check) should
  // still get one real attempt rather than failing on the clock alone.
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        throw new Error(
          `not ready after ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        );
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }
};

const assertChainIdMatches = async (rpcUrl, label, expectedChainId) => {
  const hex = await rpcCall(rpcUrl, 'eth_chainId');
  const chainId = Number.parseInt(hex, 16);
  if (chainId !== expectedChainId) {
    throw new Error(
      `${label} RPC ${rpcUrl} reports chainId ${chainId}, expected ${expectedChainId}`
    );
  }
};

const assertBridgeContractDeployed = async (rpcUrl, label) => {
  const code = await rpcCall(rpcUrl, 'eth_getCode', [BRIDGE_ADDRESS, 'latest']);
  if (!code || code === '0x') {
    throw new Error(
      `No bytecode found at bridge address ${BRIDGE_ADDRESS} on ${label} RPC ${rpcUrl}`
    );
  }
};

/**
 * `sync-status?network_id=N` must report BOTH sides synced AND active --
 * `is_synced` alone (the older kurtosisDevnetEnv.mjs check) misses a network
 * that caught up once but isn't actively processing. Mirrors
 * tests/e2e/preflight.spec.ts's assertSyncStatusOk exactly, since that's the
 * real gate this script exists to predict.
 */
const assertNetworkSynced = async (aggkitApiUrl, networkId, label) => {
  const url = `${aggkitApiUrl}/bridge/v1/sync-status?network_id=${networkId}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(
      `sync-status for ${label} (network_id=${networkId}) failed: HTTP ${response.status} at ${url}`
    );
  }
  const body = await response.json();
  const l1Ok = body?.l1_info?.is_synced === true && body?.l1_info?.is_active === true;
  const l2Ok = body?.l2_info?.is_synced === true && body?.l2_info?.is_active === true;
  if (!l1Ok || !l2Ok) {
    throw new Error(
      `sync-status for ${label} (network_id=${networkId}) not fully synced+active: ${JSON.stringify(body)}`
    );
  }
};

const main = async () => {
  const { baseUrl, timeoutMs, intervalMs } = parseArgs(process.argv.slice(2));
  const aggkitApiUrl = `${baseUrl}${AGGKIT_API_PATH}`;

  process.stdout.write(
    `Waiting for devnet readiness at ${baseUrl} (timeout ${timeoutMs}ms, poll every ${intervalMs}ms)...\n`
  );

  const checks = [];
  for (const route of ROUTES) {
    const rpcUrl = `${baseUrl}${route.path}`;
    checks.push({
      label: `${route.label} chainId`,
      run: () => assertChainIdMatches(rpcUrl, route.label, route.expectedChainId)
    });
    checks.push({
      label: `${route.label} bridge bytecode`,
      run: () => assertBridgeContractDeployed(rpcUrl, route.label)
    });
  }
  // network_id 0 (L1) is not itself a ROUTES entry. The aggkit-proxy DOES
  // read network_id -- routing per network is its whole job -- but in this
  // bundle its BridgeURLs map sends BOTH 0 and 1 to the same upstream
  // (aggkit-001, which now serves the bridge REST API as one of its
  // components), and each aggkit instance reports its own L1+L2 status
  // regardless. So this probe hits the same upstream as network_id=1 below;
  // its value is confirming the aggkit backing route 1 is reachable at all,
  // not that L1 has an independent syncer.
  checks.push({
    label: 'sync-status network_id=0 (L1)',
    run: () => assertNetworkSynced(aggkitApiUrl, 0, 'L1')
  });
  for (const route of ROUTES.filter((r) => r.networkId !== L1_NETWORK_ID)) {
    checks.push({
      label: `sync-status network_id=${route.networkId} (${route.label})`,
      run: () => assertNetworkSynced(aggkitApiUrl, route.networkId, route.label)
    });
  }

  const results = await Promise.allSettled(
    checks.map(({ label, run }) => retryUntilReady({ label, timeoutMs, intervalMs, attempt: run }))
  );

  const failures = results
    .map((result, index) => ({ result, label: checks[index].label }))
    .filter(({ result }) => result.status === 'rejected');

  if (failures.length > 0) {
    process.stderr.write(
      `\nDevnet not ready -- ${failures.length}/${checks.length} check(s) failed:\n`
    );
    for (const { label, result } of failures) {
      process.stderr.write(`  - ${label}: ${result.reason.message}\n`);
    }
    process.stderr.write(
      `\nIs the devnet compose bundle up (docker compose -f tests/devnet/docker-compose.yml up -d --wait)? ` +
        `Is haproxy actually published on ${baseUrl}? If ports differ, pass --base-url.\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nDevnet ready: all ${checks.length} checks passed against ${baseUrl}.\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

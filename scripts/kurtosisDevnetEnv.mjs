#!/usr/bin/env node
// Turns a running Kurtosis `cdk` enclave into a ready `.env.local` +
// `config.json` devnet config for this app, so `pnpm dev` shows the devnet
// chains and loads activity without any manual port copying.
//
// Usage:
//   node scripts/kurtosisDevnetEnv.mjs [--enclave cdk] [--l2-suffixes 001,002] [--proxy-service <name>]
//
// What it does:
//   1. Verifies the enclave exists (fails loudly otherwise), capturing the
//      `kurtosis enclave inspect` output once.
//   2. Discovers the enclave's topology from that single inspect output
//      instead of hardcoding service names -- the number of
//      L2s and the haproxy instance name both vary per bring-up:
//        - L2 deployment suffixes: unique `aggkit-<suffix>-bridge` matches.
//        - haproxy (browser entrypoint) service: the `agglayer-dev-ui-proxy-*`
//          match. Both are overridable via `--l2-suffixes`/`--proxy-service`
//          for enclaves discovery can't handle (e.g. two haproxy instances).
//   3. Resolves the haproxy port and, for L1 and every discovered L2 (via its
//      `/l1rpc` / `/l2rpc-<suffix>` haproxy route -- never the direct EL
//      service, which has no CORS and is what the browser actually uses):
//      reads `eth_chainId` (so chain ids are authoritative, not hardcoded --
//      the committed config.json previously carried a stale
//      `DEVNET_L2.id: 2151908`), checks the bridge contract has code
//      deployed, and verifies `sync-status?network_id=<N>` reports both
//      `is_synced` -- turning the "deployment_suffix -> networkId" naming
//      convention into a verified fact per run rather than an assumption.
//   4. Writes config.json's devnet chains (DEVNET_L1 / DEVNET_L2_<suffix> for
//      each discovered L2) + appModes.configs.devnet with the live values,
//      deleting any stale DEVNET_L2_* (or the legacy single-L2 DEVNET_L2) key
//      not written this run, then re-validates the whole file with the same
//      schema/validator the app uses at startup.
//   5. Writes .env.local with NEXT_PUBLIC_AGGKIT_BRIDGE_APIS (all networkIds
//      -> the live proxy URL), E2E_PRIVATE_KEY, and E2E_{FROM,TO}_CHAIN_ID /
//      E2E_L2_CHAIN_IDS, preserving any NEXT_PUBLIC_PROJECT_ID already
//      present.
//
// This script only supports Kurtosis-based devnets (matches this repo's
// `cdk` enclave shape). It does not touch mainnet/testnet mode config, and it
// never writes `autoclaim` (a top-level, mode-independent config.json key --
// a devnet script writing it would silently retune mainnet/testnet).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { parseConfigOrThrow } from '../config/configValidator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_JSON_PATH = path.join(REPO_ROOT, 'config.json');
const ENV_LOCAL_PATH = path.join(REPO_ROOT, '.env.local');

// kurtosis-cdk's fixed network_id convention: L1 is always network_id 0; each
// L2's network_id is `Number(deployment_suffix)` (`-001` -> 1, `-002` -> 2).
// This is a deployment parameter, not something re-derivable by querying a
// running service -- so it must be *verified*, not just assumed,
// which is what assertNetworkSynced does per discovered suffix below.
const L1_NETWORK_ID = 0;

// The bridge contract is deployed at a deterministic (CREATE2) address by
// kurtosis-cdk, identical on L1 and every L2 and stable across enclave
// recreates (verified live below via eth_getCode rather than trusted
// blindly, on every chain -- not just L1).
const BRIDGE_ADDRESS = '0xC8cbEBf950B9Df44d987c8619f092beA980fF038';

// Funded devnet key for E2E use, on EVERY chain -- not one key per chain.
// `l2_admin` is funded 100100 ETH on both L2-1 and L2-2 by the enclave
// bring-up, and per-chain nonce spaces mean the same key on two
// different chain ids cannot collide. Distinct per-chain protocol-role keys
// are deliberately NOT used here: overriding `l2_admin`/`l2_sequencer` per
// chain breaks rollup-2 creation (RollupManager admin role
// + CREATE2 bridge address).
const E2E_PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';

const PROXY_PORT_ID = 'http';

const parseArgs = (argv) => {
  let enclave = 'cdk';
  let l2SuffixesRaw;
  let proxyService;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--enclave') {
      enclave = argv[++i];
    } else if (arg.startsWith('--enclave=')) {
      enclave = arg.slice('--enclave='.length);
    } else if (arg === '--l2-suffixes') {
      l2SuffixesRaw = argv[++i];
    } else if (arg.startsWith('--l2-suffixes=')) {
      l2SuffixesRaw = arg.slice('--l2-suffixes='.length);
    } else if (arg === '--proxy-service') {
      proxyService = argv[++i];
    } else if (arg.startsWith('--proxy-service=')) {
      proxyService = arg.slice('--proxy-service='.length);
    }
  }
  if (!enclave) throw new Error('--enclave requires a value');

  const l2Suffixes = l2SuffixesRaw
    ? l2SuffixesRaw
        .split(',')
        .map((suffix) => suffix.trim())
        .filter(Boolean)
    : undefined;

  return { enclave, l2Suffixes, proxyService };
};

const runKurtosis = (args) => execFileSync('kurtosis', args, { encoding: 'utf8' }).trim();

/**
 * Verifies the enclave exists and returns the raw `kurtosis enclave inspect`
 * stdout, so discovery can regex the SAME output instead of making
 * separate calls per candidate service.
 */
const assertEnclaveExists = (enclave) => {
  try {
    return execFileSync('kurtosis', ['enclave', 'inspect', enclave], { encoding: 'utf8' });
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(
      `Kurtosis enclave "${enclave}" was not found (or the Kurtosis engine is unreachable).\n` +
        `Start it first (see the kurtosis-cdk guide docs/docs/advanced/aggkit-2l2-with-bridge-ui.md, 0xPolygon/kurtosis-cdk#929), or pass the correct name with --enclave.\n\n` +
        `Underlying error:\n${detail}`
    );
  }
};

/** Unique, sorted `aggkit-<suffix>-bridge` deployment suffixes. */
const discoverL2Suffixes = (inspectOutput) => {
  const suffixes = [
    ...new Set([...inspectOutput.matchAll(/\baggkit-(\d{3})-bridge\b/g)].map((match) => match[1]))
  ].sort();
  if (suffixes.length === 0) {
    throw new Error(
      `No "aggkit-<suffix>-bridge" services found in \`kurtosis enclave inspect\` output.\n` +
        `Is this a kurtosis-cdk aggkit bridge-UI enclave (params-aggkit-l2l2 args files)? Pass --l2-suffixes to override discovery.`
    );
  }
  return suffixes;
};

/** The haproxy browser entrypoint, discovered rather than hardcoded -- its numeric suffix depends on which bring-up run deployed bridge_ui. */
const discoverProxyService = (inspectOutput) => {
  const matches = [
    ...new Set(
      [...inspectOutput.matchAll(/\bagglayer-dev-ui-proxy-\d{3}\b/g)].map((match) => match[0])
    )
  ];
  if (matches.length === 0) {
    throw new Error(
      'No "agglayer-dev-ui-proxy-<suffix>" haproxy service found in `kurtosis enclave inspect` output.\n' +
        'Pass --proxy-service <name> to override discovery.'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple haproxy services found (${matches.join(', ')}); pass --proxy-service <name> to disambiguate.`
    );
  }
  return matches[0];
};

const normalizeUrl = (raw) =>
  raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;

const resolvePort = (enclave, service, portId) => {
  let raw;
  try {
    raw = runKurtosis(['port', 'print', enclave, service, portId]);
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(
      `Failed to resolve port "${portId}" on service "${service}" in enclave "${enclave}".\n` +
        `Is this the "aggkit" bridge_ui_backend enclave (params-aggkit-l2l2-run1/run2.yml)? ` +
        `A differently-shaped enclave will not have this service topology.\n\nUnderlying error:\n${detail}`
    );
  }
  return normalizeUrl(raw);
};

const rpcCall = async (url, method, params = []) => {
  const response = await fetch(url, {
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

const fetchChainId = async (rpcUrl) => {
  const hex = await rpcCall(rpcUrl, 'eth_chainId');
  return Number.parseInt(hex, 16);
};

/** Bridge-contract-deployed check, run on every chain (not just L1) -- the CREATE2 address is deterministic and identical on every chain. */
const assertBridgeContractDeployed = async (rpcUrl, chainLabel) => {
  const code = await rpcCall(rpcUrl, 'eth_getCode', [BRIDGE_ADDRESS, 'latest']);
  if (!code || code === '0x') {
    throw new Error(
      `No bytecode found at bridge address ${BRIDGE_ADDRESS} on ${chainLabel} RPC ${rpcUrl}. ` +
        `The enclave may not be fully initialized yet, or the bridge address changed.`
    );
  }
};

/**
 * Turns "networkId = Number(deployment_suffix)" from an
 * assumed convention into a verified fact per run, via the same
 * `sync-status?network_id=N` probe the SDK's aggregator/preflight use.
 * Fails loudly, naming the offending networkId, rather
 * than silently writing a config that would 404/502 for one network.
 */
const assertNetworkSynced = async (proxyBaseUrl, networkId, chainLabel) => {
  const url = `${proxyBaseUrl}/aggkitapi/bridge/v1/sync-status?network_id=${networkId}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `sync-status check for ${chainLabel} (network_id=${networkId}) failed: HTTP ${response.status} at ${url}`
    );
  }
  const body = await response.json();
  if (!body?.l1_info?.is_synced || !body?.l2_info?.is_synced) {
    throw new Error(
      `sync-status for ${chainLabel} (network_id=${networkId}) reports not fully synced: ${JSON.stringify(body)}. ` +
        `Either the enclave isn't ready yet, or "networkId = Number(deployment_suffix)" doesn't hold here.`
    );
  }
};

const upsertConfigJsonDevnet = async ({ l1RpcUrl, l1ChainId, l2Chains, aggkitBridgeApiUrl }) => {
  const raw = fs.readFileSync(CONFIG_JSON_PATH, 'utf8');
  const configJson = JSON.parse(raw);

  // Delete any chains.DEVNET_* key not written this run --
  // specifically the legacy single-L2 `DEVNET_L2` key and any
  // `DEVNET_L2_<suffix>` from a previous run whose suffix set has since
  // changed (e.g. a 3rd L2 removed) -- so a stale entry can never linger and
  // be referenced by a mode config.
  for (const chainKey of Object.keys(configJson.chains)) {
    if (chainKey === 'DEVNET_L2' || /^DEVNET_L2_\d+$/.test(chainKey)) {
      delete configJson.chains[chainKey];
    }
  }

  configJson.chains.DEVNET_L1 = {
    id: l1ChainId,
    name: 'Devnet L1',
    rpcUrl: l1RpcUrl,
    // No block explorer is deployed for this enclave (bridge_ui + bridge_spammer
    // only); kurtosis-cdk itself uses this same
    // placeholder for "no real explorer configured" (input_parser.star).
    explorerUrl: 'https://explorer.private/',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    iconUrl:
      'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    networkId: L1_NETWORK_ID,
    isTestnet: true,
    eta: 1
  };

  for (const l2 of l2Chains) {
    configJson.chains[l2.chainKey] = {
      id: l2.chainId,
      name: `Devnet L2-${l2.suffix}`,
      rpcUrl: l2.rpcUrl,
      explorerUrl: 'https://explorer.private/',
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      iconUrl:
        'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/katana.svg',
      networkId: l2.networkId,
      isTestnet: true,
      eta: 1
    };
  }

  configJson.appModes.configs.devnet = {
    label: 'Devnet',
    bridgeAddress: BRIDGE_ADDRESS,
    // All discovered networkIds -> the SAME proxy URL: one
    // multiplexing aggkit-proxy instance fronts every network, distinguished
    // by the `?network_id=` query param on each request, not by host.
    // Also kept in sync here as a fallback; NEXT_PUBLIC_AGGKIT_BRIDGE_APIS
    // (written to .env.local below) is the value that actually takes effect
    // at runtime per the S7 config design (env override merges over
    // config.json in app/config.ts).
    aggkitBridgeApis: Object.fromEntries(
      l2Chains.map((l2) => [String(l2.networkId), aggkitBridgeApiUrl])
    ),
    chainKeys: ['DEVNET_L1', ...l2Chains.map((l2) => l2.chainKey)],
    defaultFromChainKey: 'DEVNET_L1',
    // Always the lowest discovered suffix (l2Chains is sorted ascending).
    defaultToChainKey: l2Chains[0].chainKey
  };

  // Make devnet the default app mode locally so the wallet (Reown/wagmi) targets
  // the enclave chains instead of the committed default (testnet -> Sepolia). The
  // Reown appkit fixes its defaultNetwork from DEFAULT_APP_MODE at module load
  // (app/context/wallet.tsx), so without this a wallet connect tries to add
  // Sepolia. This mutation is local-only (this script is the devnet-prep tool);
  // the committed config.json keeps default: 'testnet' for production (S15).
  configJson.appModes.default = 'devnet';

  // Fail loudly before writing anything if this would produce an invalid
  // config.json (same schema + semantic validation the app runs at startup,
  // now including configValidator.mjs's chains<->aggkitBridgeApis cross-check).
  parseConfigOrThrow(configJson, { sourceName: 'config.json (kurtosisDevnetEnv.mjs preview)' });

  // Format through the repo's own prettier config (not a bare
  // JSON.stringify) so the script's output matches exactly what the
  // pre-commit hook's `prettier --write` would produce. Otherwise every run
  // reformats untouched objects/arrays (e.g. short `chainKeys` arrays
  // collapse under prettier's printWidth but not under JSON.stringify),
  // which would pollute `git diff config.json` with formatting noise beyond
  // the documented local-only mutations (S9 acceptance criterion).
  const prettierConfig = (await resolveConfig(CONFIG_JSON_PATH)) ?? {};
  const formatted = await format(JSON.stringify(configJson, null, 2), {
    ...prettierConfig,
    filepath: CONFIG_JSON_PATH
  });

  fs.writeFileSync(CONFIG_JSON_PATH, formatted);
};

const extractEnvValue = (envContent, key) => {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
};

const upsertEnvLocal = ({ l1ChainId, l2Chains, aggkitBridgeApiUrl }) => {
  const existing = fs.existsSync(ENV_LOCAL_PATH) ? fs.readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const existingProjectId = extractEnvValue(existing, 'NEXT_PUBLIC_PROJECT_ID');
  const projectId =
    existingProjectId && existingProjectId !== 'YOUR_PROJECT_ID_HERE'
      ? existingProjectId
      : 'YOUR_PROJECT_ID_HERE';

  const aggkitBridgeApis = JSON.stringify(
    Object.fromEntries(l2Chains.map((l2) => [String(l2.networkId), aggkitBridgeApiUrl]))
  );

  // These three make app/constants/e2e.ts's hardcoded
  // devnet fallbacks never actually decide anything against a live enclave.
  // E2E_TO_CHAIN_ID / the first entry of E2E_L2_CHAIN_IDS is always the
  // lowest discovered suffix (l2Chains is sorted ascending).
  const e2eFromChainId = l1ChainId;
  const e2eToChainId = l2Chains[0].chainId;
  const e2eL2ChainIds = l2Chains.map((l2) => l2.chainId).join(',');

  const lines = [
    '# Generated by scripts/kurtosisDevnetEnv.mjs -- re-run after every enclave recreate',
    '# (ports are ephemeral -- they change on every enclave recreate). Do not hand-edit the values below,',
    '# they will be overwritten on the next run.',
    '',
    projectId === 'YOUR_PROJECT_ID_HERE'
      ? '# TODO: set a real WalletConnect project id (https://cloud.reown.com) for wallet-connect features.'
      : '# NEXT_PUBLIC_PROJECT_ID preserved from existing .env.local',
    `NEXT_PUBLIC_PROJECT_ID=${projectId}`,
    '',
    '# Overrides config.json devnet.aggkitBridgeApis with the live enclave proxy URL',
    '# Keyed by L2 networkId; the SDK client appends /bridge/v1.',
    `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS=${aggkitBridgeApis}`,
    '',
    '# Funded devnet key (kurtosis-cdk l2_admin key, funded on every L2) for E2E use.',
    '# E2E only: Playwright reads this and injects the derived NEXT_PUBLIC_* values',
    '# automatically. Never set NEXT_PUBLIC_E2E_PRIVATE_KEY directly.',
    `E2E_PRIVATE_KEY=${E2E_PRIVATE_KEY}`,
    `E2E_FROM_CHAIN_ID=${e2eFromChainId}`,
    `E2E_TO_CHAIN_ID=${e2eToChainId}`,
    `E2E_L2_CHAIN_IDS=${e2eL2ChainIds}`,
    ''
  ];

  fs.writeFileSync(ENV_LOCAL_PATH, lines.join('\n'));
};

const main = async () => {
  const {
    enclave,
    l2Suffixes: l2SuffixesOverride,
    proxyService: proxyServiceOverride
  } = parseArgs(process.argv.slice(2));

  const inspectOutput = assertEnclaveExists(enclave);

  const l2Suffixes = l2SuffixesOverride ?? discoverL2Suffixes(inspectOutput);
  const proxyServiceName = proxyServiceOverride ?? discoverProxyService(inspectOutput);

  const proxyBaseUrl = resolvePort(enclave, proxyServiceName, PROXY_PORT_ID);
  // Every chain's RPC is read through its haproxy route, never a direct EL
  // service port: the browser/wallet needs CORS (direct geth/op-reth ports
  // have none), and reading through the SAME URL that ends up in config.json
  // makes this check authoritative for what the app will actually use,
  // rather than a separate direct-service probe that could pass while
  // haproxy itself is misconfigured.
  const l1RpcUrl = `${proxyBaseUrl}/l1rpc`;

  const l1ChainId = await fetchChainId(l1RpcUrl);
  await assertBridgeContractDeployed(l1RpcUrl, 'L1');
  await assertNetworkSynced(proxyBaseUrl, L1_NETWORK_ID, 'L1');

  const l2Chains = [];
  for (const suffix of l2Suffixes) {
    const networkId = Number.parseInt(suffix, 10);
    const rpcUrl = `${proxyBaseUrl}/l2rpc-${suffix}`;
    const chainLabel = `L2-${suffix}`;
    const chainId = await fetchChainId(rpcUrl);
    await assertBridgeContractDeployed(rpcUrl, chainLabel);
    await assertNetworkSynced(proxyBaseUrl, networkId, chainLabel);
    l2Chains.push({ suffix, networkId, chainKey: `DEVNET_L2_${suffix}`, chainId, rpcUrl });
  }

  const aggkitBridgeApiUrl = `${proxyBaseUrl}/aggkitapi`;

  await upsertConfigJsonDevnet({ l1RpcUrl, l1ChainId, l2Chains, aggkitBridgeApiUrl });
  upsertEnvLocal({ l1ChainId, l2Chains, aggkitBridgeApiUrl });

  process.stdout.write(
    [
      `Enclave: ${enclave}`,
      `Proxy service (browser entrypoint): ${proxyServiceName} -> ${proxyBaseUrl}`,
      `  -> NEXT_PUBLIC_AGGKIT_BRIDGE_APIS: all of {${l2Chains.map((l2) => l2.networkId).join(', ')}} -> ${aggkitBridgeApiUrl}`,
      `L1 (DEVNET_L1, networkId ${L1_NETWORK_ID}): ${l1RpcUrl} (chainId ${l1ChainId}; bridge deployed; sync-status OK)`,
      ...l2Chains.map(
        (l2) =>
          `L2-${l2.suffix} (${l2.chainKey}, networkId ${l2.networkId}): ${l2.rpcUrl} (chainId ${l2.chainId}; bridge deployed; sync-status OK)`
      ),
      `Bridge address: ${BRIDGE_ADDRESS} (verified: bytecode present on every chain)`,
      `Wrote: ${path.relative(REPO_ROOT, CONFIG_JSON_PATH)} (chains.DEVNET_L1/${l2Chains.map((l2) => l2.chainKey).join('/')}, appModes.configs.devnet)`,
      `Wrote: ${path.relative(REPO_ROOT, ENV_LOCAL_PATH)}`,
      '',
      'Run `pnpm dev` and open /transactions -- devnet is the default app mode.'
    ].join('\n') + '\n'
  );
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

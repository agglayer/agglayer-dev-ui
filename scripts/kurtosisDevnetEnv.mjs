#!/usr/bin/env node
// Turns a running Kurtosis `cdk` enclave into a ready `.env.local` +
// `config.json` devnet config for this app, so `pnpm dev` shows the devnet
// chains and loads activity without any manual port copying.
//
// Usage:
//   node scripts/kurtosisDevnetEnv.mjs [--enclave cdk]
//
// What it does:
//   1. Verifies the enclave exists (fails loudly otherwise).
//   2. Resolves the enclave's ephemeral ports via `kurtosis port print`:
//      - agglayer-dev-ui-proxy-001 (`http`)   -> CORS-safe browser entrypoint
//        for the aggkit bridge REST API (design.md S10). This is what
//        NEXT_PUBLIC_AGGKIT_BRIDGE_APIS must point at -- never the direct
//        aggkit REST port, which has no CORS headers.
//      - el-1-geth-lighthouse (`rpc`)          -> L1 EL RPC
//      - op-el-2-op-reth-op-node-001 (`rpc`)   -> L2 EL RPC (the sequencer
//        node the bridge-spammer also talks to; see enclave-notes.md)
//      - aggkit-001-bridge (`rest`)            -> resolved + health-checked
//        only for the console summary; the browser must never call it
//        directly (no CORS there).
//   3. Confirms the resolved endpoints are live: queries eth_chainId on the
//      L1/L2 RPCs (so chain ids are read from the chain, not hardcoded),
//      checks the L1 bridge contract has code deployed, and hits the
//      proxy's aggkit health endpoint.
//   4. Writes config.json's devnet chains (DEVNET_L1 / DEVNET_L2) +
//      appModes.configs.devnet with the live values, then re-validates the
//      whole file with the same schema/validator the app uses at startup.
//   5. Writes .env.local with NEXT_PUBLIC_AGGKIT_BRIDGE_APIS (the live
//      proxy URL) and E2E_PRIVATE_KEY (a pre-funded devnet key), preserving
//      any NEXT_PUBLIC_PROJECT_ID already present.
//
// This script only supports Kurtosis-based devnets (matches this repo's
// `cdk` enclave shape). It does not touch mainnet/testnet mode config.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfigOrThrow } from '../config/configValidator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_JSON_PATH = path.join(REPO_ROOT, 'config.json');
const ENV_LOCAL_PATH = path.join(REPO_ROOT, '.env.local');

// kurtosis-cdk's fixed network_id convention for a single-L2 devnet: L1 is
// always network_id 0, the (sole) L2 is network_id 1. Unlike ports/chain
// ids, this is a deployment parameter, not something re-derivable by
// querying a running service, so it is documented here rather than "live
// resolved" (see enclave-notes.md "Chain identifiers").
const L1_NETWORK_ID = 0;
const L2_NETWORK_ID = 1;

// The bridge contract is deployed at a deterministic (CREATE2) address by
// kurtosis-cdk, identical on L1 and L2 and stable across enclave recreates
// (verified live below via eth_getCode rather than trusted blindly).
const BRIDGE_ADDRESS = '0xC8cbEBf950B9Df44d987c8619f092beA980fF038';

// Funded devnet key for E2E use. Chosen over the bridge-spammer key: at
// script-authoring time the L2 admin key held ~999k ETH on L1 and ~99k ETH
// on L2, while the bridge-spammer key held zero on both (see feedback pack
// for the live balance check). Re-verify with `eth_getBalance` if funding
// patterns change in a future enclave image.
const E2E_PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';

const PROXY_SERVICE = 'agglayer-dev-ui-proxy-001';
const PROXY_PORT_ID = 'http';
const L1_EL_SERVICE = 'el-1-geth-lighthouse';
const L1_EL_PORT_ID = 'rpc';
const L2_EL_SERVICE = 'op-el-2-op-reth-op-node-001';
const L2_EL_PORT_ID = 'rpc';
const AGGKIT_REST_SERVICE = 'aggkit-001-bridge';
const AGGKIT_REST_PORT_ID = 'rest';

const parseArgs = (argv) => {
  let enclave = 'cdk';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--enclave') {
      enclave = argv[i + 1];
      i++;
    } else if (argv[i].startsWith('--enclave=')) {
      enclave = argv[i].slice('--enclave='.length);
    }
  }
  if (!enclave) throw new Error('--enclave requires a value');
  return { enclave };
};

const runKurtosis = (args) => execFileSync('kurtosis', args, { encoding: 'utf8' }).trim();

const assertEnclaveExists = (enclave) => {
  try {
    execFileSync('kurtosis', ['enclave', 'inspect', enclave], { encoding: 'utf8' });
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(
      `Kurtosis enclave "${enclave}" was not found (or the Kurtosis engine is unreachable).\n` +
        `Start it first (see enclave-notes.md), or pass the correct name with --enclave.\n\n` +
        `Underlying error:\n${detail}`
    );
  }
};

const normalizeUrl = (raw) => (raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`);

const resolvePort = (enclave, service, portId) => {
  let raw;
  try {
    raw = runKurtosis(['port', 'print', enclave, service, portId]);
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(
      `Failed to resolve port "${portId}" on service "${service}" in enclave "${enclave}".\n` +
        `Is this the "aggkit" bridge_ui_backend enclave (params-aggkit-ui.yml)? ` +
        `A "bridge_hub" enclave will not have this service topology.\n\nUnderlying error:\n${detail}`
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
    throw new Error(`RPC call ${method} to ${url} returned an error: ${JSON.stringify(body.error)}`);
  }
  return body.result;
};

const fetchChainId = async (rpcUrl) => {
  const hex = await rpcCall(rpcUrl, 'eth_chainId');
  return Number.parseInt(hex, 16);
};

const assertBridgeContractDeployed = async (l1RpcUrl) => {
  const code = await rpcCall(l1RpcUrl, 'eth_getCode', [BRIDGE_ADDRESS, 'latest']);
  if (!code || code === '0x') {
    throw new Error(
      `No bytecode found at bridge address ${BRIDGE_ADDRESS} on L1 RPC ${l1RpcUrl}. ` +
        `The enclave may not be fully initialized yet, or the bridge address changed.`
    );
  }
};

const checkAggkitHealthViaProxy = async (proxyBaseUrl) => {
  try {
    const response = await fetch(`${proxyBaseUrl}/aggkitapi/`);
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: undefined, body: String(error) };
  }
};

const upsertConfigJsonDevnet = ({ l1RpcUrl, l2RpcUrl, l1ChainId, l2ChainId, aggkitBridgeApiUrl }) => {
  const raw = fs.readFileSync(CONFIG_JSON_PATH, 'utf8');
  const configJson = JSON.parse(raw);

  configJson.chains.DEVNET_L1 = {
    id: l1ChainId,
    name: 'Devnet L1',
    rpcUrl: l1RpcUrl,
    // No block explorer is deployed for this enclave (bridge_ui + bridge_spammer
    // only, per enclave-notes.md); kurtosis-cdk itself uses this same
    // placeholder for "no real explorer configured" (input_parser.star).
    explorerUrl: 'https://explorer.private/',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    iconUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    networkId: L1_NETWORK_ID,
    isTestnet: true,
    eta: 1
  };

  configJson.chains.DEVNET_L2 = {
    id: l2ChainId,
    name: 'Devnet L2',
    rpcUrl: l2RpcUrl,
    explorerUrl: 'https://explorer.private/',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    iconUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/katana.svg',
    networkId: L2_NETWORK_ID,
    isTestnet: true,
    eta: 1
  };

  configJson.appModes.configs.devnet = {
    label: 'Devnet',
    bridgeAddress: BRIDGE_ADDRESS,
    // Also kept in sync here as a fallback; NEXT_PUBLIC_AGGKIT_BRIDGE_APIS
    // (written to .env.local below) is the value that actually takes effect
    // at runtime per the S7 config design (env override merges over
    // config.json in app/config.ts).
    aggkitBridgeApis: { [String(L2_NETWORK_ID)]: aggkitBridgeApiUrl },
    chainKeys: ['DEVNET_L1', 'DEVNET_L2'],
    defaultFromChainKey: 'DEVNET_L1',
    defaultToChainKey: 'DEVNET_L2'
  };

  // Make devnet the default app mode locally so the wallet (Reown/wagmi) targets
  // the enclave chains instead of the committed default (testnet -> Sepolia). The
  // Reown appkit fixes its defaultNetwork from DEFAULT_APP_MODE at module load
  // (app/context/wallet.tsx), so without this a wallet connect tries to add
  // Sepolia. This mutation is local-only (this script is the devnet-prep tool);
  // the committed config.json keeps default: 'testnet' for production (S15).
  configJson.appModes.default = 'devnet';

  // Fail loudly before writing anything if this would produce an invalid
  // config.json (same schema + semantic validation the app runs at startup).
  parseConfigOrThrow(configJson, { sourceName: 'config.json (kurtosisDevnetEnv.mjs preview)' });

  fs.writeFileSync(CONFIG_JSON_PATH, `${JSON.stringify(configJson, null, 2)}\n`);
};

const extractEnvValue = (envContent, key) => {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
};

const upsertEnvLocal = ({ aggkitBridgeApiUrl }) => {
  const existing = fs.existsSync(ENV_LOCAL_PATH) ? fs.readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const existingProjectId = extractEnvValue(existing, 'NEXT_PUBLIC_PROJECT_ID');
  const projectId =
    existingProjectId && existingProjectId !== 'YOUR_PROJECT_ID_HERE'
      ? existingProjectId
      : 'YOUR_PROJECT_ID_HERE';

  const aggkitBridgeApis = JSON.stringify({ [String(L2_NETWORK_ID)]: aggkitBridgeApiUrl });

  const lines = [
    '# Generated by scripts/kurtosisDevnetEnv.mjs -- re-run after every enclave recreate',
    '# (ports are ephemeral; see enclave-notes.md). Do not hand-edit the values below,',
    '# they will be overwritten on the next run.',
    '',
    projectId === 'YOUR_PROJECT_ID_HERE'
      ? '# TODO: set a real WalletConnect project id (https://cloud.reown.com) for wallet-connect features.'
      : '# NEXT_PUBLIC_PROJECT_ID preserved from existing .env.local',
    `NEXT_PUBLIC_PROJECT_ID=${projectId}`,
    '',
    '# Overrides config.json devnet.aggkitBridgeApis with the live enclave proxy URL',
    '# (design.md S6.2 / S7). Keyed by L2 networkId; client appends /bridge/v1.',
    `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS=${aggkitBridgeApis}`,
    '',
    '# Funded devnet key (kurtosis-cdk L2 admin key) for E2E use.',
    '# E2E only: Playwright reads this and injects the derived NEXT_PUBLIC_* values',
    '# automatically. Never set NEXT_PUBLIC_E2E_PRIVATE_KEY directly.',
    `E2E_PRIVATE_KEY=${E2E_PRIVATE_KEY}`,
    ''
  ];

  fs.writeFileSync(ENV_LOCAL_PATH, lines.join('\n'));
};

const main = async () => {
  const { enclave } = parseArgs(process.argv.slice(2));

  assertEnclaveExists(enclave);

  const proxyBaseUrl = resolvePort(enclave, PROXY_SERVICE, PROXY_PORT_ID);
  // Direct EL RPC ports: used only for this script's host-side validation
  // (chainId + bridge bytecode). The browser/wallet must NOT use these — geth/
  // op-reth send no CORS headers, so eth calls from the app/wallet fail. The
  // haproxy proxy (agglayer-dev-ui-proxy-001) exposes /l1rpc and /l2rpc with
  // `Access-Control-Allow-Origin: *`, so those are what we write into config.json.
  const l1RpcUrl = resolvePort(enclave, L1_EL_SERVICE, L1_EL_PORT_ID);
  const l2RpcUrl = resolvePort(enclave, L2_EL_SERVICE, L2_EL_PORT_ID);
  const aggkitRestUrl = resolvePort(enclave, AGGKIT_REST_SERVICE, AGGKIT_REST_PORT_ID);
  const aggkitBridgeApiUrl = `${proxyBaseUrl}/aggkitapi`;
  const l1RpcProxyUrl = `${proxyBaseUrl}/l1rpc`;
  const l2RpcProxyUrl = `${proxyBaseUrl}/l2rpc`;

  const [l1ChainId, l2ChainId] = await Promise.all([fetchChainId(l1RpcUrl), fetchChainId(l2RpcUrl)]);
  await assertBridgeContractDeployed(l1RpcUrl);
  const proxyHealth = await checkAggkitHealthViaProxy(proxyBaseUrl);

  upsertConfigJsonDevnet({
    l1RpcUrl: l1RpcProxyUrl,
    l2RpcUrl: l2RpcProxyUrl,
    l1ChainId,
    l2ChainId,
    aggkitBridgeApiUrl
  });
  upsertEnvLocal({ aggkitBridgeApiUrl });

  process.stdout.write(
    [
      `Enclave: ${enclave}`,
      `Proxy base (browser aggkit entrypoint): ${proxyBaseUrl}`,
      `  -> NEXT_PUBLIC_AGGKIT_BRIDGE_APIS["${L2_NETWORK_ID}"] = ${aggkitBridgeApiUrl}`,
      `  -> proxy aggkit health check: ${proxyHealth.ok ? 'OK' : `FAILED (${proxyHealth.status ?? 'no response'})`}`,
      `Direct aggkit REST (reference/health only, NOT used by the browser): ${aggkitRestUrl}`,
      `L1 RPC (DEVNET_L1, networkId ${L1_NETWORK_ID}): ${l1RpcProxyUrl} (chainId ${l1ChainId}; direct ${l1RpcUrl})`,
      `L2 RPC (DEVNET_L2, networkId ${L2_NETWORK_ID}): ${l2RpcProxyUrl} (chainId ${l2ChainId}; direct ${l2RpcUrl})`,
      `Bridge address: ${BRIDGE_ADDRESS} (verified: bytecode present on L1)`,
      `Wrote: ${path.relative(REPO_ROOT, CONFIG_JSON_PATH)} (chains.DEVNET_L1/DEVNET_L2, appModes.configs.devnet)`,
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

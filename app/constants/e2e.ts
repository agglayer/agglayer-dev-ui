import type { Address, Hex } from 'viem';

import { isHexPrivateKey, normalizeEnvValue } from '@/app/utils/e2eEnv';
import { privateKeyToAccount } from 'viem/accounts';

export const IS_E2E_ENABLED = process.env.NEXT_PUBLIC_E2E_ENABLED === 'true';

const resolvedPrivateKey = normalizeEnvValue(process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY);

if (IS_E2E_ENABLED && !isHexPrivateKey(resolvedPrivateKey)) {
  throw new Error(
    'E2E private key is invalid. NEXT_PUBLIC_E2E_PRIVATE_KEY must be a valid private key.'
  );
}

export const E2E_PRIVATE_KEY = IS_E2E_ENABLED ? (resolvedPrivateKey as Hex) : undefined;
export const E2E_WALLET_ADDRESS: Address | undefined = E2E_PRIVATE_KEY
  ? privateKeyToAccount(E2E_PRIVATE_KEY).address
  : undefined;

// E2E defaults to the local Kurtosis `cdk` enclave (aggkit backend) --
// scripts/kurtosisDevnetEnv.mjs resolves that enclave's live ports into
// config.json/.env.local, and manual full-journey validation against it
// documents the timings these constants are tuned against (see the E2E
// timeout comments further down). Set E2E_BACKEND_MODE=testnet to instead
// run against real Sepolia/Bokuto testnet infrastructure (the
// pre-aggkit-migration behavior) -- e.g. for a periodic canary run outside
// the devnet.
export type E2EBackendMode = 'devnet' | 'testnet';

const resolveBackendMode = (): E2EBackendMode =>
  normalizeEnvValue(process.env.E2E_BACKEND_MODE).toLowerCase() === 'testnet' ? 'testnet' : 'devnet';

export const E2E_BACKEND_MODE: E2EBackendMode = resolveBackendMode();

const parsePositiveInt = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Devnet L1 (config.json `chains.DEVNET_L1`, written by kurtosisDevnetEnv.mjs).
const DEVNET_FROM_CHAIN_ID = 271828;
// Sepolia -- only used as the testnet-mode default; irrelevant when
// E2E_BACKEND_MODE=devnet (the default).
const TESTNET_FROM_CHAIN_ID = 11155111;

export const E2E_FROM_CHAIN_ID = (() => {
  const envOverride = normalizeEnvValue(process.env.E2E_FROM_CHAIN_ID);
  if (envOverride) return parsePositiveInt(envOverride, DEVNET_FROM_CHAIN_ID);
  return E2E_BACKEND_MODE === 'testnet' ? TESTNET_FROM_CHAIN_ID : DEVNET_FROM_CHAIN_ID;
})();

// Sepolia USDC -- the one fixed, always-funded ERC20 available in testnet
// mode.
const TESTNET_ERC20_ADDRESS: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

// A devnet ERC20 deployed during S12 manual validation ("S12 Test Token" /
// S12T, 18 decimals, minted to the funded E2E wallet
// 0xE34aaF64b29273B7D567FCFc40544c014EEe9970) -- see manual-validation.md
// §5. Playwright's globalSetup (tests/e2e/globalSetup.ts) checks this
// address first (bytecode + balance still present) before deploying a fresh
// token, so repeat local runs against the same long-lived enclave don't
// redeploy every time. If the enclave was recreated since, the liveness
// check simply fails and globalSetup deploys a fresh one instead.
export const DEVNET_KNOWN_ERC20_CANDIDATE: Address = '0xE31D957c46DFFd0f6179c9DAb7779ccB725770ee';

// In devnet mode this resolves to `undefined` until Playwright's globalSetup
// sets process.env.E2E_ERC20_ADDRESS (before any spec file is loaded) --
// see tests/e2e/globalSetup.ts. Specs that need it must guard against
// `undefined` rather than assume it's always set at import time.
export const E2E_ERC20_ADDRESS: Address | undefined = (() => {
  const envOverride = normalizeEnvValue(process.env.E2E_ERC20_ADDRESS);
  if (envOverride) return envOverride as Address;
  return E2E_BACKEND_MODE === 'testnet' ? TESTNET_ERC20_ADDRESS : undefined;
})();

const DEFAULT_NATIVE_BRIDGE_AMOUNT = E2E_BACKEND_MODE === 'testnet' ? '0.00001' : '0.001';

export const E2E_NATIVE_BRIDGE_AMOUNT =
  normalizeEnvValue(process.env.E2E_NATIVE_BRIDGE_AMOUNT) || DEFAULT_NATIVE_BRIDGE_AMOUNT;
export const E2E_ERC20_BRIDGE_AMOUNT =
  normalizeEnvValue(process.env.E2E_ERC20_BRIDGE_AMOUNT) || '0.01';

// Timeouts tuned per backend. Devnet's ~1s block time and built-in aggkit
// autoclaim are both far faster than real Sepolia/Bokuto testnet
// infrastructure (manual-validation.md: deposit -> ready ~6-35s, ready ->
// claimed ~10-90s -- worst case budgeted below with margin).
const DEFAULT_BRIDGE_SUCCESS_TIMEOUT_MS = E2E_BACKEND_MODE === 'testnet' ? 120_000 : 60_000;
const DEFAULT_CLAIM_TIMEOUT_MS = E2E_BACKEND_MODE === 'testnet' ? 300_000 : 150_000;

export const E2E_BRIDGE_SUCCESS_TIMEOUT_MS = parsePositiveInt(
  normalizeEnvValue(process.env.E2E_BRIDGE_SUCCESS_TIMEOUT_MS),
  DEFAULT_BRIDGE_SUCCESS_TIMEOUT_MS
);
export const E2E_CLAIM_TIMEOUT_MS = parsePositiveInt(
  normalizeEnvValue(process.env.E2E_CLAIM_TIMEOUT_MS),
  DEFAULT_CLAIM_TIMEOUT_MS
);

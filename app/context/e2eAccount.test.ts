import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two well-known Hardhat/Anvil fixture private keys -- not secrets, just
// distinct valid 32-byte hex keys used to prove the module picks the
// *override* key over the *build-time* key when both are present.
const BUILD_TIME_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OVERRIDE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const ENV_KEYS = ['NEXT_PUBLIC_E2E_ENABLED', 'NEXT_PUBLIC_E2E_PRIVATE_KEY'] as const;
let savedEnv: Record<string, string | undefined> = {};

const setEnv = (enabled: boolean, buildKey: string | undefined) => {
  process.env.NEXT_PUBLIC_E2E_ENABLED = enabled ? 'true' : 'false';
  if (buildKey === undefined) {
    delete process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY;
  } else {
    process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY = buildKey;
  }
};

const setRuntimeOverride = (value: string | undefined) => {
  if (value === undefined) {
    delete (window as { __AGGLAYER_E2E_PRIVATE_KEY__?: string }).__AGGLAYER_E2E_PRIVATE_KEY__;
  } else {
    window.__AGGLAYER_E2E_PRIVATE_KEY__ = value;
  }
};

// Fresh module instances are required because IS_E2E_ENABLED/E2E_PRIVATE_KEY
// (app/constants/e2e.ts) and the account derivation in e2eAccount.ts both
// run at module-evaluation time, reading process.env/window once on import
// (same pattern as app/config.test.ts's "no module-scope config reads"
// guard). vi.resetModules() + a dynamic import isolates each case.
const importFreshE2eAccount = async () => {
  vi.resetModules();
  return import('@/app/context/e2eAccount');
};

describe('e2eAccount runtime private-key override', () => {
  beforeEach(() => {
    savedEnv = {};
    ENV_KEYS.forEach((key) => {
      savedEnv[key] = process.env[key];
    });
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    setRuntimeOverride(undefined);
  });

  it('uses the runtime override when it is valid and E2E is enabled', async () => {
    setEnv(true, BUILD_TIME_KEY);
    setRuntimeOverride(OVERRIDE_KEY);

    const { e2eLocalAccount, e2eWalletAddress } = await importFreshE2eAccount();

    const expectedOverrideAddress = privateKeyToAccount(OVERRIDE_KEY).address;
    const buildTimeAddress = privateKeyToAccount(BUILD_TIME_KEY).address;

    expect(e2eWalletAddress).toBe(expectedOverrideAddress);
    expect(e2eLocalAccount?.address).toBe(expectedOverrideAddress);
    expect(e2eWalletAddress).not.toBe(buildTimeAddress);
  });

  it('falls back to the build-time key when no runtime override is set', async () => {
    setEnv(true, BUILD_TIME_KEY);
    setRuntimeOverride(undefined);

    const { e2eWalletAddress } = await importFreshE2eAccount();

    expect(e2eWalletAddress).toBe(privateKeyToAccount(BUILD_TIME_KEY).address);
  });

  it('throws a clear error when the runtime override is set but invalid', async () => {
    setEnv(true, BUILD_TIME_KEY);
    setRuntimeOverride('not-a-private-key');

    await expect(importFreshE2eAccount()).rejects.toThrow(
      /window\.__AGGLAYER_E2E_PRIVATE_KEY__ is invalid/
    );
  });

  it('ignores the runtime override when E2E is disabled', async () => {
    setEnv(false, undefined);
    setRuntimeOverride(OVERRIDE_KEY);

    const { e2eLocalAccount, e2eWalletAddress } = await importFreshE2eAccount();

    expect(e2eLocalAccount).toBeUndefined();
    expect(e2eWalletAddress).toBeUndefined();
  });
});

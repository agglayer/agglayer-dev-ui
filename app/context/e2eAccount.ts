import type { Hex } from 'viem';

import { E2E_PRIVATE_KEY, IS_E2E_ENABLED } from '@/app/constants/e2e';
import { isHexPrivateKey, normalizeEnvValue } from '@/app/utils/e2eEnv';
import { privateKeyToAccount } from 'viem/accounts';

// Runtime escape hatch for E2E, checked in addition to the build-time
// NEXT_PUBLIC_E2E_PRIVATE_KEY (app/constants/e2e.ts). Playwright's
// `context.addInitScript` runs before any app script on the page, so it can
// set this on `window` ahead of the bundle evaluating this module -- letting
// a single E2E build serve many distinct signer keys (e.g. one per load-test
// browser worker, S10) without a rebuild per key. Only ever consulted when
// IS_E2E_ENABLED; production builds (IS_E2E_ENABLED === false) never read
// `window.__AGGLAYER_E2E_PRIVATE_KEY__` and are therefore unaffected.
declare global {
  interface Window {
    __AGGLAYER_E2E_PRIVATE_KEY__?: string;
  }
}

const resolveE2EPrivateKey = (): Hex | undefined => {
  if (!IS_E2E_ENABLED) return undefined;

  const runtimeOverride =
    typeof window !== 'undefined' ? normalizeEnvValue(window.__AGGLAYER_E2E_PRIVATE_KEY__) : '';

  if (runtimeOverride) {
    if (!isHexPrivateKey(runtimeOverride)) {
      throw new Error(
        'window.__AGGLAYER_E2E_PRIVATE_KEY__ is invalid. It must be a 0x-prefixed 32-byte hex private key.'
      );
    }
    return runtimeOverride;
  }

  return E2E_PRIVATE_KEY;
};

const resolvedE2EPrivateKey = resolveE2EPrivateKey();

const e2eLocalAccount = resolvedE2EPrivateKey
  ? privateKeyToAccount(resolvedE2EPrivateKey)
  : undefined;
const e2eWalletAddress = e2eLocalAccount?.address;

export { e2eLocalAccount, e2eWalletAddress };

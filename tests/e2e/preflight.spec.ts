import {
  E2E_BACKEND_MODE,
  E2E_FROM_CHAIN_ID,
  E2E_PRIVATE_KEY,
  E2E_WALLET_ADDRESS
} from '@/app/constants/e2e';
import { loadAppConfigForNode } from '@/tests/e2e/appConfig';
import { getE2EFromChain, getE2EFromChainRpcUrl } from '@/tests/e2e/chainRpc';
import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Like the other devnet-specific specs in this suite (tracker.spec.ts,
// console-hygiene.spec.ts, manual-claim.spec.ts, claim-autoclaim.spec.ts),
// this depends on a live Kurtosis `cdk` devnet enclave (or, in CI, the
// vendored devnet bundle): it hits aggkit's sync-status endpoint and checks
// the E2E wallet's on-chain balance against config.json's default app mode.
// Without this gate, a contributor who has switched to
// `E2E_BACKEND_MODE=testnet` (no local devnet running -- see README
// "Testing") would still have this spec try to reach devnet-only
// infrastructure and fail instead of skip.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'Preflight checks (aggkit sync-status, devnet wallet funding) are devnet-specific; see the comment above.'
);

// The active app mode's aggkitBridgeApis is the runtime map fanned out from
// config.json's aggkitProxy (any NEXT_PUBLIC_AGGKIT_PROXY env override
// already merged in -- see app/config.ts) -- reusing it here (rather than
// re-deriving it ourselves) keeps this preflight check pointed at exactly
// what the app itself will call. With the 2-L2 topology this has one entry
// per L2 networkId; devnet gives both the same aggkit-proxy URL, but each is
// iterated separately below so a single dead per-network backend behind the
// proxy is caught per-network rather than assumed identical.
const { appModeConfig, defaultAppMode } = loadAppConfigForNode();
const aggkitBridgeApiEntries = Object.entries(appModeConfig[defaultAppMode].aggkitBridgeApis);
if (aggkitBridgeApiEntries.length === 0) {
  throw new Error(
    `E2E preflight: no aggkit backend configured for app mode "${defaultAppMode}". ` +
      'Run scripts/kurtosisDevnetEnv.mjs (devnet mode) or set NEXT_PUBLIC_AGGKIT_PROXY.'
  );
}

type SyncStatusBody = {
  l1_info?: { is_synced?: boolean; is_active?: boolean };
  l2_info?: { is_synced?: boolean; is_active?: boolean };
};

const assertSyncStatusOk = (body: SyncStatusBody): void => {
  // The SDK's AggkitSyncStatus shape (aggkit types.go), verified live
  // against the devnet.
  expect(body.l1_info).toBeDefined();
  expect(body.l2_info).toBeDefined();
  expect(body.l1_info?.is_synced).toBe(true);
  expect(body.l1_info?.is_active).toBe(true);
  expect(body.l2_info?.is_synced).toBe(true);
  expect(body.l2_info?.is_active).toBe(true);
};

test.describe('preflight: funded wallet and RPC are reachable', () => {
  test('funded E2E wallet has a native balance on the configured "from" chain', async () => {
    expect(E2E_PRIVATE_KEY).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const client = createPublicClient({
      chain: getE2EFromChain(),
      transport: http(getE2EFromChainRpcUrl())
    });
    const chainId = await client.getChainId();
    const account = privateKeyToAccount(E2E_PRIVATE_KEY!);
    const expectedAddress = E2E_WALLET_ADDRESS!;

    expect(chainId).toBe(E2E_FROM_CHAIN_ID);
    expect(account.address.toLowerCase()).toBe(expectedAddress.toLowerCase());

    const nativeBalance = await client.getBalance({ address: account.address });
    expect(nativeBalance).toBeGreaterThan(BigInt(0));
  });
});

// Replaces the old direct-RPC-only preflight: the backend is now aggkit's
// bridge REST API (fronted by the Kurtosis enclave's CORS-safe proxy in
// devnet mode), not a Bridge Hub. A
// healthy RPC alone no longer implies the app can load activity; these
// checks confirm every configured aggkit network is reachable and synced.
//
// No standalone "health endpoint" check: `GET {baseUrl}/` 404s through
// aggkit-proxy (haproxy strips the `/aggkitapi` prefix and aggkit-proxy only
// registers `ANY /bridge/v1/*any` -- verified live against the devnet
// proxy). `sync-status?network_id=N` is the canonical per-network liveness
// probe instead.
test.describe('preflight: aggkit backend is reachable and synced', () => {
  for (const [networkIdString, baseUrl] of aggkitBridgeApiEntries) {
    test(`aggkit sync-status reports network ${networkIdString} synced and active`, async ({
      request
    }) => {
      const response = await request.get(
        `${baseUrl}/bridge/v1/sync-status?network_id=${networkIdString}`
      );
      expect(response.ok()).toBeTruthy();
      assertSyncStatusOk((await response.json()) as SyncStatusBody);
    });
  }

  // L1 (network_id 0) isn't itself a key of aggkitBridgeApis (that map is
  // keyed by L2 networkId) but is reachable through any of
  // the same URLs -- GetSyncStatusHandler never reads network_id, it always
  // reports its own instance's L1+L2 status. One check
  // suffices.
  test('aggkit sync-status reports network 0 (L1) synced and active', async ({ request }) => {
    const [, baseUrl] = aggkitBridgeApiEntries[0];
    const response = await request.get(`${baseUrl}/bridge/v1/sync-status?network_id=0`);
    expect(response.ok()).toBeTruthy();
    assertSyncStatusOk((await response.json()) as SyncStatusBody);
  });
});

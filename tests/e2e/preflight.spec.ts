import { APP_MODE_CONFIG, DEFAULT_APP_MODE } from '@/app/config';
import { E2E_FROM_CHAIN_ID, E2E_PRIVATE_KEY, E2E_WALLET_ADDRESS } from '@/app/constants/e2e';
import { getE2EFromChain, getE2EFromChainRpcUrl } from '@/tests/e2e/chainRpc';
import { expect, test } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// The active app mode's aggkitBridgeApis already has any
// NEXT_PUBLIC_AGGKIT_BRIDGE_APIS env override merged in (app/config.ts) --
// reusing it here (rather than re-parsing the raw env var ourselves) keeps
// this preflight check pointed at exactly what the app itself will call.
// With the 2-L2 topology this has one entry per L2 networkId (design.md
// §0.1/§1.1); devnet gives both the same aggkit-proxy URL, but each is
// iterated separately below so a single dead per-network backend behind the
// proxy is caught per-network rather than assumed identical.
const aggkitBridgeApiEntries = Object.entries(APP_MODE_CONFIG[DEFAULT_APP_MODE].aggkitBridgeApis);
if (aggkitBridgeApiEntries.length === 0) {
  throw new Error(
    `E2E preflight: no aggkitBridgeApis configured for app mode "${DEFAULT_APP_MODE}". ` +
      'Run scripts/kurtosisDevnetEnv.mjs (devnet mode) or set NEXT_PUBLIC_AGGKIT_BRIDGE_APIS.'
  );
}

type SyncStatusBody = {
  l1_info?: { is_synced?: boolean; is_active?: boolean };
  l2_info?: { is_synced?: boolean; is_active?: boolean };
};

const assertSyncStatusOk = (body: SyncStatusBody): void => {
  // design.md's AggkitSyncStatus shape (types.go:364); see also
  // enclave-notes.md's live acceptance snapshot for this exact endpoint.
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
// devnet mode -- design.md S10 / enclave-notes.md), not a Bridge Hub. A
// healthy RPC alone no longer implies the app can load activity; these
// checks confirm every configured aggkit network is reachable and synced.
//
// No standalone "health endpoint" check: `GET {baseUrl}/` 404s through
// aggkit-proxy (haproxy strips the `/aggkitapi` prefix and aggkit-proxy only
// registers `ANY /bridge/v1/*any` -- design.md §2.4 gap G3, verified live
// against the devnet proxy). `sync-status?network_id=N` is the canonical
// per-network liveness probe instead (design.md §2.3/§6.3).
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
  // keyed by L2 networkId, design.md §1.1) but is reachable through any of
  // the same URLs -- GetSyncStatusHandler never reads network_id, it always
  // reports its own instance's L1+L2 status (design.md §2.3). One check
  // suffices.
  test('aggkit sync-status reports network 0 (L1) synced and active', async ({ request }) => {
    const [, baseUrl] = aggkitBridgeApiEntries[0];
    const response = await request.get(`${baseUrl}/bridge/v1/sync-status?network_id=0`);
    expect(response.ok()).toBeTruthy();
    assertSyncStatusOk((await response.json()) as SyncStatusBody);
  });
});

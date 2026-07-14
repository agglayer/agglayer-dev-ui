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
const resolveAggkitBaseUrl = (): string => {
  const [, url] = Object.entries(APP_MODE_CONFIG[DEFAULT_APP_MODE].aggkitBridgeApis)[0] ?? [];
  if (!url) {
    throw new Error(
      `E2E preflight: no aggkitBridgeApis configured for app mode "${DEFAULT_APP_MODE}". ` +
        'Run scripts/kurtosisDevnetEnv.mjs (devnet mode) or set NEXT_PUBLIC_AGGKIT_BRIDGE_APIS.'
    );
  }
  return url;
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
// checks confirm the aggkit instance itself is reachable and synced.
test.describe('preflight: aggkit backend is reachable and synced', () => {
  test('aggkit health endpoint responds ok', async ({ request }) => {
    const baseUrl = resolveAggkitBaseUrl();
    const response = await request.get(`${baseUrl}/`);
    expect(response.ok()).toBeTruthy();
  });

  test('aggkit sync-status reports both networks synced and active', async ({ request }) => {
    const baseUrl = resolveAggkitBaseUrl();
    const response = await request.get(`${baseUrl}/bridge/v1/sync-status`);
    expect(response.ok()).toBeTruthy();

    const body = (await response.json()) as {
      l1_info?: { is_synced?: boolean; is_active?: boolean };
      l2_info?: { is_synced?: boolean; is_active?: boolean };
    };

    // design.md's AggkitSyncStatus shape (types.go:364); see also
    // enclave-notes.md's live acceptance snapshot for this exact endpoint.
    expect(body.l1_info).toBeDefined();
    expect(body.l2_info).toBeDefined();
    expect(body.l1_info?.is_synced).toBe(true);
    expect(body.l1_info?.is_active).toBe(true);
    expect(body.l2_info?.is_synced).toBe(true);
    expect(body.l2_info?.is_active).toBe(true);
  });
});

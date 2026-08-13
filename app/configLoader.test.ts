import type { JsonConfig } from '@/app/types/config';

import { APP_CONFIG_URL, fetchAppConfig } from '@/app/configLoader';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same fixture shape as config/configLoader.test.mjs and
// config/configValidator.test.mjs (design.md §4): a schema-valid,
// semantically-valid devnet config with three chains and one enabled mode.
const chain = (overrides: Partial<JsonConfig['chains'][string]> = {}) => ({
  id: 1,
  name: 'Chain',
  rpcUrl: 'https://rpc.example',
  explorerUrl: 'https://explorer.example',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  iconUrl: 'https://icon.example/icon.svg',
  networkId: 0,
  isTestnet: true,
  eta: 1,
  ...overrides
});

const buildConfig = (aggkitBridgeApis: Record<string, string>): JsonConfig =>
  ({
    externalLinks: { privacyPolicy: '', termsOfUse: '', contactSupport: '' },
    chains: {
      DEVNET_L1: chain({ id: 271828, name: 'Devnet L1', networkId: 0 }),
      DEVNET_L2_001: chain({ id: 20201, name: 'Devnet L2-001', networkId: 1 }),
      DEVNET_L2_002: chain({ id: 20202, name: 'Devnet L2-002', networkId: 2 })
    },
    appModes: {
      default: 'devnet',
      configs: {
        devnet: {
          label: 'Devnet',
          bridgeAddress: '0xC8cbEBf950B9Df44d987c8619f092beA980fF038',
          aggkitBridgeApis,
          chainKeys: ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'],
          defaultFromChainKey: 'DEVNET_L1',
          defaultToChainKey: 'DEVNET_L2_001'
        }
      }
    }
  }) as JsonConfig;

const mockFetchOnce = (impl: () => Promise<Partial<Response>> | Partial<Response>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => impl())
  );
};

const okResponse = (body: string): Partial<Response> => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: () => Promise.resolve(body)
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAppConfig — success (A-5 item 1)', () => {
  it('yields the expected, URL-normalized config from a valid served payload', async () => {
    const served = buildConfig({ 1: 'https://aggkit.example/1', 2: 'https://aggkit.example/2' });
    mockFetchOnce(() => okResponse(JSON.stringify(served)));

    const result = await fetchAppConfig({ origin: 'https://app.example' });

    expect(result.appModes.default).toBe('devnet');
    expect(Object.keys(result.chains)).toEqual(['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002']);
    expect(result.appModes.configs.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit.example/1',
      2: 'https://aggkit.example/2'
    });
    expect(fetch).toHaveBeenCalledWith(APP_CONFIG_URL, { cache: 'no-store' });
  });

  it('resolves a relative aggkitBridgeApis entry against the given origin (design.md §5)', async () => {
    const served = buildConfig({ 1: '/aggkitapi', 2: 'https://aggkit.example/2' });
    mockFetchOnce(() => okResponse(JSON.stringify(served)));

    const result = await fetchAppConfig({ origin: 'https://app.example' });

    // Non-null: normalizeConfigOrThrow always resolves aggkitBridgeApis to a
    // concrete (possibly empty) map, but the JsonAppModeConfig type keeps it
    // optional since the field may be absent on the mode's raw JSON shape.
    expect(result.appModes.configs.devnet.aggkitBridgeApis!['1']).toBe(
      'https://app.example/aggkitapi'
    );
  });

  it('defaults the origin to window.location.origin when none is passed', async () => {
    const served = buildConfig({ 1: '/aggkitapi', 2: 'https://aggkit.example/2' });
    mockFetchOnce(() => okResponse(JSON.stringify(served)));

    const result = await fetchAppConfig();

    expect(result.appModes.configs.devnet.aggkitBridgeApis!['1']).toBe(
      `${window.location.origin}/aggkitapi`
    );
  });
});

describe('fetchAppConfig — each failure mode surfaces a distinguishable error (A-5 item 2)', () => {
  it('HTTP 404: throws APP_CONFIG_FETCH_FAILED with the status', async () => {
    mockFetchOnce(() => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('')
    }));

    await expect(fetchAppConfig()).rejects.toThrow(
      /APP_CONFIG_FETCH_FAILED: GET \/config\.json returned 404 Not Found/
    );
  });

  it('non-JSON body: throws APP_CONFIG_INVALID naming the parse failure', async () => {
    mockFetchOnce(() => okResponse('not-json{'));

    await expect(fetchAppConfig()).rejects.toThrow(
      /APP_CONFIG_INVALID: \/config\.json is not valid JSON/
    );
  });

  it('schema violation: throws with the schema validation message', async () => {
    mockFetchOnce(() => okResponse(JSON.stringify({})));

    await expect(fetchAppConfig()).rejects.toThrow(/config\.json schema validation failed:/);
  });

  it('semantic violation: throws with the semantic validation message (reusing an E1 case)', async () => {
    // Missing aggkitBridgeApis entry for DEVNET_L2_002 (networkId 2) --
    // schema-valid, semantically invalid.
    const served = buildConfig({ 1: 'https://aggkit.example/1' });
    mockFetchOnce(() => okResponse(JSON.stringify(served)));

    await expect(fetchAppConfig()).rejects.toThrow(
      /config\.json semantic validation failed:\n- appModes\.configs\.devnet\.aggkitBridgeApis: missing entry for chain "DEVNET_L2_002" \(networkId 2\)/
    );
  });

  it('network error: throws APP_CONFIG_FETCH_FAILED naming the cause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );

    await expect(fetchAppConfig()).rejects.toThrow(
      /APP_CONFIG_FETCH_FAILED: GET \/config\.json failed: connection refused/
    );
  });
});

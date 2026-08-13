import type { JsonConfig } from '@/app/types/config';

import {
  buildAppConfig,
  getAppConfig,
  getExternalLinks,
  initAppConfig,
  isAppConfigReady,
  resetAppConfig
} from '@/app/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same fixture shape as config/configLoader.test.mjs / configValidator.test.mjs
// (design.md §4/§7): a schema-valid, semantically-valid devnet config with
// three chains (one L1, two L2) and one enabled mode. buildAppConfig assumes
// its input is already schema-valid AND URL-normalized (that happens upstream
// in the loaders under test in configLoader.test.mjs/ts), so every URL here
// is absolute.
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

const buildConfigJson = (): JsonConfig =>
  ({
    externalLinks: {
      privacyPolicy: 'https://privacy.example',
      termsOfUse: 'https://terms.example',
      contactSupport: 'https://support.example'
    },
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
          aggkitBridgeApis: {
            1: 'https://aggkit-1.example/aggkitapi',
            2: 'https://aggkit-2.example/aggkitapi'
          },
          chainKeys: ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'],
          defaultFromChainKey: 'DEVNET_L1',
          defaultToChainKey: 'DEVNET_L2_001'
        }
      }
    }
  }) as JsonConfig;

describe('buildAppConfig — loader success (A-5 item 1)', () => {
  it('derives the expected chain registry and mode configs from a valid config', () => {
    const resolved = buildAppConfig(buildConfigJson());

    expect(resolved.defaultAppMode).toBe('devnet');
    expect(Object.keys(resolved.chainRegistry).sort()).toEqual(
      ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'].sort()
    );
    expect(resolved.chainRegistry.DEVNET_L1.app.id).toBe(271828);
    expect(resolved.chainRegistry.DEVNET_L2_001.app.networkId).toBe(1);

    expect(resolved.appModeConfig.devnet.label).toBe('Devnet');
    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit-1.example/aggkitapi',
      2: 'https://aggkit-2.example/aggkitapi'
    });
    expect(resolved.appModeConfig.devnet.chains).toHaveLength(3);

    // mainnet/testnet have no config.json entry -> disabled, empty shape.
    expect(resolved.appModeConfig.mainnet.chains).toEqual([]);
    expect(resolved.appModeConfig.testnet.chains).toEqual([]);

    expect(resolved.allWagmiChains).toHaveLength(3);
    // defaultFromChainKey: 'DEVNET_L1' -> that chain's wagmi id.
    expect(resolved.defaultWagmiChain.id).toBe(271828);

    expect(resolved.externalLinks).toEqual({
      PRIVACY_POLICY: 'https://privacy.example',
      TERMS_OF_USE: 'https://terms.example',
      CONTACT_SUPPORT: 'https://support.example'
    });
  });
});

describe('buildAppConfig — env override precedence (A-1 §6, A-5 item 4)', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS;
  });

  it('shallow-merges NEXT_PUBLIC_AGGKIT_BRIDGE_APIS over the served config, per network id', () => {
    process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS = JSON.stringify({
      1: 'https://override.example/aggkitapi'
    });

    const resolved = buildAppConfig(buildConfigJson());

    // networkId 1 is overridden...
    expect(resolved.appModeConfig.devnet.aggkitBridgeApis[1]).toBe(
      'https://override.example/aggkitapi'
    );
    // ...but networkId 2, absent from the override, keeps the served value --
    // proving this is a shallow merge, not a full replace of the mode's map.
    expect(resolved.appModeConfig.devnet.aggkitBridgeApis[2]).toBe(
      'https://aggkit-2.example/aggkitapi'
    );
  });

  it('falls back entirely to the served config when no override is set', () => {
    const resolved = buildAppConfig(buildConfigJson());

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit-1.example/aggkitapi',
      2: 'https://aggkit-2.example/aggkitapi'
    });
  });

  it('throws APP_CONFIG_INVALID for a malformed override rather than silently ignoring it', () => {
    process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS = 'not-json';

    expect(() => buildAppConfig(buildConfigJson())).toThrow(
      /APP_CONFIG_INVALID: NEXT_PUBLIC_AGGKIT_BRIDGE_APIS must be valid JSON/
    );
  });
});

// Same fixture as buildConfigJson(), but devnet uses the single-proxy
// aggkitProxy field instead of a per-network aggkitBridgeApis map -- the
// shape devnet's real config.json now uses (see docs/config.md).
const buildConfigJsonWithProxy = (aggkitProxy: string): JsonConfig => {
  const config = buildConfigJson();
  delete (config.appModes.configs.devnet as { aggkitBridgeApis?: unknown }).aggkitBridgeApis;
  (config.appModes.configs.devnet as { aggkitProxy?: string }).aggkitProxy = aggkitProxy;
  return config;
};

describe('buildAppConfig — aggkitProxy fan-out (D0b)', () => {
  it('fans a single aggkitProxy value out to every non-L1 chain networkId in the mode', () => {
    const resolved = buildAppConfig(
      buildConfigJsonWithProxy('https://aggkit-proxy.example/aggkitapi')
    );

    // Same resolved Record<number, string> shape as the map form -- every
    // downstream consumer (AggkitBridgeAggregator, app/utils/appMode.ts) is
    // unaffected by which config.json form produced it.
    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit-proxy.example/aggkitapi',
      2: 'https://aggkit-proxy.example/aggkitapi'
    });
  });

  it('never fans the proxy value out under the L1 networkId (0)', () => {
    const resolved = buildAppConfig(
      buildConfigJsonWithProxy('https://aggkit-proxy.example/aggkitapi')
    );

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis[0]).toBeUndefined();
  });
});

describe('buildAppConfig — NEXT_PUBLIC_AGGKIT_PROXY override precedence (D0b)', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_AGGKIT_PROXY;
  });

  it('overrides every non-L1 networkId with the single override URL', () => {
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'https://override.example/aggkitapi';

    const resolved = buildAppConfig(
      buildConfigJsonWithProxy('https://aggkit-proxy.example/aggkitapi')
    );

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://override.example/aggkitapi',
      2: 'https://override.example/aggkitapi'
    });
  });

  it('falls back to the served aggkitProxy value when no override is set', () => {
    const resolved = buildAppConfig(
      buildConfigJsonWithProxy('https://aggkit-proxy.example/aggkitapi')
    );

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit-proxy.example/aggkitapi',
      2: 'https://aggkit-proxy.example/aggkitapi'
    });
  });

  it('throws APP_CONFIG_INVALID for a malformed override (not an absolute URL or relative path)', () => {
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'not a url';

    expect(() =>
      buildAppConfig(buildConfigJsonWithProxy('https://aggkit-proxy.example/aggkitapi'))
    ).toThrow(/APP_CONFIG_INVALID: NEXT_PUBLIC_AGGKIT_PROXY must be an absolute http\(s\) URL/);
  });

  it('applies identically to a map-form mode too (same "applied to every mode" precedent as NEXT_PUBLIC_AGGKIT_BRIDGE_APIS)', () => {
    // Mirrors docs/config.md's documented behavior for the pre-existing
    // NEXT_PUBLIC_AGGKIT_BRIDGE_APIS override: a build-time global override is
    // applied identically to every app mode, not scoped to modes that happen
    // to declare the matching field in config.json. An operator who sets this
    // is choosing to fan one proxy URL across every non-L1 network,
    // regardless of what config.json's own per-mode form is.
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'https://override.example/aggkitapi';

    const resolved = buildAppConfig(buildConfigJson());

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://override.example/aggkitapi',
      2: 'https://override.example/aggkitapi'
    });
  });

  it('NEXT_PUBLIC_AGGKIT_BRIDGE_APIS still wins per-key when both overrides are set, since the map override merges on top', () => {
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'https://proxy-override.example/aggkitapi';
    process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS = JSON.stringify({
      1: 'https://map-override.example/1'
    });

    const resolved = buildAppConfig(
      buildConfigJsonWithProxy('https://aggkit-proxy.example/aggkitapi')
    );

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://map-override.example/1',
      2: 'https://proxy-override.example/aggkitapi'
    });

    delete process.env.NEXT_PUBLIC_AGGKIT_BRIDGE_APIS;
  });
});

describe('the module store', () => {
  beforeEach(() => {
    resetAppConfig();
  });

  it('is unready before initAppConfig and ready after', () => {
    expect(isAppConfigReady()).toBe(false);
    initAppConfig(buildConfigJson());
    expect(isAppConfigReady()).toBe(true);
  });

  it('serves accessors from the config passed to initAppConfig', () => {
    initAppConfig(buildConfigJson());
    expect(getExternalLinks().CONTACT_SUPPORT).toBe('https://support.example');
    expect(getAppConfig().defaultAppMode).toBe('devnet');
  });

  it('resetAppConfig clears the store back to not-loaded', () => {
    initAppConfig(buildConfigJson());
    resetAppConfig();
    expect(isAppConfigReady()).toBe(false);
    expect(() => getAppConfig()).toThrow(/APP_CONFIG_NOT_LOADED/);
  });
});

// A-5 item 6: importing app/config.ts must never throw at module-evaluation
// time, even though every accessor now depends on AppConfigGate having run
// first. Each test here works on a *fresh* module instance
// (vi.resetModules + a dynamic import) so it is independent of whatever the
// describe blocks above have already done to the shared singleton.
describe('regression guard: no module-scope config reads (A-5 item 6)', () => {
  it('importing the module with no served config does not throw', async () => {
    vi.resetModules();
    await expect(import('@/app/config')).resolves.toBeDefined();
  });

  it('calling an accessor before init throws the documented APP_CONFIG_NOT_LOADED error', async () => {
    vi.resetModules();
    const freshConfigModule = await import('@/app/config');

    expect(freshConfigModule.isAppConfigReady()).toBe(false);
    expect(() => freshConfigModule.getAppConfig()).toThrow(
      /APP_CONFIG_NOT_LOADED: app config was read before AppConfigGate resolved it/
    );
    expect(() => freshConfigModule.getExternalLinks()).toThrow(/APP_CONFIG_NOT_LOADED/);
    expect(() => freshConfigModule.getAppModeConfig()).toThrow(/APP_CONFIG_NOT_LOADED/);
    expect(() => freshConfigModule.getDefaultAppMode()).toThrow(/APP_CONFIG_NOT_LOADED/);
    expect(() => freshConfigModule.getAllWagmiChains()).toThrow(/APP_CONFIG_NOT_LOADED/);
    expect(() => freshConfigModule.getDefaultWagmiChain()).toThrow(/APP_CONFIG_NOT_LOADED/);
  });

  it('a fresh module becomes ready once initAppConfig is called on it', async () => {
    vi.resetModules();
    const freshConfigModule = await import('@/app/config');

    freshConfigModule.initAppConfig(buildConfigJson());

    expect(freshConfigModule.isAppConfigReady()).toBe(true);
    expect(() => freshConfigModule.getAppConfig()).not.toThrow();
  });
});

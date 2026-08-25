import type { AppChain } from '@/app/types/appMode';
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
// three chains (one L1, two L2) and one enabled mode, using the single
// aggkitProxy field -- the only aggkit backend field the schema supports
// (the per-network aggkitBridgeApis map has been removed; see
// config/configSchema.mjs). buildAppConfig assumes its input is already
// schema-valid AND URL-normalized (that happens upstream in the loaders under
// test in configLoader.test.mjs/ts), so every URL here is absolute.
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

// `aggkitProxy: null` means "omit the field entirely" (the "not yet
// configured" escape hatch) -- distinct from an ordinary omitted argument,
// which defaults to a concrete proxy URL below.
const buildConfigJson = (
  aggkitProxy: string | null = 'https://aggkit-proxy.example/aggkitapi',
  projectId = 'served-project-id'
): JsonConfig =>
  ({
    walletConnect: { projectId },
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
          ...(aggkitProxy === null ? {} : { aggkitProxy }),
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

describe('buildAppConfig — aggkitProxy fan-out', () => {
  it('fans a single aggkitProxy value out to every non-L1 chain networkId in the mode', () => {
    const resolved = buildAppConfig(buildConfigJson('https://aggkit-proxy.example/aggkitapi'));

    // Every downstream consumer (AggkitBridgeAggregator,
    // app/utils/appMode.ts) reads this same resolved Record<number, string>
    // shape regardless of config.json only ever declaring one URL.
    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit-proxy.example/aggkitapi',
      2: 'https://aggkit-proxy.example/aggkitapi'
    });
  });

  it('never fans the proxy value out under the L1 networkId (0)', () => {
    const resolved = buildAppConfig(buildConfigJson('https://aggkit-proxy.example/aggkitapi'));

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis[0]).toBeUndefined();
  });

  it('resolves to an empty map when the mode has no aggkitProxy configured', () => {
    const resolved = buildAppConfig(buildConfigJson(null));

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({});
  });
});

describe('buildAppConfig — per-chain bridgeAddress override', () => {
  it("falls back to the mode's bridgeAddress when a chain has no override", () => {
    const resolved = buildAppConfig(buildConfigJson());

    const [devnetL1, devnetL2001] = resolved.appModeConfig.devnet.chains as [AppChain, AppChain];
    expect(devnetL1.bridgeAddress).toBe('0xC8cbEBf950B9Df44d987c8619f092beA980fF038');
    expect(devnetL2001.bridgeAddress).toBe('0xC8cbEBf950B9Df44d987c8619f092beA980fF038');
  });

  it("a chain's own bridgeAddress wins over the mode's default", () => {
    const configJson = buildConfigJson();
    configJson.chains.DEVNET_L2_001 = chain({
      id: 20201,
      name: 'Devnet L2-001',
      networkId: 1,
      bridgeAddress: '0x000000000000000000000000000000000000dd'
    });

    const resolved = buildAppConfig(configJson);

    const [devnetL1, devnetL2001, devnetL2002] = resolved.appModeConfig.devnet.chains as [
      AppChain,
      AppChain,
      AppChain
    ];
    expect(devnetL1.bridgeAddress).toBe('0xC8cbEBf950B9Df44d987c8619f092beA980fF038');
    expect(devnetL2001.bridgeAddress).toBe('0x000000000000000000000000000000000000dd');
    expect(devnetL2002.bridgeAddress).toBe('0xC8cbEBf950B9Df44d987c8619f092beA980fF038');
  });

  it("does not leak one mode's bridgeAddress default onto a chain shared by another mode", () => {
    const configJson = buildConfigJson();
    configJson.appModes.configs.testnet = {
      label: 'Testnet',
      bridgeAddress: '0x1111111111111111111111111111111111111a',
      chainKeys: ['DEVNET_L1', 'DEVNET_L2_001']
    };

    const resolved = buildAppConfig(configJson);

    const [devnetL1] = resolved.appModeConfig.devnet.chains as [AppChain, ...AppChain[]];
    const [testnetL1] = resolved.appModeConfig.testnet.chains as [AppChain, ...AppChain[]];
    expect(devnetL1.bridgeAddress).toBe('0xC8cbEBf950B9Df44d987c8619f092beA980fF038');
    expect(testnetL1.bridgeAddress).toBe('0x1111111111111111111111111111111111111a');
  });
});

describe('buildAppConfig — chains.<key>.currency.address (native-currency address override)', () => {
  it('defaults nativeCurrency.address to the zero address when currency.address is omitted', () => {
    const resolved = buildAppConfig(buildConfigJson());

    const [devnetL1] = resolved.appModeConfig.devnet.chains as [AppChain, ...AppChain[]];
    expect(devnetL1.nativeCurrency.address).toBe('0x0000000000000000000000000000000000000000');
  });

  it("a chain's own currency.address wins when set", () => {
    const configJson = buildConfigJson();
    configJson.chains.DEVNET_L1 = chain({
      id: 271828,
      name: 'Devnet L1',
      networkId: 0,
      currency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        address: '0x0000003f0000003F0000003F0000003f0000003f'
      }
    });

    const resolved = buildAppConfig(configJson);

    const [devnetL1, devnetL2001] = resolved.appModeConfig.devnet.chains as [AppChain, AppChain];
    expect(devnetL1.nativeCurrency.address).toBe('0x0000003f0000003F0000003F0000003f0000003f');
    expect(devnetL2001.nativeCurrency.address).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('buildAppConfig — chains.<key>.currency.wethToken (displayed-balance override)', () => {
  it('defaults nativeCurrency.wethToken to the zero address when currency.wethToken is omitted', () => {
    const resolved = buildAppConfig(buildConfigJson());

    const [devnetL1] = resolved.appModeConfig.devnet.chains as [AppChain, ...AppChain[]];
    expect(devnetL1.nativeCurrency.wethToken).toBe('0x0000000000000000000000000000000000000000');
  });

  it("a chain's own currency.wethToken wins when set, independent of currency.address", () => {
    const configJson = buildConfigJson();
    configJson.chains.DEVNET_L1 = chain({
      id: 271828,
      name: 'Devnet L1',
      networkId: 0,
      currency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        wethToken: '0x0000003f0000003F0000003F0000003f0000003f'
      }
    });

    const resolved = buildAppConfig(configJson);

    const [devnetL1, devnetL2001] = resolved.appModeConfig.devnet.chains as [AppChain, AppChain];
    expect(devnetL1.nativeCurrency.wethToken).toBe('0x0000003f0000003F0000003F0000003f0000003f');
    expect(devnetL1.nativeCurrency.address).toBe('0x0000000000000000000000000000000000000000');
    expect(devnetL2001.nativeCurrency.wethToken).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('buildAppConfig — chains.<key>.nativeBridgeURL (native-bridge advisory)', () => {
  it('is undefined when nativeBridgeURL is omitted', () => {
    const resolved = buildAppConfig(buildConfigJson());

    const [devnetL1] = resolved.appModeConfig.devnet.chains as [AppChain, ...AppChain[]];
    expect(devnetL1.nativeBridgeURL).toBeUndefined();
  });

  it("carries a chain's own nativeBridgeURL through verbatim", () => {
    const configJson = buildConfigJson();
    configJson.chains.DEVNET_L2_001 = chain({
      id: 20201,
      name: 'Devnet L2-001',
      networkId: 1,
      nativeBridgeURL: 'https://bridge.example.com'
    });

    const resolved = buildAppConfig(configJson);

    const [devnetL1, devnetL2001] = resolved.appModeConfig.devnet.chains as [AppChain, AppChain];
    expect(devnetL2001.nativeBridgeURL).toBe('https://bridge.example.com');
    expect(devnetL1.nativeBridgeURL).toBeUndefined();
  });
});

describe('buildAppConfig — NEXT_PUBLIC_AGGKIT_PROXY override precedence', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_AGGKIT_PROXY;
  });

  it('overrides every non-L1 networkId with the single override URL', () => {
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'https://override.example/aggkitapi';

    const resolved = buildAppConfig(buildConfigJson('https://aggkit-proxy.example/aggkitapi'));

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://override.example/aggkitapi',
      2: 'https://override.example/aggkitapi'
    });
  });

  it('falls back to the served aggkitProxy value when no override is set', () => {
    const resolved = buildAppConfig(buildConfigJson('https://aggkit-proxy.example/aggkitapi'));

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://aggkit-proxy.example/aggkitapi',
      2: 'https://aggkit-proxy.example/aggkitapi'
    });
  });

  it('applies even when the served config has no aggkitProxy of its own', () => {
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'https://override.example/aggkitapi';

    const resolved = buildAppConfig(buildConfigJson(null));

    expect(resolved.appModeConfig.devnet.aggkitBridgeApis).toEqual({
      1: 'https://override.example/aggkitapi',
      2: 'https://override.example/aggkitapi'
    });
  });

  it('throws APP_CONFIG_INVALID for a malformed override (not an absolute URL or relative path)', () => {
    process.env.NEXT_PUBLIC_AGGKIT_PROXY = 'not a url';

    expect(() => buildAppConfig(buildConfigJson('https://aggkit-proxy.example/aggkitapi'))).toThrow(
      /APP_CONFIG_INVALID: NEXT_PUBLIC_AGGKIT_PROXY must be an absolute http\(s\) URL/
    );
  });
});

// D0e: walletConnect.projectId is the runtime-configurable source (settable
// in a mounted config.json with no rebuild -- see entrypoint.sh/docs/docker.md);
// NEXT_PUBLIC_PROJECT_ID, when set, overrides it -- the same precedence rule
// already established for NEXT_PUBLIC_AGGKIT_PROXY above, kept only as a
// local-dev/Playwright convenience (see app/config.ts's
// resolveProjectIdOverride).
describe('buildAppConfig — walletConnect.projectId resolution', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_PROJECT_ID;
  });

  it('resolves to the served config value when no env override is set', () => {
    const resolved = buildAppConfig(buildConfigJson(undefined, 'served-project-id'));

    expect(resolved.walletConnect.projectId).toBe('served-project-id');
  });

  it('NEXT_PUBLIC_PROJECT_ID overrides the served config value when set', () => {
    process.env.NEXT_PUBLIC_PROJECT_ID = 'env-override-project-id';

    const resolved = buildAppConfig(buildConfigJson(undefined, 'served-project-id'));

    expect(resolved.walletConnect.projectId).toBe('env-override-project-id');
  });

  it('an empty/whitespace-only env override is ignored, falling back to the served value', () => {
    process.env.NEXT_PUBLIC_PROJECT_ID = '   ';

    const resolved = buildAppConfig(buildConfigJson(undefined, 'served-project-id'));

    expect(resolved.walletConnect.projectId).toBe('served-project-id');
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

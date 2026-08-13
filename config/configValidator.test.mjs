import { describe, expect, it } from 'vitest';

import { parseConfigOrThrow } from './configValidator.mjs';

const chain = (overrides = {}) => ({
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

// Minimal config satisfying jsonConfigSchema + the pre-existing semantic
// checks (>=1 chain, an enabled mode with >=2 chainKeys, a config for the
// default mode). Callers mutate `chains`/`appModes.configs.devnet` per test.
// devnet uses the single-proxy `aggkitProxy` form -- the only form the schema
// accepts as of this config surface cleanup (the per-network `aggkitBridgeApis`
// map has been removed; see configSchema.mjs's comment on aggkitProxySchema).
const buildConfig = () => ({
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
        aggkitProxy: 'https://aggkit-proxy.example/aggkitapi',
        chainKeys: ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'],
        defaultFromChainKey: 'DEVNET_L1',
        defaultToChainKey: 'DEVNET_L2_001'
      }
    }
  }
});

describe('parseConfigOrThrow — aggkitProxy (the only supported aggkit backend field)', () => {
  it('passes for a well-formed config using aggkitProxy', () => {
    expect(() => parseConfigOrThrow(buildConfig())).not.toThrow();
  });

  it('passes for a mode with aggkitProxy omitted entirely (the "not yet configured" escape hatch)', () => {
    const config = buildConfig();
    delete config.appModes.configs.devnet.aggkitProxy;

    expect(() => parseConfigOrThrow(config)).not.toThrow();
  });

  it('rejects the removed per-network aggkitBridgeApis map as an unrecognized key (.strict())', () => {
    const config = buildConfig();
    // The map form used to be a genuinely supported, mutually-exclusive
    // alternative to aggkitProxy. It has been removed from the schema
    // entirely: this proves it, rather than assuming it, so a future
    // accidental re-add would be caught here.
    config.appModes.configs.devnet.aggkitBridgeApis = {
      1: 'https://aggkit.example/1',
      2: 'https://aggkit.example/2'
    };

    expect(() => parseConfigOrThrow(config)).toThrow(/Unrecognized key: "aggkitBridgeApis"/);
  });

  it('rejects a non-http(s) aggkitProxy URL scheme', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.aggkitProxy = 'javascript:alert(1)';

    expect(() => parseConfigOrThrow(config)).toThrow(/schema validation failed/);
  });

  it('accepts an origin-relative aggkitProxy path', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.aggkitProxy = '/aggkitapi';

    expect(() => parseConfigOrThrow(config)).not.toThrow();
  });
});

describe('parseConfigOrThrow — chainKeys / default-chain-key checks (unaffected by the aggkitProxy migration)', () => {
  it('throws when chainKeys lists the same chain key twice', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.chainKeys.push('DEVNET_L1');

    expect(() => parseConfigOrThrow(config)).toThrow(
      /appModes\.configs\.devnet\.chainKeys: duplicate chain keys are not allowed/
    );
  });

  it('throws when chainKeys references a chain key absent from chains', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.chainKeys.push('NONEXISTENT');

    expect(() => parseConfigOrThrow(config)).toThrow(
      /appModes\.configs\.devnet\.chainKeys: chain key "NONEXISTENT" does not exist in chains/
    );
  });

  it('throws when defaultFromChainKey is not one of chainKeys', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.defaultFromChainKey = 'DEVNET_L2_002';
    config.appModes.configs.devnet.chainKeys = ['DEVNET_L1', 'DEVNET_L2_001'];

    expect(() => parseConfigOrThrow(config)).toThrow(
      /appModes\.configs\.devnet\.defaultFromChainKey: "DEVNET_L2_002" must be listed in chainKeys/
    );
  });
});

describe('parseConfigOrThrow — chains<->map and duplicate-networkId checks no longer guard anything (by design)', () => {
  it('two non-L1 chains sharing a networkId is NOT rejected once neither uses the map form -- there is no check left to catch it', () => {
    // This is the documented consequence of removing aggkitBridgeApis
    // entirely (see docs/config.md): the chains<->map cross-check and the
    // duplicate-networkId check only ever applied to the map form. With that
    // form gone, nothing in this validator inspects networkId agreement for
    // aggkitProxy mode at all -- a single proxy fronts every network by
    // construction, so there is no per-chain key agreement left to check.
    const config = buildConfig();
    config.chains.DEVNET_L2_002.networkId = 1; // same as DEVNET_L2_001

    expect(() => parseConfigOrThrow(config)).not.toThrow();
  });
});

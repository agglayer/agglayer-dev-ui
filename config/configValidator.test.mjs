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
        aggkitBridgeApis: {
          1: 'https://aggkit.example/aggkitapi',
          2: 'https://aggkit.example/aggkitapi'
        },
        chainKeys: ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'],
        defaultFromChainKey: 'DEVNET_L1',
        defaultToChainKey: 'DEVNET_L2_001'
      }
    }
  }
});

describe('parseConfigOrThrow — chains <-> aggkitBridgeApis cross-field validation (design.md §1.2)', () => {
  it('passes when every non-L1 chain has a matching aggkitBridgeApis entry and vice versa', () => {
    expect(() => parseConfigOrThrow(buildConfig())).not.toThrow();
  });

  it('E1: throws when a configured non-L1 chain has no aggkitBridgeApis entry', () => {
    const config = buildConfig();
    delete config.appModes.configs.devnet.aggkitBridgeApis['2'];

    expect(() => parseConfigOrThrow(config)).toThrow(
      /aggkitBridgeApis: missing entry for chain "DEVNET_L2_002" \(networkId 2\)/
    );
  });

  it('E2: throws when an aggkitBridgeApis key does not match any configured chain', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.aggkitBridgeApis['999'] = 'https://aggkit.example/aggkitapi';

    expect(() => parseConfigOrThrow(config)).toThrow(
      /aggkitBridgeApis: key "999" does not match the networkId of any chain in chainKeys/
    );
  });

  it('exempts an intentionally-empty aggkitBridgeApis ({}) from both checks', () => {
    const config = buildConfig();
    config.appModes.configs.devnet.aggkitBridgeApis = {};

    expect(() => parseConfigOrThrow(config)).not.toThrow();
  });

  it('never requires an aggkitBridgeApis entry for an L1 chain (networkId 0)', () => {
    const config = buildConfig();
    // Only the L1 chain configured, no aggkit backend for it -- must not
    // trip E1 (L1 chains are exempt; they never route through aggkit).
    config.chains = { DEVNET_L1: chain({ id: 271828, name: 'Devnet L1', networkId: 0 }) };
    config.appModes.configs.devnet.chainKeys = ['DEVNET_L1'];
    config.appModes.configs.devnet.defaultToChainKey = 'DEVNET_L1';
    config.appModes.configs.devnet.aggkitBridgeApis = {};
    // Need >=2 chainKeys for the pre-existing "at least one enabled mode"
    // check, so add a second L1-shaped chain (still networkId 0).
    config.chains.DEVNET_L1_ALT = chain({ id: 271829, name: 'Devnet L1 Alt', networkId: 0 });
    config.appModes.configs.devnet.chainKeys.push('DEVNET_L1_ALT');

    expect(() => parseConfigOrThrow(config)).not.toThrow();
  });

  // E1/E2 both pass in this shape -- every chain finds a matching key and every
  // key matches some chain -- yet the two L2s collapse onto one aggkit backend
  // client, silently merging one chain's rows into the other's.
  it('E3: throws when two non-L1 chains in a mode share a networkId', () => {
    const config = buildConfig();
    config.chains.DEVNET_L2_002.networkId = 1;
    config.appModes.configs.devnet.aggkitBridgeApis = {
      1: 'https://aggkit.example/aggkitapi'
    };

    expect(() => parseConfigOrThrow(config)).toThrow(
      /chains "DEVNET_L2_001" and "DEVNET_L2_002" share networkId 1/
    );
  });

  it('E3: allows several L1 chains to share networkId 0', () => {
    const config = buildConfig();
    // networkId 0 never keys an aggkitBridgeApis entry, so duplicates there are
    // harmless -- only non-L1 networks map to a backend client.
    config.chains.DEVNET_L1_ALT = chain({ id: 271829, name: 'Devnet L1 Alt', networkId: 0 });
    config.appModes.configs.devnet.chainKeys.push('DEVNET_L1_ALT');

    expect(() => parseConfigOrThrow(config)).not.toThrow();
  });
});

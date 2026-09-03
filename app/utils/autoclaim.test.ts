import type { AppMode } from '@/app/types/appMode';
import type { AutoclaimRouteConfig, JsonConfig } from '@/app/types/config';

import { initAppConfig, resetAppConfig } from '@/app/config';
import {
  computeAutoclaimGate,
  evictReadyAt,
  getReadyAt,
  getRouteType,
  recordReadyAt
} from '@/app/utils/autoclaim';
import { STORAGE_KEYS, StorageUtils } from '@/app/utils/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getRouteType', () => {
  it('classifies L1 -> L2 (source is L1, destination is an L2)', () => {
    expect(getRouteType(0, 1)).toBe('l1_to_l2');
  });

  it('classifies L2 -> L1 (source is an L2, destination is L1)', () => {
    // Includes the native-gas-token withdrawal case: recording network is the
    // L2 even though origin_network would be 0.
    expect(getRouteType(1, 0)).toBe('l2_to_l1');
  });

  it('classifies L2 -> L2 (neither side is L1)', () => {
    expect(getRouteType(1, 2)).toBe('l2_to_l2');
  });
});

describe('computeAutoclaimGate', () => {
  const withAutoclaim: AutoclaimRouteConfig = {
    expectedAutoclaim: true,
    waitForAutoclaimMs: 60_000
  };
  const noAutoclaim: AutoclaimRouteConfig = {
    expectedAutoclaim: false,
    waitForAutoclaimMs: 0
  };

  it('is no-autoclaim when the route does not expect autoclaim', () => {
    expect(
      computeAutoclaimGate({ config: noAutoclaim, isReadyToClaim: true, readyAt: 1000, now: 1000 })
    ).toBe('no-autoclaim');
  });

  it('is no-autoclaim when the deposit is not ready to claim', () => {
    expect(
      computeAutoclaimGate({ config: withAutoclaim, isReadyToClaim: false, readyAt: null, now: 0 })
    ).toBe('no-autoclaim');
  });

  it('waits before the grace period has elapsed', () => {
    expect(
      computeAutoclaimGate({
        config: withAutoclaim,
        isReadyToClaim: true,
        readyAt: 1_000,
        now: 1_000 + 59_999
      })
    ).toBe('waiting');
  });

  it('waits when the ready timestamp is not yet recorded', () => {
    expect(
      computeAutoclaimGate({ config: withAutoclaim, isReadyToClaim: true, readyAt: null, now: 0 })
    ).toBe('waiting');
  });

  it('is overdue once the grace period has elapsed', () => {
    expect(
      computeAutoclaimGate({
        config: withAutoclaim,
        isReadyToClaim: true,
        readyAt: 1_000,
        now: 1_000 + 60_000
      })
    ).toBe('overdue');
  });
});

describe('readyAt storage (getReadyAt / recordReadyAt / evictReadyAt)', () => {
  // Same fixture shape as app/config.test.ts's buildConfigJson, trimmed to
  // the minimum buildAppConfig needs, with a small, deterministic autoclaim
  // block so getMaxWaitForAutoclaimMs (the age-eviction bound) is a known
  // value in every test below: max(1_000, 0, 2_000) = 2_000ms.
  const chain = (overrides: Partial<JsonConfig['chains'][string]> = {}) => ({
    id: 1,
    name: 'Chain',
    rpcUrl: 'https://rpc.example',
    explorerUrl: 'https://explorer.example',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    iconUrl: 'https://icon.example/icon.svg',
    networkId: 0,
    isTestnet: true,
    etaL1Minutes: 1,
    etaL2Minutes: 1,
    ...overrides
  });

  const configJson: JsonConfig = {
    autoclaim: {
      l1_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 1_000 },
      l2_to_l1: { expectedAutoclaim: false, waitForAutoclaimMs: 0 },
      l2_to_l2: { expectedAutoclaim: true, waitForAutoclaimMs: 2_000 }
    },
    walletConnect: { projectId: 'test-project-id' },
    externalLinks: {
      privacyPolicy: 'https://privacy.example',
      termsOfUse: 'https://terms.example',
      contactSupport: 'https://support.example'
    },
    chains: {
      DEVNET_L1: chain({ id: 271828, name: 'Devnet L1', networkId: 0 }),
      DEVNET_L2_001: chain({ id: 20201, name: 'Devnet L2-001', networkId: 1 })
    },
    appModes: {
      default: 'devnet',
      configs: {
        devnet: {
          label: 'Devnet',
          bridgeAddress: '0xC8cbEBf950B9Df44d987c8619f092beA980fF038',
          etaL1Minutes: 1,
          etaL2Minutes: 1,
          aggkitProxy: 'https://aggkit-proxy.example/aggkitapi',
          chainKeys: ['DEVNET_L1', 'DEVNET_L2_001'],
          defaultFromChainKey: 'DEVNET_L1',
          defaultToChainKey: 'DEVNET_L2_001'
        }
      }
    }
  } as JsonConfig;

  const MAX_AGE_MS = 2_000;
  const devnet: AppMode = 'devnet';
  const testnet: AppMode = 'testnet';

  const rawMap = (mode: AppMode) =>
    StorageUtils.getItem<Record<string, number>>(STORAGE_KEYS.AUTOCLAIM_READY_AT(mode), {}) ?? {};

  beforeEach(() => {
    initAppConfig(configJson);
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAppConfig();
  });

  it('uses a storage key that includes the app mode', () => {
    expect(STORAGE_KEYS.AUTOCLAIM_READY_AT(devnet)).not.toBe(
      STORAGE_KEYS.AUTOCLAIM_READY_AT(testnet)
    );
    expect(STORAGE_KEYS.AUTOCLAIM_READY_AT(devnet)).toContain('devnet');
    expect(STORAGE_KEYS.AUTOCLAIM_READY_AT(testnet)).toContain('testnet');
  });

  it('records and reads back a readyAt value scoped to a single mode', () => {
    recordReadyAt(devnet, '0xhash', 0);
    expect(getReadyAt(devnet, '0xhash')).toBe(0);
  });

  it('does not evict an entry younger than the largest configured waitForAutoclaimMs', () => {
    recordReadyAt(devnet, '0xhash', 0);
    vi.setSystemTime(MAX_AGE_MS - 1);
    expect(getReadyAt(devnet, '0xhash')).toBe(0);
  });

  it('evicts an entry once it is older than the largest configured waitForAutoclaimMs', () => {
    recordReadyAt(devnet, '0xhash', 0);
    vi.setSystemTime(MAX_AGE_MS + 1);
    expect(getReadyAt(devnet, '0xhash')).toBeNull();
    // The eviction pass also persists the pruned map, not just the return value.
    expect(rawMap(devnet)).toEqual({});
  });

  it('evicts an entry once its bridge is observed CLAIMED', () => {
    recordReadyAt(devnet, '0xhash', 0);
    evictReadyAt(devnet, '0xhash');
    expect(getReadyAt(devnet, '0xhash')).toBeNull();
    expect(rawMap(devnet)).toEqual({});
  });

  it('isolates the same row id recorded under two different app modes', () => {
    // This is the devnet stale-hash bug: without mode scoping, the same row
    // id (Transaction.hubUID -- kurtosis enclaves replay identical tx hashes
    // across rebuilds) observed on two different modes would collide in a
    // single shared map.
    recordReadyAt(devnet, '0xsametx:0', 0);
    vi.setSystemTime(500);
    recordReadyAt(testnet, '0xsametx:0', 500);

    expect(getReadyAt(devnet, '0xsametx:0')).toBe(0);
    expect(getReadyAt(testnet, '0xsametx:0')).toBe(500);

    evictReadyAt(devnet, '0xsametx:0');
    expect(getReadyAt(devnet, '0xsametx:0')).toBeNull();
    // Evicting the devnet entry must not touch testnet's.
    expect(getReadyAt(testnet, '0xsametx:0')).toBe(500);
  });

  it('does not let the persisted map grow across repeated eviction passes', () => {
    recordReadyAt(devnet, '0xhash-a', 0);
    recordReadyAt(devnet, '0xhash-b', 0);
    recordReadyAt(devnet, '0xhash-c', 0);
    expect(Object.keys(rawMap(devnet))).toHaveLength(3);

    vi.setSystemTime(MAX_AGE_MS + 1);
    // A fresh record after all prior entries have aged out should trigger
    // the prune pass and leave only the new entry behind.
    recordReadyAt(devnet, '0xhash-d', MAX_AGE_MS + 1);
    expect(rawMap(devnet)).toEqual({ '0xhash-d': MAX_AGE_MS + 1 });

    // Reading repeatedly afterwards must not cause the map to grow back.
    getReadyAt(devnet, '0xhash-a');
    getReadyAt(devnet, '0xhash-d');
    expect(Object.keys(rawMap(devnet))).toHaveLength(1);
  });
});

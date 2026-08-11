import type { JsonConfig } from '@/app/types/config';

import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the fetch adapter -- everything downstream of it (normalization,
// the module store, AppModeProvider/WalletProvider/etc.) is the real
// implementation. This lets the "does not mount wallet providers" case below
// render the actual app/providers.tsx composition rather than a stand-in.
vi.mock('@/app/configLoader', () => ({
  fetchAppConfig: vi.fn()
}));

import { AppConfigGate } from '@/app/components/appConfigGate';
import { getAppConfig, isAppConfigReady, resetAppConfig } from '@/app/config';
import { fetchAppConfig } from '@/app/configLoader';
import { Providers } from '@/app/providers';

const mockedFetchAppConfig = vi.mocked(fetchAppConfig);

// Same fixture shape used across the A-5 test files (design.md §4/§7).
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

const validConfig: JsonConfig = {
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
          1: 'https://aggkit.example/1',
          2: 'https://aggkit.example/2'
        },
        chainKeys: ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'],
        defaultFromChainKey: 'DEVNET_L1',
        defaultToChainKey: 'DEVNET_L2_001'
      }
    }
  }
} as JsonConfig;

beforeEach(() => {
  resetAppConfig();
  mockedFetchAppConfig.mockReset();
});

describe('AppConfigGate — pending (A-5 item 5)', () => {
  it('renders the designed loading placeholder and withholds children', () => {
    // A promise that never settles during the test -- the gate's first (and,
    // here, only) render.
    mockedFetchAppConfig.mockReturnValue(new Promise<JsonConfig>(() => {}));

    const { container } = render(
      <AppConfigGate>
        <div data-test-id="gated-child" />
      </AppConfigGate>
    );

    expect(container.querySelector('[data-test-id="app-config-loading"]')).toBeInTheDocument();
    expect(container.querySelector('[data-test-id="gated-child"]')).toBeNull();
    expect(container.querySelector('[data-test-id="app-config-error"]')).toBeNull();
  });
});

describe('AppConfigGate — success', () => {
  it('populates the app/config.ts store before mounting children', async () => {
    mockedFetchAppConfig.mockResolvedValue(validConfig);

    const { container } = render(
      <AppConfigGate>
        <div data-test-id="gated-child" />
      </AppConfigGate>
    );

    await waitFor(() =>
      expect(container.querySelector('[data-test-id="gated-child"]')).toBeInTheDocument()
    );

    expect(container.querySelector('[data-test-id="app-config-loading"]')).toBeNull();
    // The store is guaranteed populated by the time this child is visible --
    // this is the invariant every accessor in app/config.ts relies on.
    expect(isAppConfigReady()).toBe(true);
    expect(getAppConfig().defaultAppMode).toBe('devnet');
  });
});

describe('AppConfigGate — failure, exercised through the real app/providers.tsx tree (A-5 item 5)', () => {
  it('renders the designed error screen and mounts neither the gated children nor the wallet/app-mode providers', async () => {
    mockedFetchAppConfig.mockRejectedValue(
      new Error('config.json schema validation failed:\n- chains: configure at least one chain')
    );

    const { container } = render(
      <Providers>
        <div data-test-id="marker">should never render</div>
      </Providers>
    );

    await waitFor(() =>
      expect(container.querySelector('[data-test-id="app-config-error"]')).toBeInTheDocument()
    );

    // The error text is the operator-facing diagnostic from parseConfigOrThrow.
    expect(container.textContent).toContain('config.json schema validation failed:');
    expect(container.textContent).toContain('chains: configure at least one chain');

    // AppModeProvider and WalletProvider are *inside* AppConfigGate's
    // children in app/providers.tsx -- if the gate is doing its job, neither
    // they nor the app's own children ever render, and the config store
    // stays empty.
    expect(container.querySelector('[data-test-id="marker"]')).toBeNull();
    expect(isAppConfigReady()).toBe(false);
  });
});

import type { AppMode } from '@/app/types/appMode';
import type { JsonConfig } from '@/app/types/config';
import type { Transaction } from '@/app/types/transaction';

import { initAppConfig, resetAppConfig } from '@/app/config';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/context/appMode', () => ({
  useAppMode: vi.fn()
}));

import { useAppMode } from '@/app/context/appMode';

import { useAutoclaimGate } from './useAutoclaimGate';

// Same trimmed fixture shape as app/utils/autoclaim.test.ts, so
// getMaxWaitForAutoclaimMs (the age-eviction bound) is max(1_000, 0, 2_000)
// = 2_000ms and l1_to_l2's grace window is a known 1_000ms.
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

// Two genuinely distinct L1->L2 deposits that SHARE a bridge_hash -- the
// normal case for repeat bridges of the same amount to the same receiver,
// since bridge_hash is a content hash (see app/services/activity.ts's
// toHubUID; 13 real bridges collapsed to 5 distinct hashes on the live rc8
// devnet). Only hubUID tells them apart.
const sibling = (hubUID: string): Transaction => ({
  hubUID,
  txSender: '0xabc',
  fromAddress: '0xabc',
  receiverAddress: '0xdef',
  sourceNetwork: 0,
  destinationNetwork: 1,
  amount: '1000',
  status: 'READY_TO_CLAIM',
  lastUpdatedAt: 0,
  bridgeHash: '0xSHARED-CONTENT-HASH',
  metadata: '0x',
  leafType: 'asset',
  depositCount: 0,
  transactionIndex: 0,
  transactionHash: hubUID,
  blockNumber: 0,
  globalIndex: '18446744073709551616',
  originTokenAddress: '0x0000000000000000000000000000000000000000',
  originTokenNetwork: 0,
  timestamp: 0,
  leafIndex: 0
});

const devnet: AppMode = 'devnet';

describe('useAutoclaimGate — readyAt is keyed per deposit, not per bridge_hash', () => {
  beforeEach(() => {
    initAppConfig(configJson);
    window.localStorage.clear();
    vi.mocked(useAppMode).mockReturnValue({ mode: devnet } as ReturnType<typeof useAppMode>);
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAppConfig();
    vi.clearAllMocks();
  });

  it('does not let one deposit inherit a same-bridge_hash sibling elapsed grace window', () => {
    const first = renderHook(() => useAutoclaimGate(sibling('0xtx-a:0')));
    expect(first.result.current).toBe('waiting');

    // First deposit's 1_000ms window has elapsed, but its entry is still
    // young enough (1_500 <= 2_000) not to have been age-pruned.
    vi.setSystemTime(1_500);
    expect(renderHook(() => useAutoclaimGate(sibling('0xtx-a:0'))).result.current).toBe('overdue');

    // The sibling is only now first observed READY_TO_CLAIM, so its own
    // window starts at 1_500 and it must still read 'waiting'. Keyed on
    // bridgeHash it would have inherited readyAt 0 and read 'overdue'.
    expect(renderHook(() => useAutoclaimGate(sibling('0xtx-b:0'))).result.current).toBe('waiting');
  });

  it('does not wipe a sibling grace window when the other deposit is claimed', () => {
    renderHook(() => useAutoclaimGate(sibling('0xtx-a:0')));
    vi.setSystemTime(500);
    renderHook(() => useAutoclaimGate(sibling('0xtx-b:0')));

    // The first deposit lands CLAIMED, which evicts its readyAt entry.
    renderHook(() => useAutoclaimGate({ ...sibling('0xtx-a:0'), status: 'CLAIMED' }));

    // The sibling's window must survive that eviction: re-mounting it at
    // 1_400 (900ms into its own 1_000ms window) still reads 'waiting'.
    // Keyed on bridgeHash the shared entry was gone, so the sibling
    // restarted its window from scratch at 1_400 instead.
    vi.setSystemTime(1_400);
    expect(renderHook(() => useAutoclaimGate(sibling('0xtx-b:0'))).result.current).toBe('waiting');

    vi.setSystemTime(1_600);
    expect(renderHook(() => useAutoclaimGate(sibling('0xtx-b:0'))).result.current).toBe('overdue');
  });
});

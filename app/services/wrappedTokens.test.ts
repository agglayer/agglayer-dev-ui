import type { TokenMetadata } from '@/app/services/tokenMetadata';
import type { AppChain } from '@/app/types/appMode';

import { fetchTokenMetadata } from '@/app/services/tokenMetadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AggkitBridgeAggregator } from '@agglayer/sdk';

import { resolveTokenToOrigin } from './wrappedTokens';

vi.mock('@/app/services/tokenMetadata', () => ({
  fetchTokenMetadata: vi.fn()
}));

const L1_ADDRESS = '0x1111111111111111111111111111111111111111';
const L2_WRAPPED_ADDRESS = '0x2222222222222222222222222222222222222222';

const chains = [
  { id: 11155111, networkId: 0, name: 'Sepolia' },
  { id: 82, networkId: 82, name: 'Bali 82' }
] as unknown as AppChain[];

const metadata = (tokenAddress: string, symbol: string): TokenMetadata => ({
  name: symbol,
  symbol,
  decimals: 6,
  tokenAddress
});

const makeAggregator = (origin: Awaited<ReturnType<AggkitBridgeAggregator['getTokenOrigin']>>) => {
  const getTokenOrigin = vi.fn().mockResolvedValue(origin);
  return { aggregator: { getTokenOrigin } as unknown as AggkitBridgeAggregator, getTokenOrigin };
};

describe('resolveTokenToOrigin', () => {
  beforeEach(() => {
    vi.mocked(fetchTokenMetadata).mockReset();
  });

  it('keeps the token as is when the bridge does not know it as wrapped', async () => {
    const { aggregator, getTokenOrigin } = makeAggregator({
      originNetwork: 82,
      originTokenAddress: L2_WRAPPED_ADDRESS,
      isWrapped: false
    });
    const tokenMetadata = metadata(L2_WRAPPED_ADDRESS, 'USDC');

    const result = await resolveTokenToOrigin({
      aggregator,
      chains,
      chainId: 82,
      tokenAddress: L2_WRAPPED_ADDRESS,
      metadata: tokenMetadata
    });

    expect(result).toEqual({ chainId: 82, metadata: tokenMetadata });
    expect(getTokenOrigin).toHaveBeenCalledWith(L2_WRAPPED_ADDRESS, 82);
    expect(fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('stores a wrapped token as its origin, reading the metadata on the origin network', async () => {
    const { aggregator } = makeAggregator({
      originNetwork: 0,
      originTokenAddress: L1_ADDRESS,
      isWrapped: true
    });
    const originMetadata = metadata(L1_ADDRESS, 'USDC');
    vi.mocked(fetchTokenMetadata).mockResolvedValue(originMetadata);

    const result = await resolveTokenToOrigin({
      aggregator,
      chains,
      chainId: 82,
      tokenAddress: L2_WRAPPED_ADDRESS,
      metadata: metadata(L2_WRAPPED_ADDRESS, 'WUSDC')
    });

    expect(result).toEqual({ chainId: 11155111, metadata: originMetadata });
    expect(fetchTokenMetadata).toHaveBeenCalledWith({
      aggregator,
      networkId: 0,
      tokenAddress: L1_ADDRESS
    });
  });

  it('rejects when the origin network is not configured in the app', async () => {
    const { aggregator } = makeAggregator({
      originNetwork: 999,
      originTokenAddress: L1_ADDRESS,
      isWrapped: true
    });

    await expect(
      resolveTokenToOrigin({
        aggregator,
        chains,
        chainId: 82,
        tokenAddress: L2_WRAPPED_ADDRESS,
        metadata: metadata(L2_WRAPPED_ADDRESS, 'WUSDC')
      })
    ).rejects.toThrow(/network 999/);
    expect(fetchTokenMetadata).not.toHaveBeenCalled();
  });
});

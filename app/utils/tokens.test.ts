import { describe, it, expect } from 'vitest';

import { getTokenLogoUrl } from './tokens';

describe('getTokenLogoUrl', () => {
  it('builds a medium-size logo URL keyed by chain id and lowercased address', () => {
    expect(
      getTokenLogoUrl({ chainId: 137, address: '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582' })
    ).toBe(
      'https://assets.sequence.info/images/tokens/medium/137/0x528e26b25a34a4a5d0dbda1d57d318153d2ed582.webp'
    );
  });

  it('includes the chain id in the path so the same address resolves per chain', () => {
    expect(
      getTokenLogoUrl({ chainId: 1, address: '0x0000000000000000000000000000000000000000' })
    ).toBe(
      'https://assets.sequence.info/images/tokens/medium/1/0x0000000000000000000000000000000000000000.webp'
    );
    expect(
      getTokenLogoUrl({ chainId: 137, address: '0x0000000000000000000000000000000000000000' })
    ).toBe(
      'https://assets.sequence.info/images/tokens/medium/137/0x0000000000000000000000000000000000000000.webp'
    );
  });

  it('returns undefined when chainId is missing', () => {
    expect(
      getTokenLogoUrl({ address: '0x0000000000000000000000000000000000000000' })
    ).toBeUndefined();
  });

  it('returns undefined when address is missing', () => {
    expect(getTokenLogoUrl({ chainId: 137 })).toBeUndefined();
  });
});

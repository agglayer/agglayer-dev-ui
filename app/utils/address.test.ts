import { describe, it, expect } from 'vitest';

import { isSameAddress, isValidEthereumAddress, shortenAddress } from './address';

describe('isValidEthereumAddress', () => {
  it('accepts a canonical 0x-prefixed 40-hex-char address', () => {
    expect(isValidEthereumAddress('0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582')).toBe(true);
  });

  it('rejects an address missing the 0x prefix', () => {
    expect(isValidEthereumAddress('528e26b25a34a4A5d0dbDa1d57D318153d2ED582')).toBe(false);
  });

  it('rejects an address of the wrong length', () => {
    expect(isValidEthereumAddress('0xabc')).toBe(false);
  });
});

describe('isSameAddress', () => {
  it('returns true for the same address with mixed casing and surrounding whitespace', () => {
    expect(
      isSameAddress(
        ' 0x528e26B25A34A4A5D0DBDA1D57D318153D2ED582 ',
        '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582'
      )
    ).toBe(true);
  });

  it('returns false when either side is undefined', () => {
    expect(isSameAddress(undefined, '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582')).toBe(false);
    expect(isSameAddress('0x528e26b25a34a4a5d0dbda1d57d318153d2ed582', undefined)).toBe(false);
  });
});

describe('shortenAddress', () => {
  it('keeps the first and last N characters separated by an ellipsis', () => {
    expect(shortenAddress('0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582')).toBe('0x52...D582');
  });

  it('respects the chars parameter', () => {
    expect(shortenAddress('0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582', 6)).toBe('0x528e...2ED582');
  });

  it('returns an empty string for an empty input', () => {
    expect(shortenAddress('')).toBe('');
  });
});

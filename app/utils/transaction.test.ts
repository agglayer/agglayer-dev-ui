import { describe, expect, it } from 'vitest';

import type { TransactionParams } from '@agglayer/sdk';

import { CLAIM_GAS_BUFFER, mapTransactionRequest } from './transaction';

const baseParams: TransactionParams = {
  to: '0x1111111111111111111111111111111111111111',
  data: '0xabcdef',
  value: '1000'
};

describe('mapTransactionRequest gas buffer', () => {
  it('adds gasBuffer to the SDK gas', () => {
    const request = mapTransactionRequest(
      { ...baseParams, gas: '202542' },
      { gasBuffer: CLAIM_GAS_BUFFER }
    );

    expect(request.gas).toBe(BigInt(202542) + CLAIM_GAS_BUFFER);
  });

  it('CLAIM_GAS_BUFFER clears the worst out-of-gas claim seen in the load test', () => {
    // Estimate 202,542; execution needed up to ~245.5k with concurrent claims.
    const request = mapTransactionRequest(
      { ...baseParams, gas: '202542' },
      { gasBuffer: CLAIM_GAS_BUFFER }
    );

    expect(request.gas).toBeGreaterThan(BigInt(245500));
  });

  it('emits no gas key when no buffer is requested', () => {
    expect('gas' in mapTransactionRequest({ ...baseParams, gas: '202542' })).toBe(false);
  });

  it('emits no gas key when the SDK supplies no gas, even with a buffer', () => {
    expect('gas' in mapTransactionRequest(baseParams, { gasBuffer: CLAIM_GAS_BUFFER })).toBe(false);
  });

  it('still maps to, data and value', () => {
    expect(mapTransactionRequest(baseParams)).toEqual({
      to: baseParams.to,
      data: baseParams.data,
      value: BigInt(1000)
    });
  });
});

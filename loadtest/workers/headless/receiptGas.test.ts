// S45 C1: receipt gas capture (incl. OP L1-fee fields as raw hex) and
// NewWrappedToken wrapper-deploy detection, from fixture receipts/logs.
import type { Address, Hex } from 'viem';

import { encodeAbiParameters, encodeEventTopics, parseAbiItem, toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  detectWrapperDeployed,
  extractReceiptGas,
  NEW_WRAPPED_TOKEN_ABI
} from './receiptGas';

const BRIDGE: Address = '0x1348947e282138d8f377b467F7D9c2EB0F335d1f';
const OTHER: Address = '0x00000000000000000000000000000000000000aa';
const TOKEN: Address = '0x00000000000000000000000000000000000000bb';
const WRAPPED: Address = '0x00000000000000000000000000000000000000cc';

const newWrappedTokenLog = (address: string) => ({
  address,
  topics: encodeEventTopics({ abi: NEW_WRAPPED_TOKEN_ABI, eventName: 'NewWrappedToken' }) as Hex[],
  data: encodeAbiParameters(
    [{ type: 'uint32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }],
    [82, TOKEN, WRAPPED, '0x1234']
  )
});

describe('NewWrappedToken ABI', () => {
  it('has the bridge ABI topic0 for NewWrappedToken(uint32,address,address,bytes)', () => {
    expect(toEventSelector(NEW_WRAPPED_TOKEN_ABI[0])).toBe(
      toEventSelector('NewWrappedToken(uint32,address,address,bytes)')
    );
  });
});

describe('extractReceiptGas', () => {
  it('keeps gasUsed / effectiveGasPrice / blockNumber as decimal strings', () => {
    expect(
      extractReceiptGas({
        blockNumber: BigInt(1234),
        gasUsed: BigInt(210000),
        effectiveGasPrice: BigInt(1000251)
      })
    ).toStrictEqual({ blockNumber: '1234', gasUsed: '210000', effectiveGasPrice: '1000251' });
  });

  it('parses the OP L1-fee fields that viem leaves as raw hex strings', () => {
    const gas = extractReceiptGas({
      blockNumber: BigInt(9),
      gasUsed: BigInt(100),
      effectiveGasPrice: BigInt(2),
      l1Fee: '0x78',
      l1GasUsed: '0x1388',
      l1GasPrice: '0x7',
      l1BaseFeeScalar: '0x8dd',
      l1BlobBaseFee: '0x1',
      l1BlobBaseFeeScalar: '0x101c12',
      daFootprintGasScalar: '0x190'
    });
    expect(gas).toStrictEqual({
      blockNumber: '9',
      gasUsed: '100',
      effectiveGasPrice: '2',
      l1Fee: '120',
      l1GasUsed: '5000',
      l1GasPrice: '7',
      l1BaseFeeScalar: '2269',
      l1BlobBaseFee: '1',
      l1BlobBaseFeeScalar: '1055762',
      daFootprintGasScalar: '400'
    });
  });

  it('omits OP fields a non-OP receipt does not carry, and returns undefined without gasUsed', () => {
    const gas = extractReceiptGas({ blockNumber: BigInt(1), gasUsed: BigInt(5), effectiveGasPrice: BigInt(1) });
    expect(gas).not.toHaveProperty('l1Fee');
    expect(extractReceiptGas({ blockNumber: BigInt(1) })).toBeUndefined();
  });
});

describe('detectWrapperDeployed', () => {
  it('is true for a NewWrappedToken log emitted by the bridge', () => {
    expect(detectWrapperDeployed(BRIDGE, [newWrappedTokenLog(BRIDGE.toLowerCase())])).toBe(true);
  });

  it('is false for a NewWrappedToken log from another contract, and for unrelated bridge logs', () => {
    const bridgeEvent = parseAbiItem(
      'event ClaimEvent(uint256 globalIndex, uint32 originNetwork, address originAddress, address destinationAddress, uint256 amount)'
    );
    const claimEvent = {
      address: BRIDGE,
      topics: encodeEventTopics({ abi: [bridgeEvent], eventName: 'ClaimEvent' }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [BigInt(1), 82, TOKEN, OTHER, BigInt(5)]
      )
    };
    expect(detectWrapperDeployed(BRIDGE, [newWrappedTokenLog(OTHER)])).toBe(false);
    expect(detectWrapperDeployed(BRIDGE, [claimEvent])).toBe(false);
    expect(detectWrapperDeployed(BRIDGE, [])).toBe(false);
  });
});

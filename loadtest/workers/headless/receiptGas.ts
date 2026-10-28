// Measurement (S45 C1): pure helpers that turn the viem receipt the headless
// driver already holds into `ReceiptGas`, and detect a wrapper-token deploy.
// No I/O, no extra RPC.
import type { Address, Hex } from 'viem';

import { decodeEventLog, parseAbiItem } from 'viem';

import type { ReceiptGas } from '../../core/userDriver';

// The bridge's `NewWrappedToken` event, emitted by `claimAsset` when it deploys
// a wrapper ERC20 for a token that has no wrapper yet on the destination.
// Signature source: the bridge contract ABI vendored in this workspace at
// `repositories/dashboard/src/abi/PolygonZkEVMBridgeV2.json` (event
// `NewWrappedToken(uint32 originNetwork, address originTokenAddress,
// address wrappedTokenAddress, bytes metadata)`, all non-indexed), also present
// in the sovereign bridge binding
// `repositories/zkevm-bridge-service/etherman/smartcontracts/bridgel2sovereignchain`.
// The pinned `@agglayer/sdk` package does not export its ABIs, so the item is
// declared here, like `BRIDGE_EVENT_ABI` in `headlessUser.ts`.
export const NEW_WRAPPED_TOKEN_ABI = [
  parseAbiItem(
    'event NewWrappedToken(uint32 originNetwork, address originTokenAddress, address wrappedTokenAddress, bytes metadata)'
  )
];

export interface ReceiptLike {
  blockNumber?: unknown;
  gasUsed?: unknown;
  effectiveGasPrice?: unknown;
  logs?: readonly { address: string; data: Hex; topics: readonly Hex[] }[];
  [key: string]: unknown;
}

/** hex string (viem's unformatted OP fields) | bigint | number | decimal string -> decimal string; anything else -> undefined. */
const toDecimalString = (value: unknown): string | undefined => {
  try {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value).toString();
    if (typeof value === 'string' && value !== '') return BigInt(value).toString();
  } catch {
    // not numeric — fall through
  }
  return undefined;
};

const OP_FIELDS = [
  'l1Fee',
  'l1GasUsed',
  'l1GasPrice',
  'l1BaseFeeScalar',
  'l1BlobBaseFee',
  'l1BlobBaseFeeScalar',
  'daFootprintGasScalar'
] as const;

/**
 * `ReceiptGas` from a receipt, or `undefined` when the receipt lacks
 * `gasUsed`/`effectiveGasPrice` (never fabricates a value).
 */
export const extractReceiptGas = (receipt: ReceiptLike): ReceiptGas | undefined => {
  const gasUsed = toDecimalString(receipt.gasUsed);
  const effectiveGasPrice = toDecimalString(receipt.effectiveGasPrice);
  if (gasUsed === undefined || effectiveGasPrice === undefined) return undefined;
  const gas: ReceiptGas = {
    blockNumber: toDecimalString(receipt.blockNumber) ?? '',
    gasUsed,
    effectiveGasPrice
  };
  for (const field of OP_FIELDS) {
    const value = toDecimalString(receipt[field]);
    if (value !== undefined) gas[field] = value;
  }
  return gas;
};

/** True iff `logs` contains a `NewWrappedToken` emitted by `bridgeAddress`. */
export const detectWrapperDeployed = (
  bridgeAddress: Address | string,
  logs: ReceiptLike['logs']
): boolean => {
  for (const log of logs ?? []) {
    if (log.address.toLowerCase() !== bridgeAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: NEW_WRAPPED_TOKEN_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]]
      });
      if (decoded.eventName === 'NewWrappedToken') return true;
    } catch {
      // Not a NewWrappedToken log — keep scanning.
    }
  }
  return false;
};

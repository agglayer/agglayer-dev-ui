import type { AutoclaimRouteConfig, RouteType } from '@/app/types/config';

import { STORAGE_KEYS, StorageUtils } from '@/app/utils/storage';

// L1 is networkId 0; any other networkId is an L2. Note `sourceNetworkId` is the
// deposit's RECORDING network (see AggkitBridgeAggregator), which is what
// correctly distinguishes an L2 native-gas-token withdrawal (recorded on the L2,
// even though its origin_network is 0) from a genuine L1 origin.
export const getRouteType = (
  sourceNetworkId: number,
  destinationNetworkId: number
): RouteType => {
  const sourceIsL1 = sourceNetworkId === 0;
  const destIsL1 = destinationNetworkId === 0;
  if (sourceIsL1 && !destIsL1) return 'l1_to_l2';
  if (!sourceIsL1 && destIsL1) return 'l2_to_l1';
  return 'l2_to_l2';
};

// Whether the manual "Claim tokens" button should show, and whether the autoclaim
// grace period is still running:
//  - 'no-autoclaim': no autoclaim expected for this route -> show button now.
//  - 'waiting': autoclaim expected and still within the grace window -> show a
//    "waiting for auto claim, claim manually now" hint instead of the button.
//  - 'overdue': grace window elapsed -> show the button plus a "taking longer
//    than expected" note.
export type AutoclaimGate = 'no-autoclaim' | 'waiting' | 'overdue';

export const computeAutoclaimGate = (params: {
  config: AutoclaimRouteConfig;
  isReadyToClaim: boolean;
  readyAt: number | null;
  now: number;
}): AutoclaimGate => {
  const { config, isReadyToClaim, readyAt, now } = params;
  if (!isReadyToClaim || !config.expectedAutoclaim) return 'no-autoclaim';
  if (readyAt === null) return 'waiting';
  return now >= readyAt + config.waitForAutoclaimMs ? 'overdue' : 'waiting';
};

type ReadyAtMap = Record<string, number>;

const readReadyAtMap = (): ReadyAtMap =>
  StorageUtils.getItem<ReadyAtMap>(STORAGE_KEYS.AUTOCLAIM_READY_AT, {}) ?? {};

export const getReadyAt = (bridgeHash: string): number | null =>
  readReadyAtMap()[bridgeHash] ?? null;

// Records `timestampMs` as the first-observed READY_TO_CLAIM time for
// `bridgeHash` if none is stored yet, and returns the effective (existing or
// newly-stored) value so the grace period is stable across refreshes.
export const recordReadyAt = (bridgeHash: string, timestampMs: number): number => {
  const map = readReadyAtMap();
  const existing = map[bridgeHash];
  if (existing !== undefined) return existing;
  map[bridgeHash] = timestampMs;
  StorageUtils.setItem(STORAGE_KEYS.AUTOCLAIM_READY_AT, map);
  return timestampMs;
};

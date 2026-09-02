import type { AppMode } from '@/app/types/appMode';
import type { AutoclaimRouteConfig, RouteType } from '@/app/types/config';

import { getAutoclaimConfig } from '@/app/config';
import { STORAGE_KEYS, StorageUtils } from '@/app/utils/storage';

// L1 is networkId 0; any other networkId is an L2. Note `sourceNetworkId` is the
// deposit's RECORDING network (see AggkitBridgeAggregator), which is what
// correctly distinguishes an L2 native-gas-token withdrawal (recorded on the L2,
// even though its origin_network is 0) from a genuine L1 origin.
export const getRouteType = (sourceNetworkId: number, destinationNetworkId: number): RouteType => {
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

const readReadyAtMap = (mode: AppMode): ReadyAtMap =>
  StorageUtils.getItem<ReadyAtMap>(STORAGE_KEYS.AUTOCLAIM_READY_AT(mode), {}) ?? {};

// Upper bound on how long a readyAt entry can possibly still matter: past
// this age every route's grace period has elapsed regardless of which route
// the entry belongs to (the map doesn't track route, only bridgeHash), so
// the gate would already read 'overdue' either way. Used to bound map growth
// for entries whose CLAIMED status never got observed (e.g. the tab closed,
// or the wallet changed) without needing a timer.
const getMaxWaitForAutoclaimMs = (): number =>
  Math.max(...Object.values(getAutoclaimConfig()).map((route) => route.waitForAutoclaimMs));

// Drops entries older than getMaxWaitForAutoclaimMs, persisting the result
// only when something was actually evicted (so a clean map isn't rewritten
// on every read). This is the eviction pass: it runs inline on every read or
// record below rather than on a timer.
const pruneReadyAtMap = (mode: AppMode, map: ReadyAtMap, now: number): ReadyAtMap => {
  const maxAgeMs = getMaxWaitForAutoclaimMs();
  const entries = Object.entries(map);
  const pruned = Object.fromEntries(entries.filter(([, readyAt]) => now - readyAt <= maxAgeMs));
  if (Object.keys(pruned).length !== entries.length) {
    StorageUtils.setItem(STORAGE_KEYS.AUTOCLAIM_READY_AT(mode), pruned);
  }
  return pruned;
};

export const getReadyAt = (mode: AppMode, bridgeHash: string): number | null =>
  pruneReadyAtMap(mode, readReadyAtMap(mode), Date.now())[bridgeHash] ?? null;

// Records `timestampMs` as the first-observed READY_TO_CLAIM time for
// `bridgeHash` if none is stored yet, and returns the effective (existing or
// newly-stored) value so the grace period is stable across refreshes. Keyed
// per app mode (see STORAGE_KEYS.AUTOCLAIM_READY_AT) so the same bridgeHash
// in two different modes (e.g. devnet re-using a hash already seen on
// testnet) never collides.
export const recordReadyAt = (mode: AppMode, bridgeHash: string, timestampMs: number): number => {
  const map = pruneReadyAtMap(mode, readReadyAtMap(mode), timestampMs);
  const existing = map[bridgeHash];
  if (existing !== undefined) return existing;
  map[bridgeHash] = timestampMs;
  StorageUtils.setItem(STORAGE_KEYS.AUTOCLAIM_READY_AT(mode), map);
  return timestampMs;
};

// Evicts `bridgeHash` from the readyAt map once its bridge is observed
// CLAIMED -- the grace period no longer applies, so nothing needs it. Reads
// via getReadyAt first so a CLAIMED observation also runs the age-based
// eviction pass above, not just this entry's removal.
export const evictReadyAt = (mode: AppMode, bridgeHash: string): void => {
  if (getReadyAt(mode, bridgeHash) === null) return;
  const map = readReadyAtMap(mode);
  delete map[bridgeHash];
  StorageUtils.setItem(STORAGE_KEYS.AUTOCLAIM_READY_AT(mode), map);
};

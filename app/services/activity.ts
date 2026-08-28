import type { Transaction, TransactionStatus } from '@/app/types/transaction';

import type { AggkitTrackingData } from '@agglayer/sdk';

// Client for aggkit's bridgetracker activity endpoint --
// GET {basePath}/activity/from/{from_address} (basePath "/tracker/v1"), see
// https://github.com/agglayer/aggkit/tree/feat/fix_bali_integration/bridgetracker/api/docs.
// Replaces the old AggkitBridgeAggregator.getActivity fan-out
// (4 REST calls x every configured L2 network, plus per-row status probes --
// see app/services/transactions.ts, now removed) with a single request: the
// bridgetracker service already scans every configured bridge service
// server-side and reports one unified, deduped list for the address.
//
// Trade-offs versus the old aggregator-based path (accepted per product
// decision, S-review 2026-08-28):
//  - No pagination: `bridges` is the address's entire history in one
//    response. useTransactions now paginates client-side over the full,
//    already-fetched array instead of requesting successive pages.
//  - No per-network partial-failure reporting: the old `failedNetworks`
//    notice has no equivalent here (the activity endpoint has no field for
//    it), so it's gone -- a single bad upstream bridge service is invisible
//    to the client, same as any other cause of a missing bridge.
//  - Status collapses from 4 values (BRIDGED/LEAF_INCLUDED/READY_TO_CLAIM/
//    CLAIMED) to what this endpoint actually guarantees: a claimed tri-state
//    (`claimed`) plus, when `includeTracking=true`, the same step-based
//    tracking data the old per-row tracker poll used. See deriveStatus below
//    for exactly how PENDING/READY_TO_CLAIM/CLAIMED/ERROR are derived from
//    that pair.

interface RawBridge {
  tx_hash: string;
  amount: string;
  block_num: number;
  block_pos: number;
  block_timestamp: number;
  bridge_hash: string;
  deposit_count: number;
  destination_address: string;
  destination_network: number;
  from_address?: string;
  global_index: string;
  leaf_type: number;
  metadata: string;
  origin_address: string;
  origin_network: number;
  to_address: string;
  txn_sender: string;
}

interface RawClaim {
  tx_hash: string;
  amount: string;
  block_num: number;
  block_timestamp: number;
  destination_address: string;
  destination_network: number;
  from_address: string;
  global_exit_root: string;
  global_index: string;
  is_message: boolean;
  mainnet_exit_root: string;
  metadata: string;
  origin_address: string;
  origin_network: number;
  proof_local_exit_root: string[];
  proof_rollup_exit_root: string[];
  rollup_exit_root: string;
}

interface RawActivityItem {
  bridge: RawBridge;
  bridge_network_id: number;
  claim?: RawClaim;
  claim_network_id?: number;
  // Tri-state result of the destination bridge contract's isClaimed() call:
  // "false" (confirmed unclaimed), "true" (claimed), or "error" if the check
  // itself failed -- callers must not read "error" as "false".
  claimed: 'true' | 'false' | 'error';
  creation_timestamp: number;
  last_updated_timestamp: number;
  errors?: Record<string, string>;
  // Only present when the request set includeTracking=true and the bridge
  // is still unclaimed. Same shape AggkitBridgeAggregator.getBridgeTracking
  // already returns (both are the bridgetracker service's TrackingData DTO).
  tracking?: AggkitTrackingData;
}

interface RawActivityResponse {
  bridges: RawActivityItem[];
  // Byte-array echo of the requested address (swagger: `type: array, items:
  // integer`) -- not the hex string we already have from the caller, so it's
  // never read here.
  from_address: number[];
}

interface RawErrorData {
  code: number;
  message: string;
}

// The last step of every route (L1->L2, L2->L1, L2->L2) is always
// "WaitingClaim" (see app/components/transactions/trackerProgressBar.tsx's
// route-length note and the captured fixtures in
// app/__fixtures__/tracker.ts) -- an unclaimed bridge whose current step is
// WaitingClaim and not yet "done" has nothing left to wait on but the claim
// transaction itself, which is exactly READY_TO_CLAIM.
const isWaitingOnClaimOnly = (tracking: AggkitTrackingData | undefined): boolean => {
  if (!tracking || tracking.step_index === null || !tracking.all_steps) return false;
  const currentStep = tracking.all_steps[tracking.step_index];
  return currentStep?.step_name === 'WaitingClaim' && currentStep.status !== 'done';
};

// Collapses the endpoint's claimed tri-state (+ optional tracking) into the
// 4 states the UI renders. This intentionally loses the old BRIDGED vs
// LEAF_INCLUDED distinction: the activity endpoint has no field for it, and
// approximating it from tracking step names was judged too speculative to
// ship (product decision, S-review 2026-08-28) -- everything unclaimed that
// isn't already waiting on just the claim tx renders as a single PENDING
// state instead.
export const deriveStatus = (
  item: Pick<RawActivityItem, 'claimed' | 'tracking' | 'errors'>
): { status: TransactionStatus; statusError?: string } => {
  if (item.claimed === 'true') return { status: 'CLAIMED' };
  if (item.claimed === 'error') return { status: 'ERROR', statusError: item.errors?.claim };
  return { status: isWaitingOnClaimOnly(item.tracking) ? 'READY_TO_CLAIM' : 'PENDING' };
};

// leaf_type 1 is a message, 0 is an asset -- same convention
// types.ClaimResponse.is_message documents on the claim side.
const toLeafType = (leafType: number): string => (leafType === 1 ? 'message' : 'asset');

export const toTransaction = (item: RawActivityItem): Transaction => {
  const { bridge, claim } = item;
  const { status, statusError } = deriveStatus(item);

  return {
    hubUID: bridge.bridge_hash,
    txSender: bridge.txn_sender,
    fromAddress: bridge.from_address ?? bridge.txn_sender,
    receiverAddress: bridge.destination_address,
    // bridge_network_id is the network whose bridge service reported this
    // bridge -- i.e. the deposit's RECORDING network, same concept
    // app/utils/autoclaim.ts's getRouteType relies on (distinct from
    // bridge.origin_network, which is the TOKEN's home network, mapped to
    // originTokenNetwork below).
    sourceNetwork: item.bridge_network_id,
    destinationNetwork: bridge.destination_network,
    amount: bridge.amount,
    status,
    statusError,
    lastUpdatedAt: item.last_updated_timestamp,
    bridgeHash: bridge.bridge_hash,
    metadata: bridge.metadata,
    leafType: toLeafType(bridge.leaf_type),
    depositCount: bridge.deposit_count,
    transactionIndex: bridge.block_pos,
    transactionHash: bridge.tx_hash,
    claimTransactionHash: claim?.tx_hash,
    claimTimestamp: claim?.block_timestamp,
    claimBlockNumber: claim?.block_num,
    blockNumber: bridge.block_num,
    globalIndex: bridge.global_index,
    originTokenAddress: bridge.origin_address,
    originTokenNetwork: bridge.origin_network,
    timestamp: bridge.block_timestamp,
    // useClaimExecution's isClaimed() check always wants deposit_count, never
    // an L1-info-tree index -- see app/utils/transaction.ts's
    // resolveLeafIndex doc comment.
    leafIndex: bridge.deposit_count,
    tracking: item.tracking
  };
};

// config.aggkitBridgeApis fans a single per-mode aggkitProxy URL out across
// every non-L1 networkId (app/config.ts's buildAggkitBridgeApisMap) -- every
// value is identical, so any one of them is this mode's real base URL. Only
// undefined when the mode has no non-L1 chains at all (see
// EnabledAppModeConfig -- shouldn't happen for an enabled mode in practice).
export const resolveAggkitProxyBaseUrl = (
  aggkitBridgeApis: Record<number, string>
): string | undefined => Object.values(aggkitBridgeApis)[0];

export const fetchActivity = async (params: {
  baseUrl: string;
  fromAddress: string;
}): Promise<Transaction[]> => {
  const { baseUrl, fromAddress } = params;
  const url = new URL(`${baseUrl}/tracker/v1/activity/from/${fromAddress}`);
  // Always requested: tracking is what useBridgeTracking/TrackerProgressBar/
  // TrackerDetail now read straight off the Transaction (see
  // app/hooks/useBridgeTracking.ts), and it's also how READY_TO_CLAIM is
  // told apart from PENDING above.
  url.searchParams.set('includeTracking', 'true');

  const response = await fetch(url.toString());

  if (!response.ok) {
    const body: RawErrorData | undefined = await response.json().catch(() => undefined);
    throw new Error(body?.message ?? `ACTIVITY_FETCH_FAILED: ${response.status}`);
  }

  const raw: RawActivityResponse = await response.json();
  return raw.bridges.map(toTransaction);
};

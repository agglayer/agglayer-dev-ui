import type { Transaction, TransactionStatus } from '@/app/types/transaction';

import type {
  AggkitActivityBridge,
  AggkitActivityItem,
  AggkitActivityWarning,
  AggkitBridgeAggregator,
  AggkitTrackingData
} from '@agglayer/sdk';

// Thin wrapper over `AggkitBridgeAggregator.getActivity`, which itself wraps
// aggkit's bridgetracker GET {basePath}/activity/from/{from_address}
// (basePath "/tracker/v1"), see
// https://github.com/agglayer/aggkit/tree/feat/fix_bali_integration/bridgetracker/api/docs.
// Replaced the OLD AggkitBridgeAggregator.getActivity fan-out (4 REST calls
// x every configured L2 network, plus per-row status probes — see
// app/services/transactions.ts, now removed) with a single request: the
// bridgetracker service already scans every configured bridge service
// server-side and reports one unified, deduped list for the address. This
// module previously called that endpoint directly via `fetch` (see
// agglayer/agglayer-dev-ui#32's history) — it now goes through the SDK
// (agglayer/sdk#30/#31) instead of duplicating the request/parsing here,
// including the precision-safe `global_index` handling: the SDK quotes any
// bare 2^64-range JSON number before parsing (see `AggkitActivityBridge`'s
// doc in @agglayer/sdk), so this module no longer needs its own
// quotePrecisionUnsafeIntegers/parseActivityResponse.
//
// Trade-offs versus the old aggregator-based path (accepted per product
// decision, S-review 2026-08-28):
//  - No pagination: `bridges` is the address's entire history in one
//    response. useTransactions now paginates client-side over the full,
//    already-fetched array instead of requesting successive pages.
//  - Per-network partial-failure reporting is now a `warnings` array on the
//    response (added after this module's initial port), one entry per
//    upstream bridge service call that failed -- replaces the old
//    `failedNetworks` notice with a similar per-network_id shape. See
//    TransactionsView, which renders it as a dismissible warning icon
//    rather than blocking the rest of the list.
//  - Status collapses from 4 values (BRIDGED/LEAF_INCLUDED/READY_TO_CLAIM/
//    CLAIMED) to what this endpoint actually guarantees: a claimed tri-state
//    (`claimed`) plus, when `includeTracking=true`, the same step-based
//    tracking data the old per-row tracker poll used. See deriveStatus below
//    for exactly how PENDING/READY_TO_CLAIM/CLAIMED/ERROR are derived from
//    that pair.

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
  item: Pick<AggkitActivityItem, 'claimed' | 'tracking' | 'errors'>
): { status: TransactionStatus; statusError?: string } => {
  if (item.claimed === 'true') return { status: 'CLAIMED' };
  if (item.claimed === 'error') return { status: 'ERROR', statusError: item.errors?.claim };
  return { status: isWaitingOnClaimOnly(item.tracking) ? 'READY_TO_CLAIM' : 'PENDING' };
};

// leaf_type 1 is a message, 0 is an asset -- same convention
// types.ClaimResponse.is_message documents on the claim side.
const toLeafType = (leafType: number): string => (leafType === 1 ? 'message' : 'asset');

// The app's own per-row identity: React key in transactionList.tsx, the
// selected-row lookup in transactionsView.tsx, and the
// `tx.hubUID === claimingTxId` comparison that decides which row shows the
// live claim step (useClaimExecution stores `transaction.hubUID` as its
// `transactionId`). All three need a value that is unique per physical
// deposit and stable across polls.
//
// `bridge_hash` -- which this used to be -- is neither: it is a CONTENT hash
// over the deposit's fields (origin/destination network + address, amount,
// metadata), so every bridge of the same amount to the same receiver shares
// it. Confirmed live against the aggkit rc8 devnet, where a single
// bridge_hash covered 5 genuinely distinct deposits (different tx_hash,
// deposit_count 3..7, different block_num) all under the same
// bridge_network_id -- and the freshly-snapshotted devnet likewise reports
// two distinct L1 deposits (deposit_count 0 and 1, blocks 82 and 199) under
// one bridge_hash. Using it as the key produced React's "two children with
// the same key" warning and unstable row identity.
//
// `global_index` was rejected too, despite being aggkit's authoritative
// unique per-bridge id: the endpoint ships it as a bare JSON *number* around
// 2^64 (e.g. 18446744073709551616 / ...617 for deposit_count 0 / 1), far past
// Number.MAX_SAFE_INTEGER -- the SDK now re-quotes it before JSON.parse (see
// AggkitActivityBridge's doc), but the key stays tx_hash + deposit_count: it
// is unique without depending on the endpoint shipping global_index at all,
// and it is already what every consumer stores.
//
// `tx_hash` + `deposit_count` is unique and precision-safe: deposit_count is
// the bridge contract's own monotonic per-deposit counter, and pairing it
// with the transaction hash also keeps two deposits batched into one tx
// distinct.
const toHubUID = (bridge: AggkitActivityBridge): string => `${bridge.tx_hash}:${bridge.deposit_count}`;

export const toTransaction = (item: AggkitActivityItem): Transaction => {
  const { bridge, claim } = item;
  const { status, statusError } = deriveStatus(item);

  return {
    hubUID: toHubUID(bridge),
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
    // Always the exact decimal digits, never a JS number: buildClaimAssetParams
    // BigInt()s this straight into the claim's globalIndex argument. The SDK
    // already hands this back as a precision-safe string (re-quoted before
    // JSON.parse for the ~2^64 L1-origin values -- see AggkitActivityBridge's
    // doc), so no further conversion is needed here.
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

export interface ActivityResult {
  transactions: Transaction[];
  warnings: AggkitActivityWarning[];
}

export const fetchActivity = async (params: {
  aggregator: AggkitBridgeAggregator;
  fromAddress: string;
}): Promise<ActivityResult> => {
  const { aggregator, fromAddress } = params;
  // Always requested: tracking is what useBridgeTracking/TrackerProgressBar/
  // TrackerDetail now read straight off the Transaction (see
  // app/hooks/useBridgeTracking.ts), and it's also how READY_TO_CLAIM is
  // told apart from PENDING above.
  const result = await aggregator.getActivity({ fromAddress, includeTracking: true });

  // Every reported bridge becomes a row: the tracker already returns one
  // unified, server-side-deduped list per address, so there is nothing left
  // to dedupe here. In particular do NOT filter on bridge_hash -- it is a
  // content hash shared by every deposit of the same amount to the same
  // receiver, so dropping repeats silently loses real transactions (see
  // toHubUID above for the live evidence).
  return {
    transactions: result.bridges.map(toTransaction),
    warnings: result.warnings
  };
};

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
//  - Per-network partial-failure reporting is now a `warnings` array on the
//    response (added after this module's initial port), one entry per
//    upstream bridge service call that failed -- replaces the old
//    `failedNetworks` notice with a similar per-network_id shape. See
//    ActivityWarning below and TransactionsView, which renders it as a
//    dismissible warning icon rather than blocking the rest of the list.
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
  // Sent as a bare JSON *number*, NOT a string (verified against the live
  // aggkit rc8 devnet -- and note the asymmetry with RawClaim.global_index
  // below, which the same response quotes). For L1-origin deposits its value
  // is aggkit's mainnet-flagged index 2^64 + deposit_count, well past
  // Number.MAX_SAFE_INTEGER. parseActivityResponse below re-quotes any such
  // integer while the payload is still text, so what actually lands here is a
  // digit-exact string for large values and a number for small ones -- and a
  // string either way if aggkit ever starts quoting this field too. Never
  // `BigInt()` this off a raw `JSON.parse`; see parseActivityResponse.
  global_index: string | number;
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
  // A quoted decimal *string* here, unlike RawBridge.global_index above --
  // the same activity response really does send the two differently (verified
  // live: bridge -> 18446744073709551617, claim -> "18446744073709551617").
  // Being quoted already, it survives JSON.parse untouched; nothing reads it
  // today, and parseActivityResponse leaves quoted values alone.
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

// One upstream bridge service the bridgetracker fanned out to failed to
// respond for that network -- the rest of `bridges` may still be an
// incomplete picture for network_id. Surfaced as a warning icon in the UI
// (see TransactionsView) rather than an error, since the request as a whole
// still succeeded.
export interface ActivityWarning {
  network_id: number;
  message: string;
}

interface RawActivityResponse {
  bridges: RawActivityItem[];
  // Byte-array echo of the requested address (swagger: `type: array, items:
  // integer`) -- not the hex string we already have from the caller, so it's
  // never read here.
  from_address: number[];
  warnings?: ActivityWarning[];
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
// Number.MAX_SAFE_INTEGER, so a plain JSON.parse collapsed consecutive
// deposits onto the identical double -- it could not tell apart exactly the
// rows we need to tell apart. parseActivityResponse now preserves those
// digits, but the key stays tx_hash + deposit_count: it is unique without
// depending on the endpoint shipping global_index at all, and it is already
// what every consumer stores.
//
// `tx_hash` + `deposit_count` is unique and precision-safe: deposit_count is
// the bridge contract's own monotonic per-deposit counter, and pairing it
// with the transaction hash also keeps two deposits batched into one tx
// distinct.
const toHubUID = (bridge: RawBridge): string => `${bridge.tx_hash}:${bridge.deposit_count}`;

export const toTransaction = (item: RawActivityItem): Transaction => {
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
    // BigInt()s this straight into the claim's globalIndex argument, and the
    // wire value is a ~2^64 bare number for L1-origin deposits (see
    // RawBridge.global_index / parseActivityResponse).
    globalIndex: String(bridge.global_index),
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

// A JSON number literal, matched sticky from a known-safe offset (see
// quotePrecisionUnsafeIntegers -- never used to scan the payload blindly).
const JSON_NUMBER_LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// Rewrites every integer literal a double cannot hold exactly into a quoted
// string, leaving the rest of the payload byte-identical.
//
// This exists because the activity endpoint ships `global_index` as a bare
// JSON number whose L1-origin values are 2^64 + deposit_count (live rc8
// devnet: 18446744073709551617). `JSON.parse` rounds those to the nearest
// double, collapsing every consecutive L1 deposit onto the identical
// 18446744073709551616 -- so a manual claim of such a deposit would be built
// with a globalIndex short by exactly `deposit_count`. The digits cannot be
// recovered after the fact: by the time the parsed object exists they are
// already gone. They have to be captured while the payload is still text,
// which is what this does.
//
// Deliberately a whole-payload transform rather than a `global_index`-only
// pattern, so any future 64-bit field on this response is precision-safe by
// default -- and deliberately a scan that tracks string state (and escapes)
// rather than a `"key": <digits>` regex, which would also rewrite digits that
// merely appear inside a string value (e.g. a `warnings[].message` like
// "dial tcp 34.147.196.6:5577"). Values already quoted on the wire are left
// untouched, so a deployment that sends `global_index` as a string behaves
// identically.
export const quotePrecisionUnsafeIntegers = (json: string): string => {
  let out = '';
  // Everything before this offset has already been copied into `out`. Only
  // the spans around an actual rewrite are ever copied, so a payload with no
  // unsafe integer is returned as-is rather than rebuilt character by
  // character (this runs over the address's whole history on every poll).
  let copiedUpTo = 0;
  let index = 0;
  let inString = false;

  while (index < json.length) {
    const char = json[index];

    if (inString) {
      // A backslash escapes the next character, quotes included.
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }

    // Outside a string, a number literal can only start here.
    if (char === '-' || (char >= '0' && char <= '9')) {
      JSON_NUMBER_LITERAL.lastIndex = index;
      const literal = JSON_NUMBER_LITERAL.exec(json)?.[0];
      if (literal !== undefined) {
        // Only a plain integer can be re-read losslessly from its digits;
        // anything with a fraction or exponent is passed through as sent.
        const isPlainInteger = !/[.eE]/.test(literal);
        if (isPlainInteger && !Number.isSafeInteger(Number(literal))) {
          out += `${json.slice(copiedUpTo, index)}"${literal}"`;
          copiedUpTo = index + literal.length;
        }
        index += literal.length;
        continue;
      }
    }

    index += 1;
  }

  return copiedUpTo === 0 ? json : out + json.slice(copiedUpTo);
};

// Parse the activity response from its raw text -- NOT via `response.json()`,
// which would round `global_index` past repair (see above).
export const parseActivityResponse = (json: string): RawActivityResponse =>
  JSON.parse(quotePrecisionUnsafeIntegers(json)) as RawActivityResponse;

export interface ActivityResult {
  transactions: Transaction[];
  warnings: ActivityWarning[];
}

export const fetchActivity = async (params: {
  baseUrl: string;
  fromAddress: string;
}): Promise<ActivityResult> => {
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

  // response.text(), then parseActivityResponse: `response.json()` here would
  // silently destroy every L1-origin `global_index` (see above).
  const raw = parseActivityResponse(await response.text());

  // Every reported bridge becomes a row: the tracker already returns one
  // unified, server-side-deduped list per address, so there is nothing left
  // to dedupe here. In particular do NOT filter on bridge_hash -- it is a
  // content hash shared by every deposit of the same amount to the same
  // receiver, so dropping repeats silently loses real transactions (see
  // toHubUID above for the live evidence).
  return {
    transactions: raw.bridges.map(toTransaction),
    warnings: raw.warnings ?? []
  };
};

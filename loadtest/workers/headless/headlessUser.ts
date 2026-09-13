// The headless `UserDriver` — DESIGN §9 UI call-set parity. Implements
// `loadtest/core/userDriver.ts`'s `UserDriver` verbatim, using a viem
// `WalletClient` for signing/sending and the PINNED `@agglayer/sdk` (from
// `node_modules`, never `../sdk`) for every build/read call the UI itself
// makes.
//
// Reused rather than re-derived (do not duplicate their logic elsewhere):
//  - `app/utils/transaction.ts`'s `mapTransactionRequest` — the exact
//    {to,data,value} projection that DROPS the SDK's `gas`/`nonce`
//    (finding C4), which is what makes viem's `prepareTransactionRequest`
//    re-derive both on every send, in both browser and headless mode.
//  - `app/services/claimProof.ts`'s `toClaimProof`.
//  - `loadtest/workers/headless/uiCallset.ts`'s cadence/cache/classifier/
//    fetch-wrapper helpers.
//  - `loadtest/wallets/chainClients.ts`'s `defaultChainClientFactory`.
//  - `loadtest/metrics/errors.ts`'s classifiers, so a `DriverError` always
//    carries an `errorClass` `ring.ts` can trust instead of falling back to
//    its own prose-only rule (note N7).
//
// This module reports raw facts and timings; it never calls
// `collector.recordPhase`/`hopState`/`txSent`/... — `ring.ts` (via the
// runner) owns every transition and timeout, per `core/userDriver.ts`'s
// module doc. The ONLY collector method this file calls directly is
// `recordHttpSample`, and only indirectly, through the installed timing
// fetch wrapper (`uiCallset.ts`'s `installTimingFetch`).
import type {
  Address,
  Chain,
  Hex,
  LocalAccount,
  PublicClient,
  Transport,
  WalletClient
} from 'viem';

import { decodeEventLog, parseAbiItem, parseUnits } from 'viem';

import type {
  AggkitBridgeAggregator as AggkitBridgeAggregatorType,
  ClaimAssetParams,
  TransactionParams
} from '@agglayer/sdk';

import { AggkitBridgeAggregator, AggLayerSDK, SDK_MODES } from '@agglayer/sdk';

import type { LoadtestAsset, LoadtestChain } from '../../config/schema';
import type { HopSpec, ObservedRow } from '../../core/types';
import type {
  AllowanceRead,
  BridgeSubmission,
  ClaimInputsResult,
  ClaimSubmission,
  DriverError,
  HopReadState,
  StepTiming,
  TxStepResult,
  UserDriver
} from '../../core/userDriver';
import type { Collector } from '../../metrics/collector';
import type { ActivityCadenceState } from './uiCallset';

import { toClaimProof } from '../../../app/services/claimProof';
import { mapTransactionRequest } from '../../../app/utils/transaction';
import { toRowKey } from '../../core/types';
import { classifyHttpError, classifyRpcError, classifySubmitError } from '../../metrics/errors';
import { defaultChainClientFactory } from '../../wallets/chainClients';
import { redactSecrets } from '../../wallets/redact';
import {
  IS_CLAIMED_RECHECK_DELAYS_MS,
  anyRowNonTerminal,
  initialActivityCadenceState,
  mapActivityResponseText,
  noteActivityFetched,
  noteBridgeSubmitted,
  nextActivityFetchDelayMs,
  runWithFetchContext,
  SingleFlightPoller,
  sleep,
  TokenAddressResolver,
  TtlCache
} from './uiCallset';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// The bridge contract's `BridgeEvent` — see agglayer-contracts' AgglayerBridge
// and the sibling sdk repo's `src/native/bridge/abi/bridge.ts` (read-only
// reference; not imported — the pinned package doesn't export its ABIs).
// Decoded straight off a receipt's logs we already fetched, so this costs
// NO extra RPC call, matching T9's "scan ALL receipt logs" note.
const BRIDGE_EVENT_ABI = [
  parseAbiItem(
    'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)'
  )
];

interface DecodedBridgeEvent {
  originNetwork: number;
  originAddress: Address;
  destinationNetwork: number;
  destinationAddress: Address;
  amount: bigint;
  metadata: Hex;
  depositCount: number;
}

interface DepositInfo {
  amount: bigint;
  metadata: Hex;
  originNetwork: number;
  originTokenAddress: Address;
  destinationNetwork: number;
  destinationAddress: Address;
}

interface ChainRuntime {
  chain: LoadtestChain;
  public: PublicClient;
  wallet: WalletClient<Transport, Chain, LocalAccount>;
}

type AggNative = ReturnType<AggLayerSDK['getNative']>;
type BridgeHandle = ReturnType<AggNative['bridge']>;

const toSdkChainConfig = (chain: LoadtestChain) => ({
  chainId: chain.chainId,
  networkId: chain.networkId,
  name: chain.key,
  rpcUrl: chain.rpcUrl,
  nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
  bridgeAddress: chain.bridgeAddress
});

const messageOf = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const anyErr = error as { shortMessage?: unknown; details?: unknown; message?: unknown };
    if (typeof anyErr.shortMessage === 'string') return anyErr.shortMessage;
    if (typeof anyErr.details === 'string') return anyErr.details;
    if (typeof anyErr.message === 'string') return anyErr.message;
  }
  return String(error);
};

export interface HeadlessUserOptions {
  userId: string;
  account: LocalAccount;
  /** The ring's chains — S11 passes `config.chains`; only the ones a hop actually references are ever touched. */
  chains: readonly LoadtestChain[];
  /**
   * S08 retry — tool-defect fix: `config.assets`, so `hop.assetIndex` can be
   * resolved to the asset's `originNetworkId`. A configured erc20 asset's
   * `address` is always the ORIGIN chain's address (config/schema.ts
   * convention); on any other chain the token exists only as a wrapped
   * ERC20 at a different, precalculated address. See
   * `resolveTokenAddress()`. Optional/defaults to `[]` for callers (and
   * existing unit tests) that only ever bridge on a single chain, where the
   * configured address is already correct as-is.
   */
  assets?: readonly LoadtestAsset[];
  aggkitProxyUrl: string;
  /** DESIGN §9.4/finding C5 — headless-only, applied to the bridge send only. */
  bridgeGasOffset: number;
  collector: Collector;
  clock?: { now(): number };
  /**
   * DESIGN finding C6: browser mode seeds the devnet ERC20 as a custom
   * token via `seedCustomToken`, which means the UI's `token-mappings`
   * `enabled` guard (`!isNative && !localToken`) never fires for it — ZERO
   * `token-mappings`/`getTokenMetadata` calls. Default `true` mirrors that
   * (the documented default, DESIGN §9.3 C6) — there is no
   * `headless.seedTokenList` config field yet (out of S08's scope; see the
   * S08 feedback pack), so this constructor option is the only knob.
   */
  seedTokenList?: boolean;
  /**
   * R4 (loadtest/REVIEW.md): `sendAndWait`'s receipt wait used to call
   * `waitForTransactionReceipt({ hash })` with no `timeout`, so it fell
   * back to viem's own default of 180 000ms — THREE TIMES
   * `timeouts.txReceiptMs`'s devnet default (60 000ms). `ring.ts` declares
   * the hop failed (`timeout_bridge_receipt` etc.) at `txReceiptMs`, but
   * the abandoned viem poller (`runner.ts`'s `raceOrTimeout` documents
   * itself as abandoning, not cancelling) kept issuing
   * `eth_getTransactionReceipt` for up to 120 000ms AFTER that — and every
   * one of those was still recorded (the fetch-context/timing-fetch
   * wrapper installed for this user's whole lifetime), inflating the
   * endpoint tables with traffic from a hop the same report declares
   * failed. Bounding viem's own wait to the SAME budget `ring.ts` uses
   * shrinks that window from 3x to 1x. Optional so a caller/test that
   * omits it is unaffected (falls back to viem's 180 000ms default, same
   * as before).
   */
  receiptTimeoutMs?: number;
}

/**
 * Headless `UserDriver` — viem `WalletClient` + the pinned `@agglayer/sdk`.
 * One instance per simulated user; `init()` constructs its own SDK/viem
 * clients so nothing is shared across users (matching one wallet per
 * context in browser mode).
 */
export class HeadlessUser implements UserDriver {
  readonly userId: string;
  readonly mode = 'headless' as const;
  readonly address: Address;

  private readonly account: LocalAccount;
  private readonly chains: readonly LoadtestChain[];
  private readonly assets: readonly LoadtestAsset[];
  private readonly aggkitProxyUrl: string;
  private readonly bridgeGasOffset: number;
  private readonly collector: Collector;
  private readonly clock: { now(): number };
  private readonly seedTokenList: boolean;
  /** R4 — see `HeadlessUserOptions.receiptTimeoutMs`'s doc. */
  private readonly receiptTimeoutMs?: number;

  private chainsByKey = new Map<string, LoadtestChain>();
  private runtimes = new Map<string, ChainRuntime>();
  private native!: AggNative;
  private aggregator!: AggkitBridgeAggregatorType;

  // P7/P8/P9 caches — see uiCallset.ts's TtlCache doc.
  private readonly balanceCache = new TtlCache<string>(15_000);
  private readonly gasPriceCache = new TtlCache<bigint>(15_000);
  private readonly allowanceCache = new TtlCache<string>(Number.POSITIVE_INFINITY);
  // S08 retry #2 — three-tier per-chain resolution. See
  // `resolveTokenAddress()`'s doc and `uiCallset.ts`'s `TokenAddressResolver`.
  //
  // Tier 2, `lookupTokenMappings`: `GET
  // {aggkitProxyUrl}/bridge/v1/token-mappings?network_id={chain.networkId}
  // &origin_token_address={originAddress}` via the pinned SDK's
  // `AggkitBridgeAggregator.clientFor(chain.networkId).getTokenMappings`
  // (the aggregator itself has no top-level `getTokenMappings` — only its
  // per-network `AggkitBridgeClient`s do). This is the same UI-parity
  // source row P6's `token-mappings` lookup implies. `chain.networkId` is
  // never 0 at this call site (Tier 1 in `TokenAddressResolver.resolve`
  // already short-circuits the origin network), so `clientFor` never needs
  // the aggregator's L1-routing fallback here.
  //
  // Tier 3, `lookupWrapped`: `getWrappedTokenAddress` (on-chain
  // `getTokenWrappedAddress`, a plain `tokenInfoToWrappedToken` mapping
  // lookup), NOT `getPrecalculatedWrapperAddress`
  // (`precalculatedWrapperAddress`, the deterministic CREATE2 address
  // computed BEFORE a wrapped token is ever deployed) — the two differ on
  // this devnet's deployed bridge contract: `precalculatedWrapperAddress`
  // reverts with no reason (`execution reverted`, empty return data),
  // confirmed live during the S08 retry #1 run. `getTokenWrappedAddress`
  // returns the zero address instead of reverting when no wrapper is
  // deployed yet (a plain mapping default), which `TokenAddressResolver`
  // reads as "not ready yet, don't cache" rather than an error — this is
  // what makes it safe to call as an immediate, indexer-lag-free fallback
  // right after an inbound claim lands, before aggkit's token-mappings
  // indexer has necessarily caught up.
  private readonly tokenAddressResolver = new TokenAddressResolver({
    lookupTokenMappings: async (_originNetworkId, originAddress, chain) => {
      const result = await this.aggregator
        .clientFor(chain.networkId)
        .getTokenMappings({ networkId: chain.networkId, originTokenAddress: originAddress });
      return result.token_mappings[0]?.wrapped_token_address ?? null;
    },
    lookupWrapped: (originNetworkId, originAddress, chain) =>
      this.native.bridge(chain.bridgeAddress as Address, chain.chainId).getWrappedTokenAddress({
        originNetwork: originNetworkId,
        originTokenAddress: originAddress
      })
  });
  // P6, staleTime 5 min — only ever populated when `seedTokenList` is
  // explicitly turned off (see maybeFetchTokenMetadata below).
  private readonly tokenMetadataCache = new TtlCache<unknown>(5 * 60 * 1000);

  // P1 cadence state — one stream per user (the driver models "the
  // transactions page is always open").
  private cadence: ActivityCadenceState = initialActivityCadenceState;

  // S16/A6 (VALIDATION-1.md): dedupes concurrent `observeActivity()` callers
  // (up to `maxInflightLapsPerUser` in-flight laps for this same user) onto
  // ONE real fetch per cadence interval — see `uiCallset.ts`'s
  // `SingleFlightPoller` doc for the full diagnosis. No `isFatal` predicate:
  // unlike browser mode's page/context crashes, a headless fetch failure has
  // no "don't bother retrying, the whole session is gone" case — every
  // failure here is a plain network/HTTP error, so the default (always
  // retryable, bounded to 3 attempts) is the right behaviour.
  private readonly activityPoller = new SingleFlightPoller<ObservedRow[]>();

  // Populated by bridge() when it decodes a BridgeEvent; consumed by
  // claim() to build ClaimAssetParams. `ObservedRow` (core/types.ts) does
  // NOT carry amount/metadata/originTokenAddress — the UI gets those from
  // the raw activity response's `bridge.*` fields, which this driver's own
  // bridge() already observed once when it submitted the deposit. Keyed by
  // the same `tx_hash:deposit_count` rowKey the ring uses, so a later
  // claim() call for the same hop can look itself up.
  private readonly depositInfo = new Map<string, DepositInfo>();

  constructor(options: HeadlessUserOptions) {
    this.userId = options.userId;
    this.account = options.account;
    this.address = options.account.address;
    this.chains = options.chains;
    this.assets = options.assets ?? [];
    this.aggkitProxyUrl = options.aggkitProxyUrl.replace(/\/$/, '');
    this.bridgeGasOffset = options.bridgeGasOffset;
    this.collector = options.collector;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.seedTokenList = options.seedTokenList ?? true;
    this.receiptTimeoutMs = options.receiptTimeoutMs;
  }

  async init(): Promise<void> {
    this.chainsByKey = new Map(this.chains.map((chain) => [chain.key, chain]));

    const sdk = new AggLayerSDK({
      mode: [SDK_MODES.NATIVE],
      native: {
        defaultNetwork: this.chains[0]?.chainId,
        chains: this.chains.map(toSdkChainConfig)
      }
    });
    this.native = sdk.getNative();

    const networks: Record<number, string> = {};
    for (const chain of this.chains) {
      if (chain.networkId !== 0) networks[chain.networkId] = this.aggkitProxyUrl;
    }
    this.aggregator = new AggkitBridgeAggregator({ networks });

    this.runtimes = new Map(
      this.chains.map((chain) => {
        const clientSet = defaultChainClientFactory(chain);
        return [
          chain.key,
          { chain, public: clientSet.public, wallet: clientSet.wallet(this.account) }
        ];
      })
    );
  }

  // -------------------------------------------------------------------------
  // bridge() — DESIGN P7, P8, P9 (pre-flight reads), P10-P13 (approve +
  // bridge builds/sends), finding C8 (ERC20.bridgeTo), finding C5
  // (headless-only bridgeGasOffset on the bridge send only).
  // -------------------------------------------------------------------------
  async bridge(hop: HopSpec): Promise<BridgeSubmission> {
    return runWithFetchContext({ userId: this.userId, mode: this.mode }, async () => {
      const fromChain = this.chainByKey(hop.fromChainKey);
      const toChain = this.chainByKey(hop.toChainKey);
      const isNative = hop.assetKind === 'eth';
      const amountWei = parseUnits(hop.amount, hop.decimals);

      // P8: eth_gasPrice, 15s cache, display-only — the UI's shown fee uses
      // hardcoded gas units, never this value, but the call itself is part
      // of the wire load.
      await this.gasPriceCache.get(
        fromChain.key,
        () => this.chainRuntime(fromChain.key).public.getGasPrice(),
        this.clock.now()
      );

      // S08 retry — tool-defect fix: resolve the ERC20 address to actually
      // use ON `fromChain` (origin address vs wrapped address —
      // `resolveTokenAddress`'s doc) BEFORE any balance/allowance/approve/
      // bridge call touches it. Not one of DESIGN §9.1's P-rows — the UI
      // never performs this resolution itself (see the S08 feedback pack) —
      // so it's a headless-only addition, cached indefinitely per chain.
      const fromTokenAddress = isNative
        ? undefined
        : await this.resolveTokenAddress(hop, fromChain);

      // P7: balance read, 15s cache, no refetch-on-mount.
      await this.balanceCache.get(
        `${fromChain.key}:${isNative ? 'native' : fromTokenAddress}`,
        () =>
          isNative
            ? this.native.getNativeBalance(this.address, fromChain.chainId)
            : this.native
                .erc20(fromTokenAddress as Address, fromChain.chainId)
                .getBalance(this.address),
        this.clock.now()
      );

      let allowance: AllowanceRead | null = null;
      let approve: TxStepResult | null = null;

      if (!isNative) {
        const tokenAddress = fromTokenAddress as Address;
        const allowanceStartedAt = this.clock.now();
        // P9: keyed including the amount string — a fresh cache entry (and
        // a fresh call) per distinct amount, cached indefinitely otherwise.
        const allowanceWei = await this.allowanceCache.get(
          `${fromChain.key}:${tokenAddress}:${fromChain.bridgeAddress}:${amountWei.toString()}`,
          () =>
            this.native
              .erc20(tokenAddress, fromChain.chainId)
              .getAllowance(this.address, fromChain.bridgeAddress),
          this.clock.now()
        );
        const sufficient = BigInt(allowanceWei) >= amountWei;
        allowance = {
          sufficient,
          timing: {
            startedAt: allowanceStartedAt,
            durationMs: this.clock.now() - allowanceStartedAt
          }
        };

        if (!sufficient) {
          const approveParams = await this.native
            .erc20(tokenAddress, fromChain.chainId)
            .buildApprove(fromChain.bridgeAddress, amountWei.toString(), this.address);
          const { step } = await this.sendAndWait(fromChain.key, approveParams);
          approve = step;
          if (approve.error || approve.receipt?.status !== 'success') {
            return {
              allowance,
              approve,
              bridge: null,
              depositCount: null,
              bridgeEventFound: false
            };
          }
        }
      }

      let bridgeTxParams: TransactionParams;
      if (isNative) {
        bridgeTxParams = await this.native
          .bridge(fromChain.bridgeAddress, fromChain.chainId)
          .buildBridgeAsset(
            {
              destinationNetwork: toChain.networkId,
              destinationAddress: this.address,
              amount: amountWei.toString(),
              token: ZERO_ADDRESS,
              forceUpdateGlobalExitRoot: true
            },
            this.address
          );
      } else {
        // Finding C8: the ERC20 path goes through `ERC20.bridgeTo`, which
        // wraps `buildBridgeAsset` with `permitData: '0x'` — never
        // `Bridge.buildBridgeAsset` directly. Uses the per-chain resolved
        // address (`fromTokenAddress`), not the raw configured/origin one.
        const tokenAddress = fromTokenAddress as Address;
        bridgeTxParams = await this.native
          .erc20(tokenAddress, fromChain.chainId)
          .bridgeTo(toChain.networkId, this.address, amountWei.toString(), this.address, {
            forceUpdateGlobalExitRoot: true
          });
      }

      // Finding C5 / DESIGN §9.4: the ONE permitted behavioural divergence
      // from the UI — applied only to the bridge send. Because we now pass
      // `gas` explicitly, viem's `prepareTransactionRequest` will not
      // re-derive it for this particular send (it still re-derives `nonce`
      // and fee fields, same as every other build) — see the S08 feedback
      // pack for what this means for P11's RPC-count parity on this one
      // step.
      const gasOverride =
        bridgeTxParams.gas !== undefined
          ? BigInt(bridgeTxParams.gas) + BigInt(this.bridgeGasOffset)
          : undefined;

      const { step: bridgeStep, rawReceipt } = await this.sendAndWait(
        fromChain.key,
        bridgeTxParams,
        {
          gasOverride
        }
      );

      this.cadence = noteBridgeSubmitted(this.cadence, this.clock.now());

      if (
        bridgeStep.error ||
        bridgeStep.receipt?.status !== 'success' ||
        bridgeStep.txHash === null ||
        !rawReceipt
      ) {
        return {
          allowance,
          approve,
          bridge: bridgeStep,
          depositCount: null,
          bridgeEventFound: false
        };
      }

      const decoded = this.decodeBridgeEvent(fromChain.bridgeAddress as Address, rawReceipt.logs);
      if (decoded) {
        this.depositInfo.set(toRowKey(bridgeStep.txHash, decoded.depositCount), {
          amount: decoded.amount,
          metadata: decoded.metadata,
          originNetwork: decoded.originNetwork,
          originTokenAddress: decoded.originAddress,
          destinationNetwork: decoded.destinationNetwork,
          destinationAddress: decoded.destinationAddress
        });
      }

      return {
        allowance,
        approve,
        bridge: bridgeStep,
        depositCount: decoded?.depositCount ?? null,
        bridgeEventFound: decoded !== null
      };
    });
  }

  // -------------------------------------------------------------------------
  // observeActivity() — DESIGN P1, findings C1/C2 (cadence), §9.2 (text
  // parse + big-int-safe global_index, row identity, client-side
  // READY_TO_CLAIM derivation), finding C13 (per-network warnings).
  //
  // S16/A6 (VALIDATION-1.md): delegates the cadence-check-then-fetch to
  // `activityPoller` (`uiCallset.ts`'s `SingleFlightPoller`) so concurrent
  // callers (this same user's other in-flight laps) dedupe onto ONE real
  // fetch instead of all sleeping the same computed delay and firing
  // together — see that class's doc for the full diagnosis. The actual
  // fetch body is unchanged, just moved into `performActivityFetch` so it
  // can be the poller's `fetchFn`.
  // -------------------------------------------------------------------------
  async observeActivity(): Promise<ObservedRow[]> {
    return runWithFetchContext({ userId: this.userId, mode: this.mode }, () =>
      this.activityPoller.run(
        () => nextActivityFetchDelayMs(this.cadence, this.clock.now()),
        () => this.performActivityFetch()
      )
    );
  }

  /** Issues THIS driver's own single real `tracker/activity` fetch. Never call directly — go through `observeActivity()`/`activityPoller` so concurrent/rapid callers dedupe onto one call. */
  private async performActivityFetch(): Promise<ObservedRow[]> {
    const url = new URL(`${this.aggkitProxyUrl}/tracker/v1/activity/from/${this.address}`);
    url.searchParams.set('includeTracking', 'true');

    const fetchedAt = this.clock.now();
    const response = await fetch(url.toString());
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const classified = classifyHttpError({
        endpointClass: 'tracker/activity',
        status: response.status,
        bodyText
      });
      throw new Error(classified.message);
    }

    // DESIGN §9.2: text, then the big-int-safe parse — NEVER response.json().
    const text = await response.text();
    const { rows, warnings } = mapActivityResponseText(text);

    // Finding C13: per-network warnings are a partial-fanout signal, not
    // silence — recorded so a broken upstream bridge service is visible
    // rather than looking like "no rows for that network".
    for (const warning of warnings) {
      this.collector.error({
        userId: this.userId,
        mode: this.mode,
        errorClass: 'proxy_5xx',
        message: redactSecrets(
          `activity_warning[network_id=${warning.network_id}]: ${warning.message}`
        ),
        endpointClass: 'tracker/activity'
      });
    }

    this.cadence = noteActivityFetched(this.cadence, fetchedAt, anyRowNonTerminal(rows));
    await this.maybeFetchTokenMetadata(rows);
    return rows;
  }

  /**
   * DESIGN findings C6/C7: `token-mappings` (+ `ERC20.getMetadata()`'s 3-4
   * extra `eth_call`s) is gated on `!isNative && !localToken`. This driver
   * defaults to `seedTokenList: true` (mirrors browser mode's
   * `seedCustomToken`, so — matching the UI — zero calls). When a caller
   * explicitly opts out, best-effort fetch metadata for every non-native
   * row this driver has deposit info for (rows it bridged itself), 5-minute
   * cache. Failures are swallowed — this is exactly what the UI's `retry: 1`
   * plus render-time silence effectively does from the user's perspective.
   */
  private async maybeFetchTokenMetadata(rows: readonly ObservedRow[]): Promise<void> {
    if (this.seedTokenList) return;
    for (const row of rows) {
      const info = this.depositInfo.get(row.rowKey);
      if (!info || info.originTokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) continue;
      const cacheKey = `${row.destinationNetwork}:${info.originTokenAddress.toLowerCase()}`;
      await this.tokenMetadataCache
        .get(
          cacheKey,
          () => this.aggregator.getTokenMetadata(info.originTokenAddress, row.destinationNetwork),
          this.clock.now()
        )
        .catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // claim() — DESIGN P2-P5, P14, finding C3 (post-throw/post-revert retry
  // loop). Order mirrors app/hooks/useClaimExecution.ts exactly: isClaimed
  // -> getClaimInputs -> buildClaimAsset -> send -> receipt.
  // -------------------------------------------------------------------------
  async claim(hop: HopSpec, row: ObservedRow): Promise<ClaimSubmission> {
    return runWithFetchContext({ userId: this.userId, mode: this.mode }, async () => {
      const toChain = this.chainByKey(hop.toChainKey);
      const bridge = this.native.bridge(toChain.bridgeAddress, toChain.chainId);

      const isClaimedStartedAt = this.clock.now();
      const isClaimedBefore = await bridge.isClaimed({
        leafIndex: row.depositCount,
        sourceBridgeNetwork: row.sourceNetwork
      });
      const isClaimedTiming: StepTiming = {
        startedAt: isClaimedStartedAt,
        durationMs: this.clock.now() - isClaimedStartedAt
      };

      if (isClaimedBefore) {
        return {
          isClaimedBefore,
          isClaimedTiming,
          claimInputs: null,
          claim: null,
          isClaimedRecheck: null
        };
      }

      const claimInputsStartedAt = this.clock.now();
      // recordingNetworkId is the SOURCE network (transaction.sourceNetwork
      // in UI terms) — NEVER the asset's origin network. `row.sourceNetwork`
      // is exactly that (activity.ts's `bridge_network_id`).
      const result = await this.aggregator.getClaimInputs({
        recordingNetworkId: row.sourceNetwork,
        destinationNetworkId: row.destinationNetwork,
        depositCount: row.depositCount
      });
      const claimInputsTiming: StepTiming = {
        startedAt: claimInputsStartedAt,
        durationMs: this.clock.now() - claimInputsStartedAt
      };

      if (!result.claimable) {
        const claimInputs: ClaimInputsResult = {
          claimable: false,
          reason: result.reason,
          timing: claimInputsTiming
        };
        return {
          isClaimedBefore,
          isClaimedTiming,
          claimInputs,
          claim: null,
          isClaimedRecheck: null
        };
      }

      const claimInputs: ClaimInputsResult = { claimable: true, timing: claimInputsTiming };

      const depositInfo = this.depositInfo.get(row.rowKey);
      const missingContextError = (message: string): ClaimSubmission => ({
        isClaimedBefore,
        isClaimedTiming,
        claimInputs,
        claim: {
          txHash: null,
          submit: { startedAt: this.clock.now(), durationMs: 0 },
          receipt: null,
          error: { message, errorClass: 'internal' }
        },
        isClaimedRecheck: null
      });

      if (!depositInfo) {
        return missingContextError(
          `headless driver has no cached deposit info for rowKey "${row.rowKey}" — claim() was called without this driver having bridged that deposit itself in this process (see the S08 feedback pack's note on stateful claim bookkeeping)`
        );
      }
      if (row.globalIndex === undefined) {
        // Mirrors app/utils/transaction.ts's buildClaimAssetParams guard.
        return missingContextError('Transaction is missing globalIndex');
      }

      const proof = toClaimProof(result.proof);
      const claimParams: ClaimAssetParams = {
        smtProofLocalExitRoot: proof.proof_local_exit_root,
        smtProofRollupExitRoot: proof.proof_rollup_exit_root,
        globalIndex: BigInt(row.globalIndex),
        mainnetExitRoot: proof.l1_info_tree_leaf.mainnet_exit_root,
        rollupExitRoot: proof.l1_info_tree_leaf.rollup_exit_root,
        originNetwork: depositInfo.originNetwork,
        originTokenAddress: depositInfo.originTokenAddress,
        destinationNetwork: depositInfo.destinationNetwork,
        destinationAddress: depositInfo.destinationAddress,
        amount: depositInfo.amount,
        metadata: depositInfo.metadata
      };

      const claimTxParams = await bridge.buildClaimAsset(claimParams, this.address);
      const { step: claimStep } = await this.sendAndWait(toChain.key, claimTxParams);

      // Finding C3: the post-throw retry loop. Also applied, defensively,
      // to a mined-but-reverted receipt (DESIGN T24/T25) — the live UI only
      // ever exercises the throw path (a doomed claim reverts during
      // pre-flight gas estimation, before broadcast, so `sendTransaction`
      // throws and `waitForTransactionReceipt` is never reached with a
      // reverted status in practice) but `ring.ts`'s own transition table
      // plans for both, and reusing one retry helper for both is the least
      // surprising reading — see the S08 feedback pack.
      let isClaimedRecheck: boolean | null = null;
      if (claimStep.error !== undefined || claimStep.receipt?.status === 'reverted') {
        isClaimedRecheck = await this.isClaimedRetryLoop(bridge, row);
      }

      return { isClaimedBefore, isClaimedTiming, claimInputs, claim: claimStep, isClaimedRecheck };
    });
  }

  // -------------------------------------------------------------------------
  // readState() — the two idempotent reads DESIGN's resumability rule needs.
  // -------------------------------------------------------------------------
  async readState(hop: HopSpec, row: ObservedRow | null): Promise<HopReadState> {
    return runWithFetchContext({ userId: this.userId, mode: this.mode }, async () => {
      let allowanceSufficient: boolean | null = null;
      if (hop.assetKind === 'erc20') {
        const fromChain = this.chainByKey(hop.fromChainKey);
        const tokenAddress = await this.resolveTokenAddress(hop, fromChain);
        const amountWei = parseUnits(hop.amount, hop.decimals);
        const allowanceWei = await this.native
          .erc20(tokenAddress, fromChain.chainId)
          .getAllowance(this.address, fromChain.bridgeAddress);
        allowanceSufficient = BigInt(allowanceWei) >= amountWei;
      }

      let isClaimed = false;
      if (row !== null) {
        const toChain = this.chainByKey(hop.toChainKey);
        isClaimed = await this.native
          .bridge(toChain.bridgeAddress, toChain.chainId)
          .isClaimed({ leafIndex: row.depositCount, sourceBridgeNetwork: row.sourceNetwork })
          .catch(() => false);
      }

      return { allowanceSufficient, isClaimed };
    });
  }

  async dispose(): Promise<void> {
    // No browser/context to release — present for UserDriver parity.
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private chainByKey(key: string): LoadtestChain {
    const chain = this.chainsByKey.get(key);
    if (!chain) throw new Error(`headless driver: unknown chain key "${key}"`);
    return chain;
  }

  private chainRuntime(key: string): ChainRuntime {
    const runtime = this.runtimes.get(key);
    if (!runtime)
      throw new Error(`headless driver: chain "${key}" was not initialized (call init() first)`);
    return runtime;
  }

  /**
   * S08 retry — tool-defect fix: an ERC20 asset's configured `address` is
   * always the ORIGIN chain's address (config/schema.ts's `originNetworkId`
   * convention). Attempt #1 read that address on every chain, which crashed
   * `balanceOf` on a non-origin chain where the token exists only as a
   * *wrapped* ERC20 at a different, precalculated address
   * (`ContractFunctionExecutionError: ... returned no data ("0x")`).
   * Resolve the address to actually use for balance reads, `allowance`,
   * `approve` and the bridge call on `chain`: the origin address when
   * `chain` IS the asset's origin network, else the wrapped address via the
   * pinned SDK's `getWrappedTokenAddress` (this is the same mapping UI
   * parity row P6's `token-mappings` lookup implies, though the UI never
   * actually performs this resolution itself — see the S08 feedback pack).
   * Cached indefinitely (see `tokenAddressResolver`'s doc, incl. why
   * `getWrappedTokenAddress` and not `getPrecalculatedWrapperAddress`).
   *
   * When `this.assets` doesn't carry an `originNetworkId` for this hop's
   * asset (e.g. a unit test constructing the driver without `assets`, or a
   * caller that only ever bridges a single chain), falls back to the
   * configured address unresolved — the pre-fix behaviour — rather than
   * guessing.
   */
  private async resolveTokenAddress(hop: HopSpec, chain: LoadtestChain): Promise<Address> {
    const originAddress = hop.assetAddress as Address;
    const originNetworkId = this.assets[hop.assetIndex]?.originNetworkId;
    const resolved = await this.tokenAddressResolver.resolve(originAddress, originNetworkId, chain);
    return resolved as Address;
  }

  /**
   * Send-and-wait for one build's `TransactionParams` — DESIGN finding C4:
   * `mapTransactionRequest` strips the SDK's own `gas`/`nonce` (P10's pair),
   * so viem's `prepareTransactionRequest` re-derives BOTH via a second
   * `eth_estimateGas` + `eth_getTransactionCount` (P11) plus fee derivation
   * (P12), unless `opts.gasOverride` is supplied (bridge only, finding C5).
   */
  private async sendAndWait(
    chainKey: string,
    txParams: TransactionParams,
    opts: { gasOverride?: bigint } = {}
  ): Promise<{
    step: TxStepResult;
    rawReceipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>> | null;
  }> {
    const runtime = this.chainRuntime(chainKey);
    const mapped = mapTransactionRequest(txParams);
    const submitStartedAt = this.clock.now();

    let txHash: Hex | null = null;
    try {
      txHash = await runtime.wallet.sendTransaction({
        to: mapped.to,
        data: mapped.data,
        value: mapped.value,
        ...(opts.gasOverride !== undefined ? { gas: opts.gasOverride } : {})
      });
    } catch (error) {
      const classified = classifySubmitError({ message: messageOf(error) });
      return {
        step: {
          txHash: null,
          submit: { startedAt: submitStartedAt, durationMs: this.clock.now() - submitStartedAt },
          receipt: null,
          error: classified
        },
        rawReceipt: null
      };
    }

    const submitDurationMs = this.clock.now() - submitStartedAt;
    const receiptStartedAt = this.clock.now();
    try {
      // R4: bound viem's own wait to the SAME budget `ring.ts` enforces via
      // `raceOrTimeout`, rather than falling back to viem's 180 000ms
      // default (3x the devnet `txReceiptMs`) — see
      // `HeadlessUserOptions.receiptTimeoutMs`'s doc.
      const receipt = await runtime.public.waitForTransactionReceipt({
        hash: txHash,
        ...(this.receiptTimeoutMs !== undefined ? { timeout: this.receiptTimeoutMs } : {})
      });
      return {
        step: {
          txHash,
          submit: { startedAt: submitStartedAt, durationMs: submitDurationMs },
          receipt: {
            status: receipt.status === 'success' ? 'success' : 'reverted',
            timing: { startedAt: receiptStartedAt, durationMs: this.clock.now() - receiptStartedAt }
          }
        },
        rawReceipt: receipt
      };
    } catch (error) {
      const classified: DriverError = classifyRpcError({ message: messageOf(error) });
      return {
        step: {
          txHash,
          submit: { startedAt: submitStartedAt, durationMs: submitDurationMs },
          receipt: null,
          error: classified
        },
        rawReceipt: null
      };
    }
  }

  private decodeBridgeEvent(
    bridgeAddress: Address,
    logs: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>['logs']
  ): DecodedBridgeEvent | null {
    for (const log of logs) {
      if (log.address.toLowerCase() !== bridgeAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: BRIDGE_EVENT_ABI,
          data: log.data,
          topics: log.topics
        });
        if (decoded.eventName === 'BridgeEvent') {
          const args = decoded.args as unknown as DecodedBridgeEvent;
          return args;
        }
      } catch {
        // Not a BridgeEvent log (an ERC20 bridge also emits Transfer) — keep scanning.
      }
    }
    return null;
  }

  private async isClaimedRetryLoop(bridge: BridgeHandle, row: ObservedRow): Promise<boolean> {
    let result = false;
    for (const delayMs of IS_CLAIMED_RECHECK_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      result = await bridge
        .isClaimed({ leafIndex: row.depositCount, sourceBridgeNetwork: row.sourceNetwork })
        .catch(() => false);
      if (result) break;
    }
    return result;
  }
}

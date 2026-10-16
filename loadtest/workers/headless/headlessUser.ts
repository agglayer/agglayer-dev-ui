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

import { decodeEventLog, erc20Abi, parseAbiItem, parseUnits } from 'viem';

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
  ClaimPreState,
  ClaimStageProbeParams,
  ClaimStageProbeResult,
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
import {
  ClassifiedFetchError,
  classifyActivityWarning,
  classifyHttpError,
  classifyRpcError,
  classifySubmitError
} from '../../metrics/errors';
import { defaultChainClientFactory } from '../../wallets/chainClients';
import { detectWrapperDeployed, extractReceiptGas } from './receiptGas';
import {
  IS_CLAIMED_RECHECK_DELAYS_MS,
  anyRowNonTerminal,
  initialActivityCadenceState,
  KeyedSerialQueue,
  confirmClaimedRows,
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

/** `setTimeout` that resolves early (never rejects) when `signal` aborts. */
const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
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
  /**
   * Headless-only additive margin on the CLAIM send's gas limit (unused gas is
   * refunded). Absent = 0. Intentional deviation from the UI, which has none.
   */
  claimGasOffset?: number;
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
  /**
   * S53 M9 (`measurement.claimPreState`): just before sending the claim of a
   * wrapped ERC-20 (destination is not the token's origin network and the
   * wrapper already exists), read the wrapped token's `totalSupply()` and the
   * recipient's `balanceOf()` on the destination at `latest` and return them as
   * `ClaimSubmission.preState`. Harness-origin reads, best effort: a failed read
   * never affects the claim. Off by default.
   */
  claimPreState?: boolean;
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
  private readonly claimGasOffset: number;
  private readonly collector: Collector;
  private readonly clock: { now(): number };
  private readonly seedTokenList: boolean;
  /** R4 — see `HeadlessUserOptions.receiptTimeoutMs`'s doc. */
  private readonly receiptTimeoutMs?: number;
  /** S53 M9 — see `HeadlessUserOptions.claimPreState`'s doc. */
  private readonly claimPreState: boolean;

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
  //
  // S53 (design F3): `tracker_not_ready` is the tracker saying "retry after
  // <interval>" for a first-time address — hammering it again 300 ms later is
  // exactly the wrong response, so it is not retried here; the runner backs
  // off to the UI's own cadence instead. Every other failure keeps the retry.
  private readonly activityPoller = new SingleFlightPoller<ObservedRow[]>({
    isFatal: (error) =>
      error instanceof ClassifiedFetchError && error.errorClass === 'tracker_not_ready'
  });

  // S29 (reverses R3, `loadtest/REVIEW.md`): serializes every
  // nonce-consuming send THIS user issues, per chain — see `sendAndWait`'s
  // doc and `uiCallset.ts`'s `KeyedSerialQueue` doc for the full diagnosis
  // (captured raw rejection: "replacement transaction underpriced") and
  // why this shape was chosen over `ChainNonceManager`.
  private readonly chainSendQueue = new KeyedSerialQueue();

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
    this.claimGasOffset = options.claimGasOffset ?? 0;
    this.collector = options.collector;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.seedTokenList = options.seedTokenList ?? true;
    this.receiptTimeoutMs = options.receiptTimeoutMs;
    this.claimPreState = options.claimPreState ?? false;
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
    this.aggregator = new AggkitBridgeAggregator({ networks, aggkitProxyUrl: this.aggkitProxyUrl });

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
      // Design B: on a gas-token chain `eth` is held as the chain's WETH, so
      // bridging it out burns WETH (token = WETH, no msg.value, no approval).
      const isWethBurn = hop.assetKind === 'eth' && hop.fromWethToken !== undefined;
      const isNative = hop.assetKind === 'eth' && !isWethBurn;
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
        : isWethBurn
          ? (hop.fromWethToken as Address)
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

      if (!isNative && !isWethBurn) {
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
      } else if (isWethBurn) {
        // The bridge's own mintable WETH is burned by `bridgeAsset`
        // (privileged burn): `Bridge.buildBridgeAsset` with `token = WETH`
        // sets no `value`, and no approval is needed (the dev-ui app does
        // the same on a `wethToken` chain).
        bridgeTxParams = await this.native
          .bridge(fromChain.bridgeAddress, fromChain.chainId)
          .buildBridgeAsset(
            {
              destinationNetwork: toChain.networkId,
              destinationAddress: this.address,
              amount: amountWei.toString(),
              token: fromTokenAddress as Address,
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
      // SD4: on a hop touching a gas-token chain, the leaf identity is the
      // observable that catches a silent change of asset (e.g. bridging the
      // gas token with token=0x0 instead of the WETH).
      if (decoded && hop.expectedOrigin !== undefined) {
        const matches =
          Number(decoded.originNetwork) === hop.expectedOrigin.networkId &&
          decoded.originAddress.toLowerCase() === hop.expectedOrigin.address.toLowerCase();
        if (!matches) {
          throw new Error(
            `ASSET_IDENTITY_MISMATCH: hop ${hop.hopRoute} bridge leaf origin is (${decoded.originNetwork}, ${decoded.originAddress}), expected (${hop.expectedOrigin.networkId}, ${hop.expectedOrigin.address})`
          );
        }
      }
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
      // S53 (design F3): keep the class (and the tracker's own `Retry-After`,
      // recorded but not obeyed — the UI's behaviour on a 503 is unverified,
      // so this keeps parity) instead of flattening to a plain Error that the
      // runner would re-classify as `internal`.
      const retryAfter = response.headers.get('retry-after');
      throw new ClassifiedFetchError(
        retryAfter === null
          ? classified
          : { ...classified, message: `${classified.message} (Retry-After: ${retryAfter})` },
        response.status
      );
    }

    // DESIGN §9.2: text, then the big-int-safe parse — NEVER response.json().
    const text = await response.text();
    const mapped = mapActivityResponseText(text);
    const { warnings } = mapped;
    // Issue #53: never trust an unproven tracker `claimed` (see confirmClaimedRows).
    const rows = await confirmClaimedRows(mapped.rows, (row) => this.isClaimedOnDestination(row));

    // Finding C13: per-network warnings are a partial-fanout signal, not
    // silence — recorded so a broken upstream bridge service is visible
    // rather than looking like "no rows for that network".
    for (const warning of warnings) {
      const classified = classifyActivityWarning({
        networkId: warning.network_id,
        message: warning.message
      });
      this.collector.error({
        userId: this.userId,
        mode: this.mode,
        errorClass: classified.errorClass,
        message: classified.message,
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
      // S53 M9: read right before the send so the state is as close as possible
      // to what the claim will act on (still approximate: it lands a few blocks later).
      const preState = this.claimPreState ? await this.readClaimPreState(hop, toChain) : undefined;
      const claimGasOverride = await this.claimGasLimit(toChain.key, claimTxParams);
      const { step: claimStep, rawReceipt: claimReceipt } = await this.sendAndWait(
        toChain.key,
        claimTxParams,
        { gasOverride: claimGasOverride }
      );
      // Measurement (S45 C1): first claim of an ERC20 deploys the wrapper —
      // detected from the logs already in hand (NewWrappedToken emitted by the
      // destination bridge), no extra RPC.
      if (claimStep.receipt?.gas !== undefined && claimReceipt) {
        claimStep.receipt.gas.wrapperDeployed = detectWrapperDeployed(
          toChain.bridgeAddress,
          claimReceipt.logs
        );
      }

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

      return {
        isClaimedBefore,
        isClaimedTiming,
        claimInputs,
        claim: claimStep,
        isClaimedRecheck,
        ...(preState !== undefined ? { preState } : {})
      };
    });
  }

  /**
   * S53 M9: the wrapped token's `totalSupply()` and the recipient's `balanceOf()`
   * on the destination chain, or `undefined` when this claim is not a wrapped-token
   * mint candidate (an ETH hop, a claim on the token's origin network, a wrapper
   * that is not deployed yet) or a read fails. Never throws.
   */
  private async readClaimPreState(
    hop: HopSpec,
    toChain: LoadtestChain
  ): Promise<ClaimPreState | undefined> {
    if (hop.assetKind !== 'erc20') return undefined;
    const originNetworkId = this.assets[hop.assetIndex]?.originNetworkId;
    if (originNetworkId === undefined || toChain.networkId === originNetworkId) return undefined;
    return runWithFetchContext(
      { userId: this.userId, mode: this.mode, origin: 'harness' },
      async () => {
        try {
          const wrapped = await this.resolveTokenAddress(hop, toChain);
          // Zero address: the wrapper does not exist yet, so this claim deploys it.
          if (wrapped.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return undefined;
          const publicClient = this.chainRuntime(toChain.key).public;
          const [supply, balance] = await Promise.all([
            publicClient.readContract({
              address: wrapped,
              abi: erc20Abi,
              functionName: 'totalSupply'
            }),
            publicClient.readContract({
              address: wrapped,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [this.address]
            })
          ]);
          return {
            wrappedSupplyBefore: supply.toString(),
            recipientBalanceBefore: balance.toString()
          };
        } catch {
          return undefined;
        }
      }
    );
  }

  // -------------------------------------------------------------------------
  // probeClaimStages() — S45 C2, measurement only. NOT part of `UserDriver`;
  // the runner calls it behind a mode guard when `measurement.
  // stageProbeIntervalMs` is configured. Polls the three claim-path endpoints
  // in the pinned SDK's own `getClaimInputs` order (l1-info-tree-index on the
  // source -> injected-l1-info-leaf on the destination -> claim-proof on the
  // source), never re-polling a stage that is already available. Every request
  // runs under a `harness`-origin fetch context so it lands in the harness
  // bucket of the endpoint tables, never the UI-parity numbers. Resolves
  // (never rejects) with whatever stages were reached.
  // -------------------------------------------------------------------------
  async probeClaimStages(params: ClaimStageProbeParams): Promise<ClaimStageProbeResult> {
    const { sourceNetwork, destinationNetwork, depositCount, intervalMs, deadlineAt, signal } =
      params;
    const result: ClaimStageProbeResult = {
      l1InfoTreeIndexAt: null,
      l1InfoTreeIndex: null,
      injectedLeafAt: null,
      injectedLeafIndex: null,
      claimProofAt: null,
      polls: 0
    };
    // L1 (network 0) has no dedicated aggkit client — route it through the
    // other end's instance, as the SDK's own `clientForRecordingNetwork` does.
    const clientFor = (networkId: number, other: number) =>
      this.aggregator.clientFor(networkId === 0 ? other : networkId);
    const sourceClient = clientFor(sourceNetwork, destinationNetwork);

    return runWithFetchContext(
      { userId: this.userId, mode: this.mode, origin: 'harness' },
      async () => {
        while (!signal?.aborted && this.clock.now() < deadlineAt) {
          try {
            if (result.l1InfoTreeIndexAt === null) {
              result.polls += 1;
              const probe = await sourceClient.getL1InfoTreeIndex({
                networkId: sourceNetwork,
                depositCount
              });
              if (probe.ready) {
                result.l1InfoTreeIndexAt = this.clock.now();
                result.l1InfoTreeIndex = probe.value;
              }
            }
            if (result.l1InfoTreeIndexAt !== null && result.injectedLeafAt === null) {
              if (destinationNetwork === 0) {
                // L1 destination: the leaf AT the index, no injection to wait for.
                result.injectedLeafAt = this.clock.now();
                result.injectedLeafIndex = result.l1InfoTreeIndex;
              } else {
                result.polls += 1;
                const probe = await clientFor(
                  destinationNetwork,
                  sourceNetwork
                ).getInjectedL1InfoLeaf({
                  networkId: destinationNetwork,
                  leafIndex: result.l1InfoTreeIndex as number
                });
                if (probe.ready) {
                  result.injectedLeafAt = this.clock.now();
                  result.injectedLeafIndex = probe.value.l1_info_tree_index;
                  // Present on newer aggkit only (absent in the S43 live payload).
                  const extra = probe.value as unknown as {
                    injected_l2_block_num?: unknown;
                    injected_l2_block_timestamp?: unknown;
                  };
                  if (typeof extra.injected_l2_block_num === 'number') {
                    result.injectedL2BlockNum = extra.injected_l2_block_num;
                  }
                  if (typeof extra.injected_l2_block_timestamp === 'number') {
                    result.injectedL2BlockTimestamp = extra.injected_l2_block_timestamp;
                  }
                }
              }
            }
            if (result.injectedLeafAt !== null && result.claimProofAt === null) {
              result.polls += 1;
              const probe = await sourceClient.getClaimProof({
                networkId: sourceNetwork,
                leafIndex: result.injectedLeafIndex as number,
                depositCount
              });
              if (probe.ready) result.claimProofAt = this.clock.now();
            }
          } catch {
            // A transient poll failure (HTTP/transport) never ends the probe —
            // the next round retries; the request itself is already recorded
            // (status/transport failure) by the timing fetch wrapper.
          }
          params.onProgress?.({ ...result });
          if (result.claimProofAt !== null) break;
          await abortableSleep(intervalMs, signal);
        }
        params.onProgress?.({ ...result });
        return result;
      }
    );
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

  private isClaimedOnDestination(row: ObservedRow): Promise<boolean> {
    const toChain = [...this.chainsByKey.values()].find(
      (chain) => chain.networkId === row.destinationNetwork
    );
    if (toChain === undefined) return Promise.resolve(false);
    return this.native
      .bridge(toChain.bridgeAddress as Address, toChain.chainId)
      .isClaimed({ leafIndex: row.depositCount, sourceBridgeNetwork: row.sourceNetwork });
  }

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
   * Send-and-wait for one build's `TransactionParams` — DESIGN finding C4,
   * **fixed by S32**: `mapTransactionRequest` now forwards the SDK's own
   * `gas` (as a `bigint`) when present, so the real dev-ui (which spreads
   * `mapTransactionRequest`'s full return value straight into
   * `sendTransaction` — `useBridgeExecution.ts`/`useClaimExecution.ts`)
   * saves the second, redundant `eth_estimateGas` viem's
   * `prepareTransactionRequest` used to issue (P11). `nonce` is
   * deliberately still NOT forwarded (stale-nonce risk while a human signs
   * at their own pace) — `eth_getTransactionCount` (P10/P11's other half)
   * is unaffected, and fee derivation (P12) is unaffected either way.
   *
   * **This harness does NOT observe that saving**, and that is by design,
   * not a regression: below, `sendAndWait` builds its own `sendTransaction`
   * argument object field-by-field (`to`/`data`/`value` plus, for the
   * bridge send only, `opts.gasOverride`) rather than spreading `mapped` —
   * so `mapped.gas` (S32's new field) is never read here. Approve and claim
   * sends therefore still cost two `eth_estimateGas` calls (one from the
   * SDK's own builder, one from viem re-deriving it) exactly as before;
   * bridge sends already cost only one, but via `opts.gasOverride`
   * (`bridgeTxParams.gas` + `bridgeGasOffset`, computed independently of
   * `mapTransactionRequest`), not because of S32. Confirmed live: an
   * identical single-lap headless run showed the same estimateGas/send
   * pattern before and after S32's fix (see `loadtest/DESIGN.md` §9.3 C4
   * for the measured before/after and the live browser-mode trace that
   * DOES show the drop). `opts.gasOverride` is also the only mechanism that
   * gives C5 (loadtest/DESIGN.md §9.3) any headroom at all — the UI itself
   * has no equivalent, gas-buffer decision pending — so it stays.
   *
   * S29 (reverses `loadtest/REVIEW.md` R3): the ENTIRE body below is
   * serialized per (this user, `chainKey`) through `chainSendQueue`
   * (`uiCallset.ts`'s `KeyedSerialQueue` — see that class's doc for the
   * full diagnosis and why this shape, not `ChainNonceManager`, was
   * chosen). This is the ONLY send site in the user path, so wrapping it
   * here is sufficient for approve, bridge, and claim alike — whichever of
   * `bridge()`/`claim()` calls it, for whichever of this user's concurrent
   * laps, now waits its turn per chain instead of racing viem's
   * `eth_getTransactionCount(pending)` re-derivation against another
   * in-flight send on the SAME EOA. Wrapping the full submit-and-wait
   * (not just the broadcast) matches `browserUser.ts`'s `runExclusive`
   * precedent and the same real-user framing: one wallet does not have
   * several bridges in flight against one chain at once.
   */
  /**
   * Claim gas limit = SDK `gas` (or one eth_estimateGas if the params carry
   * none) + `claimGasOffset`. A first-mint claim deploys the wrapped token, and
   * concurrent claims change that state between estimate and execution
   * (zero-state mint ~228k vs ~177-194k nonzero), so the bare estimate can run
   * out of gas. Returns undefined (viem's own estimate) when the offset is 0 or
   * no estimate is obtainable.
   */
  private async claimGasLimit(
    chainKey: string,
    txParams: TransactionParams
  ): Promise<bigint | undefined> {
    if (this.claimGasOffset <= 0) return undefined;
    let base: bigint | undefined = txParams.gas !== undefined ? BigInt(txParams.gas) : undefined;
    if (base === undefined) {
      try {
        const mapped = mapTransactionRequest(txParams);
        base = await this.chainRuntime(chainKey).public.estimateGas({
          account: this.address,
          to: mapped.to,
          data: mapped.data,
          value: mapped.value
        });
      } catch {
        return undefined;
      }
    }
    return base + BigInt(this.claimGasOffset);
  }

  private async sendAndWait(
    chainKey: string,
    txParams: TransactionParams,
    opts: { gasOverride?: bigint } = {}
  ): Promise<{
    step: TxStepResult;
    rawReceipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>> | null;
  }> {
    return this.chainSendQueue.runExclusive(chainKey, async () => {
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
        const gas = extractReceiptGas(receipt as never);
        return {
          step: {
            txHash,
            submit: { startedAt: submitStartedAt, durationMs: submitDurationMs },
            receipt: {
              status: receipt.status === 'success' ? 'success' : 'reverted',
              timing: {
                startedAt: receiptStartedAt,
                durationMs: this.clock.now() - receiptStartedAt
              },
              ...(gas !== undefined ? { gas } : {})
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
    });
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

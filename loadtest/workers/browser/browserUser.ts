// The browser `UserDriver` — DESIGN §9/§9.4, §7. Implements
// `loadtest/core/userDriver.ts`'s `UserDriver` verbatim by driving the real
// dev-ui through Playwright, reusing `tests/bridge/models/bridge-page.ts`
// AS-IS (imported, never edited — S10 non-goal) plus this file's own
// locators/logic for whatever the page object doesn't expose (the wallet
// popover, the claim-result modal, the transactions-page row).
//
// Like `headlessUser.ts`, this module reports raw facts and timings only —
// `ring.ts` (via the future S11 runner) owns every state transition and
// timeout. The two documented exceptions, both inherited from
// `core/userDriver.ts`'s own module doc:
//  - `recordHttpSample`, fed indirectly by `timing.ts`'s
//    `page.on('request'|'response'|'requestfailed')` hooks (mirrors
//    headless's `installTimingFetch`) plus, for this driver's own
//    Node-side token-address-resolution calls (see below), the SAME
//    `installTimingFetch` wrapper headless installs — callers running both
//    modes in one process must install it exactly once.
//  - `recordPhase` for `page_load`/`wallet_connect` ONLY (`timing.ts`'s
//    `recordSessionPhase`) — DESIGN §5.1 phases ring.ts has no home for
//    (neither name appears in `core/ring.ts`).
//
// S10 design decision (recorded here, not silently assumed — flagged for
// S20/S11 review): `observeActivity()` re-fetches
// `{proxy}/tracker/v1/activity/from/{addr}?includeTracking=true` itself,
// executed via `page.evaluate` (so it is genuine page-originated traffic,
// captured by `timing.ts` exactly like the UI's own background poll) rather
// than scraping the rendered row text. `ObservedRow.depositCount`/
// `sourceNetwork`/`globalIndex` are NOT optional on the type and are not
// obtainable from the DOM at all (the rendered row shows only a status
// string) — the UI's own `useTransactions` hook already issues this exact
// request on this exact cadence in the background, so this is "polling the
// transactions page" at the data layer the page itself is built on, not an
// extra call pattern invented by the tool. The real DOM refresh control
// (`refreshActivity`, the `transactions-refresh` button) is still exercised
// deliberately but SPARINGLY (`refreshEveryNPolls`), per the S10 goal text.
//
// Finding C6/C14 consequence for browser mode (uiCallset.ts's
// `TokenAddressResolver` doc: "browser mode requires the user to manually
// register a 'custom token' address per chain instead"): a full-ring ERC20
// lap must seed a DIFFERENT address per hop's FROM chain (origin address on
// the origin chain, the wrapped address elsewhere) via
// `bridge-page.ts#seedCustomToken`, or `openTokenSelector`/`selectToken`
// would either select the wrong token or find nothing. This driver resolves
// that address per hop with the SAME `TokenAddressResolver` class headless
// uses (reused, not reimplemented) — a tool-internal mechanism, not a UI
// call the real app makes (DESIGN §9.4 already documents that the UI itself
// never performs this resolution).
//
// S24 / DESIGN §9.3 finding C16 fix (was: "browser mode's own control-flow
// polling adds `tracker/activity` requests the real UI never issues",
// inflating volume ~2x on the highest-volume endpoint class with no way to
// tell the two apart). Two changes, both scoped to THIS driver — no DOM
// scraping, no UI cadence change, no `core/` change:
//  1. **Attribution.** `observeActivity()`'s own `page.evaluate` fetch now
//     appends a harmless marker query param (`_ltPollOrigin=harness`,
//     `timing.ts`'s `HARNESS_POLL_MARKER`) so `timing.ts` can tag that one
//     sample `origin: 'harness'` while the real UI's own independent
//     background poll to the exact same endpoint (no marker) keeps tagging
//     `origin: 'ui'` — verified live that an unknown query param is ignored
//     by the tracker/activity endpoint (identical response body) and that
//     `classifyEndpoint` never inspects query params for this class. The
//     Node-side driver-internal calls below (`resolveTokenAddress`, the
//     bridge tx's own receipt fetch) are likewise tagged `origin: 'harness'`
//     via `runWithFetchContext` — real load on the proxy/RPC, but not what a
//     real UI generates.
//  2. **Rate.** The driver only needs to notice a terminal row eventually —
//     it does NOT need to mirror the UI's burst cadence — so
//     `observeActivity()` bounds its own real fetch rate to roughly once
//     per `harnessPollIntervalMs` (default 5000ms, mirroring the UI's own
//     steady-state interval but without the burst).
//
//     Retry #1 correction: the first cut of (2) was a check-then-act flat
//     wait (`throttleHarnessPoll()`, removed) that read a shared
//     `lastHarnessPollAt` timestamp, awaited, THEN wrote it — under
//     `maxInflightLapsPerUser` concurrency (several laps in flight per
//     user, each able to call `observeActivity()`/`readState()`
//     independently) multiple callers read the same stale timestamp and
//     all fired together, measured at a ~1s effective interval instead of
//     the intended flat 5s (harness traffic went UP 4.5x, not down). Fixed
//     with `fetchActivitySingleFlight()`: a single in-flight fetch is
//     shared by every concurrent caller (dedup, same shape as `pool.ts`'s
//     `crashInFlight`), and its result is then cached for
//     `harnessPollIntervalMs` so later callers in the same window get that
//     one fetch's answer instead of issuing their own. Net effect: at most
//     one real `tracker/activity` request per user per
//     `harnessPollIntervalMs`, no matter how many callers ask.
import type { BrowserContext, Page } from '@playwright/test';
import type { Address, Hex, PublicClient } from 'viem';

import { expect } from '@playwright/test';
import { decodeEventLog, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type {
  AggkitBridgeAggregator as AggkitBridgeAggregatorType,
  AggLayerSDK as AggLayerSDKType
} from '@agglayer/sdk';

import { AggkitBridgeAggregator, AggLayerSDK, SDK_MODES } from '@agglayer/sdk';

import type { LoadtestAsset, LoadtestChain } from '../../config/schema';
import type { HopSpec, ObservedRow } from '../../core/types';
import type {
  ClaimSubmission,
  DriverError,
  DriverMode,
  HopReadState,
  StepTiming,
  UserDriver,
  BridgeSubmission
} from '../../core/userDriver';
import type { Collector } from '../../metrics/collector';
import type { BrowserPool } from './pool';

import { shortenAddress } from '../../../app/utils/address';
import { BridgePage } from '../../../tests/bridge/models/bridge-page';
import {
  classifyBrowserCrash,
  classifyRevertError,
  classifyRpcError,
  classifyUiAssertionError
} from '../../metrics/errors';
import { defaultChainClientFactory } from '../../wallets/chainClients';
import { mapActivityResponseText, runWithFetchContext, sleep } from '../headless/uiCallset';
import { isCrashLikeError } from './pool';
import { installBrowserTiming, recordSessionPhase } from './timing';

// S24: the marker `timing.ts`'s `originOf` looks for — kept as a single
// source of truth on this (the ISSUING) side; `timing.ts` owns the matching
// constant on the READING side (duplicated deliberately, same convention
// `ALREADY_CLAIMED_SELECTOR` above already follows for a cross-file literal
// two modules must agree on without importing each other's internals).
const HARNESS_POLL_MARKER_PARAM = '_ltPollOrigin';
const HARNESS_POLL_MARKER_VALUE = 'harness';

const LOADTEST_TOKEN_SYMBOL = 'LTE2E';
const LOADTEST_TOKEN_NAME = 'Loadtest E2E Token';

// Same 4-byte `AlreadyClaimed()` selector `metrics/errors.ts` matches on —
// reused as a literal here (not re-derived) only to hand it to that file's
// own `classifyRevertError`, never to duplicate the matching rule.
const ALREADY_CLAIMED_SELECTOR = '0x646cf558';

// S11 retry defect (4) fix: the bridge contract's `BridgeEvent`, decoded off
// the REAL transaction receipt fetched by node-side RPC (`getPublicClient`
// below) rather than assumed. Mirrors `headlessUser.ts`'s private
// `BRIDGE_EVENT_ABI`/`decodeBridgeEvent` (not exported from that file —
// "build on it, do not modify" — so duplicated here, same convention this
// file already follows for `toSdkChainConfig`). Before this fix, browser
// mode always reported `depositCount: null` on a genuinely successful
// bridge (the UI's success view carries no deposit count), which tripped
// `core/ring.ts`'s T11 `!bridgeEventFound || depositCount === null` check on
// EVERY successful browser bridge that got far enough to reach it —
// misreporting a real success as `bridge_event_missing`, not a decode bug
// in `ring.ts` and not a mis-attributed C5 revert.
const BRIDGE_EVENT_ABI = [
  parseAbiItem(
    'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)'
  )
];

interface DecodedBridgeEvent {
  depositCount: number;
}

const decodeBridgeEventLog = (
  bridgeAddress: Address,
  logs: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>['logs']
): DecodedBridgeEvent | null => {
  for (const log of logs) {
    if (log.address.toLowerCase() !== bridgeAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: BRIDGE_EVENT_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === 'BridgeEvent') {
        return {
          depositCount: Number(
            (decoded.args as unknown as { depositCount: bigint | number }).depositCount
          )
        };
      }
    } catch {
      // Not a BridgeEvent log (an ERC20 bridge also emits Transfer) — keep scanning.
    }
  }
  return null;
};

type AggNative = ReturnType<AggLayerSDKType['getNative']>;

// Mirrors `headlessUser.ts`'s private `toSdkChainConfig` — small and not
// exported from that file (workers/headless is "build on it, do not
// modify"), so duplicated here rather than editing it to export one.
const toSdkChainConfig = (chain: LoadtestChain) => ({
  chainId: chain.chainId,
  networkId: chain.networkId,
  name: chain.key,
  rpcUrl: chain.rpcUrl,
  nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
  bridgeAddress: chain.bridgeAddress
});

export class BrowserCrashError extends Error {
  readonly errorClass = 'browser_crash' as const;
}

export interface BrowserUserOptions {
  userId: string;
  privateKey: Hex;
  pool: BrowserPool;
  chains: readonly LoadtestChain[];
  /** Same shape/role as `HeadlessUserOptions.assets` — resolves `hop.assetIndex` to `originNetworkId`. */
  assets?: readonly LoadtestAsset[];
  aggkitProxyUrl: string;
  collector: Collector;
  clock?: { now(): number };
  pageLoadMs?: number;
  walletConnectMs?: number;
  bridgeSuccessTimeoutMs?: number;
  claimTimeoutMs?: number;
  /** DESIGN goal text: use the real `refreshActivity` control "sparingly" — every Nth `observeActivity()` call also clicks it. 0 disables. */
  refreshEveryNPolls?: number;
  /** S24 (DESIGN §9.3 C16 fix, part 2): minimum spacing, in ms, between consecutive `observeActivity()` polls this driver issues for its OWN control flow. Default 5000 — a flat, steady interval; no burst, since the driver only needs to notice a terminal row eventually, not catch it within the UI's sub-second burst window. */
  harnessPollIntervalMs?: number;
}

interface PendingDeposit {
  txHash: Hex;
  fromNetworkId: number;
}

/**
 * Browser `UserDriver` — one instance per simulated user, backed by a
 * `BrowserPool`-owned `BrowserContext` (one context per user, never shared).
 */
export class BrowserUser implements UserDriver {
  readonly userId: string;
  readonly mode: DriverMode = 'browser';
  readonly address: Address;

  private readonly pool: BrowserPool;
  private readonly chains: readonly LoadtestChain[];
  private readonly chainsByKey: Map<string, LoadtestChain>;
  private readonly assets: readonly LoadtestAsset[];
  private readonly aggkitProxyUrl: string;
  private readonly collector: Collector;
  private readonly clock: { now(): number };
  private readonly pageLoadMs: number;
  private readonly walletConnectMs: number;
  private readonly bridgeSuccessTimeoutMs: number;
  private readonly claimTimeoutMs: number;
  private readonly refreshEveryNPolls: number;
  private readonly harnessPollIntervalMs: number;
  private readonly knownHosts: Set<string>;

  private context!: BrowserContext;
  private page!: Page;
  private bridgePage!: BridgePage;
  private timingHandle: { uninstall(): void } | null = null;
  private pollCount = 0;
  private lapsCompleted = 0;
  /**
   * S24 retry #1: single-flight + TTL cache for THIS driver's own
   * `observeActivity()` fetch, replacing the check-then-act
   * `throttleHarnessPoll()` (removed) that let concurrent callers — driven
   * by `maxInflightLapsPerUser`'s concurrent laps, each of which can call
   * both `readState()` and `observeActivity()` directly — all read the same
   * stale `lastHarnessPollAt`, all compute a non-positive `waitMs`, and all
   * fire together (measured: ~1s effective interval instead of the
   * intended flat 5s). Same bug class as `pool.ts`'s `crashInFlight`
   * (see that field's doc) — copied here: a Map-free single-slot version
   * since this class already has exactly one activity stream per driver.
   * `activityFetchInFlight` dedupes concurrent callers onto ONE real fetch;
   * `activityCache` then serves that fetch's result to every caller
   * (concurrent or sequential) for `harnessPollIntervalMs`, so the actual
   * network rate is bounded to ~1/`harnessPollIntervalMs` per user
   * regardless of how many callers ask. Correctness: every caller within
   * the TTL window observes the SAME snapshot a caller arriving at the
   * start of the window would have — never staler than
   * `harnessPollIntervalMs`, which is exactly the freshness the flat
   * throttle already promised (this driver only needs to notice a terminal
   * row eventually, not within the UI's sub-second burst window).
   */
  private activityFetchInFlight: Promise<ObservedRow[]> | null = null;
  private activityCache: { rows: ObservedRow[]; at: number } | null = null;

  private aggregator!: AggkitBridgeAggregatorType;
  private native!: AggNative;
  private readonly wrappedAddressCache = new Map<string, Address>();

  private readonly pendingDeposits = new Map<string, PendingDeposit>();

  /**
   * S25 (plan §7 root-cause fix — "up to six concurrent laps drive a
   * single shared Playwright page with no serialization"): `runExclusive`
   * below is the queue that fixes it. See that method's doc for the full
   * design rationale (why a queue, not the single-flight/dedup shape this
   * file already uses for `fetchActivitySingleFlight`).
   */
  private mutexTail: Promise<void> = Promise.resolve();

  // S11 retry defect (4): a plain read-only RPC client per chain, used ONLY
  // to fetch the bridge tx's own receipt so `bridge()` can decode a REAL
  // `depositCount` instead of always reporting `null` (see
  // `decodeBridgeEventLog` above). One extra `eth_getTransactionReceipt`
  // per browser-mode bridge submission — a documented browser/headless
  // parity divergence (headless already fetches this receipt as part of
  // sending the tx; browser mode has to fetch it separately since the send
  // itself happens inside the page, not through this client). Routed
  // through the SAME wrapped `globalThis.fetch` (`installTimingFetch`,
  // installed once by the runner) as this driver's other node-side calls,
  // so it is recorded as an `rpc/*` HTTP sample, not invisible traffic.
  private readonly publicClientsByChainKey = new Map<string, PublicClient>();

  private getPublicClient(chainKey: string): PublicClient {
    const existing = this.publicClientsByChainKey.get(chainKey);
    if (existing !== undefined) return existing;
    const chain = this.chainByKey(chainKey);
    const client = defaultChainClientFactory(chain).public;
    this.publicClientsByChainKey.set(chainKey, client);
    return client;
  }

  constructor(options: BrowserUserOptions) {
    this.userId = options.userId;
    this.address = privateKeyToAccount(options.privateKey).address;
    this.pool = options.pool;
    this.chains = options.chains;
    this.chainsByKey = new Map(this.chains.map((chain) => [chain.key, chain]));
    this.assets = options.assets ?? [];
    this.aggkitProxyUrl = options.aggkitProxyUrl.replace(/\/$/, '');
    this.collector = options.collector;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.pageLoadMs = options.pageLoadMs ?? 30_000;
    this.walletConnectMs = options.walletConnectMs ?? 15_000;
    this.bridgeSuccessTimeoutMs = options.bridgeSuccessTimeoutMs ?? 60_000;
    this.claimTimeoutMs = options.claimTimeoutMs ?? 150_000;
    this.refreshEveryNPolls = options.refreshEveryNPolls ?? 6;
    this.harnessPollIntervalMs = options.harnessPollIntervalMs ?? 5_000;

    this.knownHosts = new Set<string>();
    for (const candidate of [this.aggkitProxyUrl, ...this.chains.map((chain) => chain.rpcUrl)]) {
      try {
        this.knownHosts.add(new URL(candidate).origin);
      } catch {
        // Not a valid absolute URL — skip rather than throw at construction time.
      }
    }
  }

  // -------------------------------------------------------------------------
  // init() — DESIGN §1.1/`core/userDriver.ts`: "launch context, navigate,
  // connect (phases page_load, wallet_connect)".
  // -------------------------------------------------------------------------
  async init(): Promise<void> {
    await this.runGuarded(async () => {
      this.context = await this.pool.acquireContext(this.userId);

      const sdk = new AggLayerSDK({
        mode: [SDK_MODES.NATIVE],
        native: {
          defaultNetwork: this.chains[0]?.chainId,
          chains: this.chains.map(toSdkChainConfig)
        }
      });
      this.native = sdk.getNative();
      const networks: Record<number, string> = {};
      for (const chain of this.chains)
        if (chain.networkId !== 0) networks[chain.networkId] = this.aggkitProxyUrl;
      this.aggregator = new AggkitBridgeAggregator({ networks });

      await this.openFreshPage();
    });
  }

  private async openFreshPage(): Promise<void> {
    const pageLoadStartedAt = this.clock.now();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(Math.max(this.pageLoadMs, this.walletConnectMs, 30_000));
    this.timingHandle = installBrowserTiming(this.page, {
      userId: this.userId,
      collector: this.collector,
      knownHosts: this.knownHosts,
      clock: this.clock
    });
    this.bridgePage = new BridgePage({ page: this.page });

    await this.bridgePage.navigate();
    recordSessionPhase(this.collector, 'page_load', this.clock.now() - pageLoadStartedAt);

    const connectStartedAt = this.clock.now();
    await this.bridgePage.connectWallet();
    recordSessionPhase(this.collector, 'wallet_connect', this.clock.now() - connectStartedAt);

    // R10 (loadtest/REVIEW.md): per-user identity in browser mode rests
    // ENTIRELY on `pool.ts`'s `context.addInitScript` landing before
    // `app/context/e2eAccount.ts` evaluates (S03) — there was previously no
    // runtime check that it actually did. If that ordering ever silently
    // broke, every browser user would collapse onto the shared build-time
    // key, producing a meaningless per-user load profile and a nonce-
    // collision error pattern that reads as chain/proxy trouble (R3) — an
    // invisible, catastrophic measurement failure. This converts it into
    // an immediate, loud one.
    await this.assertConnectedWallet();
  }

  /**
   * R10: the header badge already reads `shortenAddress(address)` (S03/S10
   * proved this distinguishes per-user addresses live); comparing it
   * against `this.address` here — INSIDE `init()`, on the production path,
   * not just a one-off acceptance script — is what makes a regression fail
   * loudly instead of silently.
   */
  private async assertConnectedWallet(): Promise<void> {
    const badgeText = await this.debugConnectedBadgeText();
    const expected = shortenAddress(this.address);
    if (!badgeText.includes(expected)) {
      throw new Error(
        `browser driver: connected-wallet mismatch for user "${this.userId}" — expected the UI to show "${expected}" (address ${this.address}) but it shows "${badgeText}". This means the per-user private-key override (S03's addInitScript) did not apply, and this browser context would sign from the wrong wallet.`
      );
    }
  }

  /** Debug/verification helper (not part of `UserDriver`) — the header's shortened-address badge text, for S10's "addresses differ per context" proof. */
  async debugConnectedBadgeText(): Promise<string> {
    return (await this.bridgePage.walletConnectedBadge.textContent().catch(() => '')) ?? '';
  }

  private async gotoHome(): Promise<void> {
    await this.bridgePage.navigate();
    await this.bridgePage.connectWallet();
  }

  private chainByKey(key: string): LoadtestChain {
    const chain = this.chainsByKey.get(key);
    if (!chain) throw new Error(`browser driver: unknown chain key "${key}"`);
    return chain;
  }

  // -------------------------------------------------------------------------
  // bridge() — DESIGN §9.4 (browser mode, no bridgeGasOffset, no
  // token-mappings for a seeded custom token), finding C14 (per-hop wrapped
  // address seeding).
  // -------------------------------------------------------------------------
  async bridge(hop: HopSpec): Promise<BridgeSubmission> {
    return this.runExclusive(() =>
      this.runGuarded(async () => {
        const fromChain = this.chainByKey(hop.fromChainKey);
        const toChain = this.chainByKey(hop.toChainKey);
        const isNative = hop.assetKind === 'eth';

        if (!isNative) {
          const tokenAddress = await this.resolveTokenAddress(hop, fromChain);
          await this.bridgePage.seedCustomToken({
            chainId: fromChain.chainId,
            address: tokenAddress,
            decimals: hop.decimals,
            symbol: LOADTEST_TOKEN_SYMBOL,
            name: LOADTEST_TOKEN_NAME
          });
        }

        await this.gotoHome();
        // `bridge-page.ts#selectChainPair` also runs `assertChainPair`, which
        // reads the EXPECTED chain name from the repo's root `config.json`
        // via `loadAppConfigForNode()` — the production config, unrelated to
        // this run's `build-ui`-generated config (whose chain names are
        // `titleCase(chain.key)`, e.g. "L1", not "Devnet L1"). Against a
        // loadtest build the two disagree, so this driver selects the pair
        // directly (`selectFromChain`/`selectToChain`, same locators
        // `selectChainPair` uses) without that cross-check — a deliberate,
        // documented divergence from the shared page object's own spec-only
        // convenience method, not a defect in it (S10 feedback pack).
        await this.bridgePage.selectFromChain(fromChain.chainId);
        await this.bridgePage.selectToChain(toChain.chainId);

        // S11 retry defect (4) fix: this driver has no reliable way to obtain
        // an approve tx's OWN hash/receipt from the DOM (the step indicator
        // only shows that approval happened, not its result) — a real
        // limitation, not something to paper over. Previously this method
        // fabricated an `approve` `TxStepResult` with `txHash: null` whenever
        // the step indicator became visible; `core/ring.ts`'s `eventsFromBridge`
        // -> `txEvents` treats ANY `TxStepResult` with a null `txHash` and no
        // `error` as a failed send (`{message: 'send did not resolve'}`),
        // which `outcomeFromDriverError` then falls through to `'internal'`
        // (no `errorClass` to switch on) — so EVERY non-native (ERC20) browser
        // bridge whose approve step became visible failed the hop outcome
        // `internal`, unconditionally, regardless of whether the bridge itself
        // succeeded. Reporting no approve data at all (`approve: null`, same
        // as the native-asset case) is honest; a fabricated one that trips a
        // failure path is not. `page_load`/`wallet_connect` are already
        // absent for headless the same way (DESIGN §5.1) — this is the same
        // "missing, not zero" treatment for the other direction.
        if (!isNative) {
          await this.bridgePage.openTokenSelector();
          await this.bridgePage.selectToken(LOADTEST_TOKEN_SYMBOL);
        }

        const submitStartedAt = this.clock.now();
        await this.bridgePage.fillAmount(hop.amount);
        await this.bridgePage.submitBridge();
        await this.bridgePage.waitForTransactionModal();

        try {
          await this.bridgePage.waitForBridgeSuccess(this.bridgeSuccessTimeoutMs);
        } catch (error) {
          const submitDurationMs = this.clock.now() - submitStartedAt;
          return {
            allowance: null,
            approve: null,
            bridge: {
              txHash: null,
              submit: { startedAt: submitStartedAt, durationMs: submitDurationMs },
              receipt: null,
              error: classifyUiAssertionError({
                message: error instanceof Error ? error.message : String(error),
                testId: 'bridge-success-view'
              })
            },
            depositCount: null,
            bridgeEventFound: false
          };
        }

        const submitDurationMs = this.clock.now() - submitStartedAt;

        const explorerHref = await this.bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
        const txHash = explorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0] as Hex | undefined;
        if (!txHash) {
          return {
            allowance: null,
            approve: null,
            bridge: {
              txHash: null,
              submit: { startedAt: submitStartedAt, durationMs: submitDurationMs },
              receipt: null,
              error: classifyUiAssertionError({
                message: 'could not read the bridge transaction hash from the success view',
                testId: 'bridge-success-explorer-link'
              })
            },
            depositCount: null,
            bridgeEventFound: false
          };
        }

        await this.bridgePage.bridgeSuccessCta.click(); // -> transactions route
        this.pendingDeposits.set(txHash, { txHash, fromNetworkId: hop.fromNetworkId });

        // S11 retry defect (4) fix: decode the REAL `depositCount` off the
        // bridge tx's own receipt (fetched read-only, node-side) instead of
        // always reporting `null` — see `decodeBridgeEventLog`'s doc above.
        // The UI's success view proves the tx mined successfully (it only
        // renders on a mined, non-reverted receipt), so a decode failure here
        // means the log scan itself failed (RPC hiccup, unexpected log
        // shape) — a genuine `bridge_event_missing`, not the false positive
        // this fix removes.
        let depositCount: number | null = null;
        let bridgeEventFound = false;
        // VALIDATION-1.md A8: this used to be a BARE `catch {}` — any failure
        // of the receipt fetch/log-decode below (a transient RPC hiccup, not
        // just "genuinely no matching log") silently fell through to the
        // exact same `bridgeEventFound: false`, which `core/ring.ts`'s T11
        // then reports as `bridge_event_missing` — an outcome that reads as
        // "the chain did not emit a BridgeEvent". A live run recorded 8 of
        // these, all browser-mode (headless never hits this path — it
        // decodes off a receipt it already holds). The underlying error is
        // now classified and reported instead of swallowed.
        let bridgeEventDecodeError: DriverError | undefined;
        try {
          // S24: this driver's own bookkeeping (decoding a REAL depositCount
          // off the receipt) — the real UI never fetches this receipt itself
          // (its success view is DOM-only), so this is `harness`, not `ui`.
          const receipt = await runWithFetchContext(
            { userId: this.userId, mode: this.mode, origin: 'harness' },
            () => this.getPublicClient(hop.fromChainKey).getTransactionReceipt({ hash: txHash })
          );
          const decoded = decodeBridgeEventLog(fromChain.bridgeAddress as Address, receipt.logs);
          if (decoded) {
            depositCount = decoded.depositCount;
            bridgeEventFound = true;
          }
        } catch (error) {
          // Leave depositCount/bridgeEventFound at their "not found" defaults
          // — `core/ring.ts`'s T11 will now correctly fail this hop only when
          // decoding genuinely failed, not on every success — but classify
          // and surface WHY, rather than swallowing it (A8).
          bridgeEventDecodeError = classifyRpcError({
            message: error instanceof Error ? error.message : String(error)
          });
        }

        return {
          allowance: null,
          approve: null,
          bridge: {
            txHash,
            submit: { startedAt: submitStartedAt, durationMs: submitDurationMs },
            receipt: {
              status: 'success',
              timing: { startedAt: submitStartedAt, durationMs: submitDurationMs }
            }
          },
          depositCount,
          bridgeEventFound,
          ...(bridgeEventDecodeError !== undefined ? { bridgeEventDecodeError } : {})
        };
      })
    );
  }

  // -------------------------------------------------------------------------
  // observeActivity() — see the module doc's design-decision note above.
  // -------------------------------------------------------------------------
  //
  // S24 retry #1 (DESIGN §9.3 C16 fix, part 2, corrected): single-flight +
  // TTL cache instead of the removed `throttleHarnessPoll()`'s
  // check-then-act flat-interval wait, which raced under
  // `maxInflightLapsPerUser` concurrency (see `activityFetchInFlight`'s
  // field doc for the full diagnosis). `observeActivity()` itself stays
  // the public, per-call entry point most callers use (`runner.ts`'s
  // `observe_activity` action calls it directly); it delegates to
  // `fetchActivitySingleFlight()`, which is the only place that decides
  // whether THIS call gets a cached snapshot, joins an already-in-flight
  // fetch, or starts a new one.
  //
  // S25: also routed through `runExclusive` — this issues a real
  // `page.evaluate` fetch (`performActivityFetch`) just like `bridge()`/
  // `claim()` touch the page, so it must take its turn in the SAME queue
  // rather than racing a concurrent `bridge()`/`claim()` call's navigation
  // (this is literally one of the root-cause table's named symptoms:
  // `page.evaluate: Execution context was destroyed`). `readState()` below
  // is already inside its OWN exclusive turn when it needs an activity
  // snapshot, so it calls `fetchActivitySingleFlight()` directly rather
  // than through this method — going through `observeActivity()` from
  // inside an already-held turn would deadlock (queue behind itself).
  async observeActivity(): Promise<ObservedRow[]> {
    return this.runExclusive(() => this.runGuarded(() => this.fetchActivitySingleFlight()));
  }

  private fetchActivitySingleFlight(): Promise<ObservedRow[]> {
    const now = this.clock.now();
    // Fresh enough — serve the cached snapshot from the last real fetch.
    // No caller-visible difference from re-fetching: nothing outside this
    // driver's own control flow can have changed the tracker's answer for
    // THIS address within `harnessPollIntervalMs`, which is exactly the
    // staleness bound the original flat-interval throttle already
    // promised every caller.
    if (this.activityCache !== null && now - this.activityCache.at < this.harnessPollIntervalMs) {
      return Promise.resolve(this.activityCache.rows);
    }
    // Already fetching (a concurrent caller got here first) — join that
    // one fetch instead of starting a second. Mirrors `pool.ts`'s
    // `crashInFlight` dedup shape (single slot here since this class has
    // exactly one activity stream per driver, vs. one per browser slot
    // there).
    if (this.activityFetchInFlight !== null) {
      return this.activityFetchInFlight;
    }
    const promise = this.performActivityFetch().then(
      (rows) => {
        this.activityCache = { rows, at: this.clock.now() };
        return rows;
      },
      (error) => {
        // Do not poison the cache on failure — the next call (this one's
        // caller included, via its own retry, or the next caller) should
        // get a real retry, not a frozen stale-on-error snapshot.
        throw error;
      }
    );
    this.activityFetchInFlight = promise;
    // Whichever settles first, this slot is free for the next fetch. Every
    // concurrent caller above already holds its own reference to `promise`
    // and will resolve/reject with it regardless of this cleanup — the
    // trailing `.catch(() => {})` only prevents THIS cleanup-only promise
    // chain from surfacing as a duplicate unhandled rejection; the real
    // error is still delivered to every caller via `promise` itself.
    promise
      .finally(() => {
        if (this.activityFetchInFlight === promise) this.activityFetchInFlight = null;
      })
      .catch(() => {});
    return promise;
  }

  /** Issues THIS driver's own single real `tracker/activity` fetch. Never call directly — go through `fetchActivitySingleFlight()` so concurrent/rapid callers dedupe onto one call. */
  private async performActivityFetch(): Promise<ObservedRow[]> {
    return runWithFetchContext(
      { userId: this.userId, mode: this.mode, origin: 'harness' },
      async () => {
        this.pollCount += 1;
        if (this.refreshEveryNPolls > 0 && this.pollCount % this.refreshEveryNPolls === 0) {
          await this.bridgePage.refreshActivity().catch(() => undefined);
        }

        // S24: the marker param — see `timing.ts`'s `originOf`/
        // `HARNESS_POLL_MARKER` doc and this file's module doc. Ignored by
        // the backend (verified live: identical response body with/without
        // it) and invisible to `classifyEndpoint` (which never reads query
        // params for `tracker/activity`), so it changes nothing about what
        // this request IS — only how `timing.ts` attributes it.
        const url = `${this.aggkitProxyUrl}/tracker/v1/activity/from/${this.address}?includeTracking=true&${HARNESS_POLL_MARKER_PARAM}=${HARNESS_POLL_MARKER_VALUE}`;
        const text: string = await this.fetchActivityTextWithRetry(url);

        const { rows, warnings } = mapActivityResponseText(text);
        for (const warning of warnings) {
          this.collector.error({
            userId: this.userId,
            mode: this.mode,
            errorClass: 'proxy_5xx',
            message: `activity_warning[network_id=${warning.network_id}]: ${warning.message}`,
            endpointClass: 'tracker/activity'
          });
        }
        return rows;
      }
    );
  }

  /**
   * S24 retry #1 correction: retries the real fetch a few times before
   * giving up. Needed BECAUSE of single-flight sharing, not despite it —
   * once `fetchActivitySingleFlight()` collapses concurrent callers onto
   * ONE real fetch, a single transient failure's blast radius becomes
   * every joined caller at once (previously, each caller had its OWN
   * redundant fetch, so one caller's bad luck didn't fail the others).
   * Measured live at `maxInflightLapsPerUser: 3`: without this retry, a
   * same-parameters before/after comparison went from 0 to 33 `internal`
   * hop outcomes, root-caused to `page.evaluate: TypeError: Failed to
   * fetch` — almost certainly a concurrent lap's own wallet chain-switch
   * navigating this driver's ONE shared page while this fetch is mid-flight
   * (the tracker/activity request itself is unrelated to which chain the
   * wallet is on, so re-issuing it is always safe). `isCrashLikeError`
   * cases are NOT retried here — a truly dead page/context/browser should
   * still propagate immediately so `runGuarded`'s crash race reacts
   * without delay, exactly as before this correction.
   */
  private async fetchActivityTextWithRetry(url: string): Promise<string> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // `page.evaluate` has no built-in timeout, unlike Playwright's
        // higher-level locator/expect APIs — empirically (S10 acceptance
        // run #1), a page whose context died mid-flight can leave this
        // in-flight CDP round trip pending indefinitely instead of
        // rejecting promptly, which would otherwise hang the whole driver
        // past DESIGN §7.3's crash detection. Bounded explicitly so a dead
        // page is turned into a `browser_crash`-classifiable error instead.
        return await this.raceAgainstDeadPage(
          this.page.evaluate(async (target: string) => {
            const response = await fetch(target);
            return response.text();
          }, url),
          20_000,
          'observeActivity fetch'
        );
      } catch (error) {
        if (attempt === maxAttempts || isCrashLikeError(error)) throw error;
        await sleep(300);
      }
    }
    // Unreachable (the loop above always returns or throws), but keeps
    // TypeScript's control-flow analysis happy without an `as never`.
    throw new Error('fetchActivityTextWithRetry: unreachable');
  }

  // -------------------------------------------------------------------------
  // claim() — real UI click (`clickClaim`), DESIGN §9.4 finding C5 doesn't
  // apply here (browser mode never builds tx params itself).
  // -------------------------------------------------------------------------
  async claim(_hop: HopSpec, row: ObservedRow): Promise<ClaimSubmission> {
    return this.runExclusive(() =>
      this.runGuarded(async () => {
        const isClaimedStartedAt = this.clock.now();
        if (row.status === 'CLAIMED') {
          return {
            isClaimedBefore: true,
            isClaimedTiming: {
              startedAt: isClaimedStartedAt,
              durationMs: this.clock.now() - isClaimedStartedAt
            },
            claimInputs: null,
            claim: null,
            isClaimedRecheck: null
          };
        }
        const isClaimedTiming: StepTiming = {
          startedAt: isClaimedStartedAt,
          durationMs: this.clock.now() - isClaimedStartedAt
        };

        const submitStartedAt = this.clock.now();
        try {
          await this.bridgePage.clickClaim(row.transactionHash);
        } catch (error) {
          // S16/A2 (VALIDATION-1.md): the row *was* READY_TO_CLAIM — only the
          // UI click failed — so this must report `claimInputs: { claimable:
          // true, ... }` like the two later failure paths in this method do,
          // not `claimInputs: null`. `null` here made `core/ring.ts`'s
          // `eventsFromClaim` drop the `ui_assertion` error entirely and let
          // the hop time out as `timeout_not_claimable` (a *devnet* outcome)
          // instead of surfacing the driver's own classified error.
          return {
            isClaimedBefore: false,
            isClaimedTiming,
            claimInputs: { claimable: true, timing: { startedAt: submitStartedAt, durationMs: 0 } },
            claim: {
              txHash: null,
              submit: {
                startedAt: submitStartedAt,
                durationMs: this.clock.now() - submitStartedAt
              },
              receipt: null,
              error: classifyUiAssertionError({
                message: error instanceof Error ? error.message : String(error),
                testId: 'claim-tokens-button'
              })
            },
            isClaimedRecheck: null
          };
        }

        try {
          await expect(this.page.getByRole('heading', { name: 'Claim successful' })).toBeVisible({
            timeout: this.claimTimeoutMs
          });
        } catch (error) {
          const alreadyClaimedVisible = await this.page
            .getByText(/already claimed/i)
            .isVisible()
            .catch(() => false);
          const classified = alreadyClaimedVisible
            ? classifyRevertError({
                message: 'AlreadyClaimed()',
                selector: ALREADY_CLAIMED_SELECTOR
              })
            : classifyUiAssertionError({
                message: error instanceof Error ? error.message : String(error),
                testId: 'claim-successful-heading'
              });
          return {
            isClaimedBefore: false,
            isClaimedTiming,
            claimInputs: { claimable: true, timing: { startedAt: submitStartedAt, durationMs: 0 } },
            claim: {
              txHash: null,
              submit: {
                startedAt: submitStartedAt,
                durationMs: this.clock.now() - submitStartedAt
              },
              receipt: null,
              error: classified
            },
            isClaimedRecheck: null
          };
        }

        const receiptAt = this.clock.now();
        const claimExplorerHref = await this.page
          .getByRole('link', { name: /view on explorer/i })
          .getAttribute('href')
          .catch(() => null);
        const claimTxHash = claimExplorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0] as Hex | undefined;
        await this.page
          .getByRole('button', { name: 'Close', exact: true })
          .click()
          .catch(() => undefined);

        return {
          isClaimedBefore: false,
          isClaimedTiming,
          claimInputs: { claimable: true, timing: { startedAt: submitStartedAt, durationMs: 0 } },
          claim: {
            txHash: claimTxHash ?? null,
            submit: { startedAt: submitStartedAt, durationMs: receiptAt - submitStartedAt },
            receipt: { status: 'success', timing: { startedAt: receiptAt, durationMs: 0 } }
          },
          isClaimedRecheck: null
        };
      })
    );
  }

  // -------------------------------------------------------------------------
  // readState() — resumability reads. `allowanceSufficient` stays null in
  // browser mode (no reliable DOM signal without a dedicated locator this
  // driver doesn't add) exactly like headless's native-asset case.
  // -------------------------------------------------------------------------
  async readState(_hop: HopSpec, row: ObservedRow | null): Promise<HopReadState> {
    return this.runExclusive(() =>
      this.runGuarded(async () => {
        let isClaimed = false;
        if (row !== null) {
          // S25: call the underlying fetch directly, NOT the public
          // `observeActivity()` — this call is already running inside
          // THIS driver's own exclusive turn (see `runExclusive`'s doc),
          // and `observeActivity()` re-acquiring the same queue from
          // inside its own turn would deadlock (wait for itself to
          // release, which never happens).
          const rows = await this.fetchActivitySingleFlight();
          isClaimed = rows.some(
            (candidate) => candidate.rowKey === row.rowKey && candidate.status === 'CLAIMED'
          );
        }
        return { allowanceSufficient: null, isClaimed };
      })
    );
  }

  /**
   * Bookkeeping hook for a future runner's DESIGN §7.4 recycling (not
   * exercised by a 1-2 lap smoke run). S25/S26: routed through
   * `runExclusive` so a recycle can never swap `this.context`/`this.page`
   * out from under a lap that is still mid-flight on the OLD page — it now
   * queues behind whatever is currently running (or queued) on this
   * driver, exactly like `bridge`/`claim`/`observeActivity`/`readState`.
   */
  async notifyLapCompleted(recycleAfterLaps: number): Promise<void> {
    this.lapsCompleted += 1;
    if (this.lapsCompleted % recycleAfterLaps !== 0) return;
    await this.runExclusive(async () => {
      this.timingHandle?.uninstall();
      this.timingHandle = null;
      this.context = await this.pool.recycleContext(this.userId);
      await this.openFreshPage();
    });
  }

  async dispose(): Promise<void> {
    this.timingHandle?.uninstall();
    this.timingHandle = null;
    await this.pool.releaseContext(this.userId).catch(() => undefined);
  }

  /**
   * DESIGN §7.3 recovery, driver side: after a `BrowserCrashError` (thrown
   * by `runGuarded` once the pool has relaunched the crashed slot), the
   * caller re-acquires the (recreated) context and re-does `init()`'s
   * navigate+connect so the user's wallet — and therefore ring position —
   * resumes from chain state on the next tick, exactly as DESIGN §7.3
   * describes. Not part of `UserDriver`; a future runner (S11) would call
   * this from whatever catches the crash outcome.
   *
   * S25: routed through `runExclusive` for the same reason as
   * `notifyLapCompleted` — this swaps `this.context`/`this.page` out and
   * must not do so while another queued call is still relying on the old
   * ones. Queueing behind, rather than racing, whatever is currently
   * running/queued also means a call that started just before the crash
   * and is still waiting for its own turn will run against the RECOVERED
   * page once it gets it, not a half-torn-down one.
   */
  async recover(): Promise<void> {
    await this.runExclusive(async () => {
      this.timingHandle?.uninstall();
      this.timingHandle = null;
      this.context = await this.pool.acquireContext(this.userId);
      await this.openFreshPage();
    });
  }

  // -------------------------------------------------------------------------
  // Internals — per-hop wrapped-ERC20-address resolution (finding C14).
  // -------------------------------------------------------------------------
  private async resolveTokenAddress(hop: HopSpec, chain: LoadtestChain): Promise<Address> {
    const originAddress = hop.assetAddress as Address;
    const originNetworkId = this.assets[hop.assetIndex]?.originNetworkId;
    if (originNetworkId === undefined || chain.networkId === originNetworkId) return originAddress;

    const cacheKey = `${originNetworkId}:${originAddress.toLowerCase()}:${chain.networkId}`;
    const cached = this.wrappedAddressCache.get(cacheKey);
    if (cached !== undefined) return cached;

    // S24: driver-internal seeding lookup — DESIGN §9.4/C14 already
    // documents that the real UI has no equivalent code path (it relies on
    // the user manually registering a custom token address), so this is
    // `harness`, not `ui`.
    return runWithFetchContext(
      { userId: this.userId, mode: this.mode, origin: 'harness' },
      async () => {
        const viaMappings = await this.aggregator
          .clientFor(chain.networkId)
          .getTokenMappings({ networkId: chain.networkId, originTokenAddress: originAddress })
          .then((result) => result.token_mappings[0]?.wrapped_token_address ?? null)
          .catch(() => null);

        const ZERO = '0x0000000000000000000000000000000000000000';
        if (viaMappings !== null && viaMappings.toLowerCase() !== ZERO) {
          this.wrappedAddressCache.set(cacheKey, viaMappings as Address);
          return viaMappings as Address;
        }

        const wrapped = (await this.native
          .bridge(chain.bridgeAddress as Address, chain.chainId)
          .getWrappedTokenAddress({
            originNetwork: originNetworkId,
            originTokenAddress: originAddress
          })) as Address;
        if (wrapped.toLowerCase() !== ZERO) this.wrappedAddressCache.set(cacheKey, wrapped);
        return wrapped;
      }
    );
  }

  /**
   * Bounds a page-touching promise (currently only the `observeActivity`
   * `page.evaluate` fetch — see its call site's comment) so a dead
   * page/context/browser cannot hang the driver forever. On timeout,
   * checks `page.isClosed()` to produce a crash-classifiable message when
   * that is in fact what happened, rather than guessing.
   */
  private raceAgainstDeadPage<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const closed = this.page?.isClosed() ?? false;
        reject(
          new Error(
            closed
              ? `${label}: Target page, context or browser has been closed (no response within ${ms}ms)`
              : `${label} timed out after ${ms}ms`
          )
        );
      }, ms);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * Races `fn()` against the pool's event-driven crash notification for
   * THIS user (`BrowserPool.addCrashListener`) — the primary crash defense.
   * Empirically (S10 acceptance run), a page operation whose underlying
   * transport just died can hang far longer than any timeout guess before
   * its own promise settles (a raw `page.evaluate` over a killed
   * `chromium.connect()` server took ~10 minutes to reject on its own in
   * one observed run), so waiting on the operation's own rejection is not
   * reliable. The pool detects `browser.on('disconnected')` /
   * `context.on('close')` within milliseconds (confirmed live), so racing
   * against that signal instead detects the crash immediately regardless
   * of which specific page call was in flight. `isCrashLikeError` below is
   * kept as a secondary net for a crash surfaced as a rejection from `fn()`
   * itself (e.g. a Playwright locator action that DOES reject promptly).
   */
  /**
   * S25 (plan §7 root-cause fix): serializes every operation that touches
   * this driver's shared `page`/`bridgePage`/`context` — `bridge`, `claim`,
   * `observeActivity`, `readState` (via its own internal fetch, see that
   * method's comment), `notifyLapCompleted`'s context-recycle swap, and
   * `recover()`'s crash-recovery swap. Before this fix,
   * `maxInflightLapsPerUser` could put several of ONE user's laps in
   * flight at once (already `>= 2` concurrent laps per user with `>= 2`
   * assets, even at that setting's lowest useful value of 1 per asset),
   * every one of which called straight into this SAME `Page` with no lock
   * at all — exactly the collision the plan's root-cause table names for
   * `locator.click: Timeout exceeded`, `page.evaluate: Execution context
   * was destroyed`, and the "eth only, never erc20" symptom (the two
   * assets' laps fighting over the one token selector). A real user has
   * one tab and does one thing at a time; this makes that true of the
   * driver too, rather than leaving it to whatever `maxInflightLapsPerUser`
   * happens to be configured to. It ALSO closes S26's "verify recycling
   * cannot happen mid-lap" concern by construction: `notifyLapCompleted`
   * and `recover()` now queue behind any lap still using the old page/
   * context, so a recycle/recover can never swap `this.page` out from
   * under an operation that is still running against it.
   *
   * This is a QUEUE, not the single-flight/dedup shape `pool.ts`'s
   * `crashInFlight` and this file's own `fetchActivitySingleFlight` use.
   * Single-flight collapses N concurrent callers onto ONE piece of work and
   * hands every joiner the SAME result — correct for a duplicate READ, but
   * wrong here: two queued `bridge()` calls are two DIFFERENT laps, each of
   * which must actually run and each get its OWN result. Queueing via the
   * obvious `this.mutexTail = this.mutexTail.then(() => fn())` has the
   * exact failure-propagation trap S24 already hit once with single-flight
   * (see `activityFetchInFlight`'s doc): the moment one `fn()` rejects,
   * that chained promise itself becomes REJECTED, and every subsequently-
   * queued `.then(() => fn())` chained off a rejected promise skips
   * straight to rejecting WITHOUT ever calling its own `fn()` — one lap's
   * failure would silently fail (and never even attempt) every lap queued
   * after it.
   *
   * The fix: `mutexTail` is a side-channel promise that NEVER rejects
   * (built from `new Promise<void>((resolve) => ...)` with `resolve` as
   * the only exit), used purely to sequence turns. Each caller's OWN
   * promise — the one actually returned to ITS OWN caller — settles from
   * its OWN `fn()` call, independent of every other queued caller's
   * outcome. `releaseNextTurn()` runs in a `finally`, so it fires whether
   * `fn()` threw, resolved, or (via `runGuarded`'s crash race, which
   * settles as soon as the crash signal wins even if the raw Playwright
   * action underneath is still abandoned in flight) gave up early — so one
   * crashed or failed lap can never leave the queue stuck waiting on it
   * forever.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const myTurn = this.mutexTail;
    let releaseNextTurn: () => void = () => {};
    this.mutexTail = new Promise<void>((resolve) => {
      releaseNextTurn = resolve;
    });
    return myTurn.then(async () => {
      try {
        return await fn();
      } finally {
        releaseNextTurn();
      }
    });
  }

  private async runGuarded<T>(fn: () => Promise<T>): Promise<T> {
    let unsubscribe: () => void = () => {};
    const crashSignal = new Promise<never>((_, reject) => {
      unsubscribe = this.pool.addCrashListener(this.userId, (event) => {
        reject(new BrowserCrashError(classifyBrowserCrash({ message: event.message }).message));
      });
    });
    try {
      return await Promise.race([fn(), crashSignal]);
    } catch (error) {
      if (error instanceof BrowserCrashError) throw error;
      if (isCrashLikeError(error)) {
        this.pool.reportOperationCrash(this.userId, error);
        const classified = classifyBrowserCrash({
          message: error instanceof Error ? error.message : String(error)
        });
        throw new BrowserCrashError(classified.message);
      }
      throw error;
    } finally {
      unsubscribe();
    }
  }
}

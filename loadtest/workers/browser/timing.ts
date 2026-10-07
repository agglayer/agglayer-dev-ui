// Browser network/console instrumentation — DESIGN §5.2 (HTTP samples) and
// §7's "feed S07 with endpoint class + duration". Hooks
// `page.on('request'|'response'|'requestfailed')` so every REAL request the
// PAGE issues (wagmi/viem RPC sends, the app's own tracker/bridge fetches,
// and this driver's own in-page `fetch` calls in `browserUser.ts`'s
// `observeActivity()`) is timed and classed — never a second, parallel
// classifier: `classifyEndpoint` is imported from
// `workers/headless/uiCallset.ts` (S08) so browser and headless samples are
// classed IDENTICALLY, per S10's context pack instruction.
//
// Only requests to a known backend host (the aggkit proxy or one of the
// ring's `rpcUrl`s) are recorded — `classifyEndpoint`'s RPC fallback assumes
// every non-bridge/tracker URL is a JSON-RPC call, which is true for the
// headless worker (it never fetches anything else) but NOT true for a real
// page, which also loads its own JS/CSS/font/image assets from `uiBaseUrl`.
// Without this allowlist every static asset would be misclassified as
// `rpc/<segment>`.
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

import type { DriverMode } from '../../core/userDriver';
import type { Collector, HttpOrigin } from '../../metrics/collector';

import { classifyConsoleError } from '../../metrics/errors';
import { classifyEndpoint } from '../headless/uiCallset';

// S24 / DESIGN §9.3 finding C16: `browserUser.ts`'s `observeActivity()`
// tags its own `page.evaluate`-issued fetch by appending this marker query
// param to the URL it asks the PAGE to fetch (see that file's doc). It is
// harmless on the wire — verified live against the devnet tracker/activity
// endpoint that an unknown query param is ignored and the response body is
// byte-identical — and `classifyEndpoint` never looks at query params for
// `tracker/activity` (only `bridge/*` reads `network_id`), so it cannot
// perturb endpoint classing. This is the ONLY signal available here: once a
// `fetch()` call happens INSIDE the page, Playwright's `page.on('request'|
// 'response')` events cannot otherwise tell the driver's own control-flow
// poll apart from the real UI's independent background poll to the exact
// same URL.
const HARNESS_POLL_MARKER = '_ltPollOrigin=harness';

const originOf = (url: string): HttpOrigin =>
  url.includes(HARNESS_POLL_MARKER) ? 'harness' : 'ui';

export interface BrowserTimingOptions {
  userId: string;
  collector: Collector;
  /** Origins (`new URL(x).origin`) to record traffic for — the aggkit proxy's origin plus every ring chain's `rpcUrl` origin. */
  knownHosts: ReadonlySet<string>;
  clock?: { now(): number };
}

export interface BrowserTimingHandle {
  uninstall(): void;
}

const MODE: DriverMode = 'browser';

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Installs the network + console listeners on one page. One instance per
 * browser user (`browserUser.ts` calls this once from `init()` and
 * `uninstall()`s it from `dispose()`).
 */
export const installBrowserTiming = (
  page: Page,
  options: BrowserTimingOptions
): BrowserTimingHandle => {
  const clock = options.clock ?? { now: () => Date.now() };
  const { collector, userId, knownHosts } = options;
  const startedAtByRequest = new WeakMap<Request, number>();

  const onRequest = (request: Request): void => {
    startedAtByRequest.set(request, clock.now());
  };

  const recordSample = (request: Request, status: number): void => {
    const url = request.url();
    const origin = hostOf(url);
    if (origin === null || !knownHosts.has(origin)) return; // static asset / unrelated traffic
    const startedAt = startedAtByRequest.get(request) ?? clock.now();
    const method = request.method();
    const bodyText = method === 'GET' ? undefined : (request.postData() ?? undefined);
    const endpointClass = classifyEndpoint(url, bodyText);
    // The browser's own network stack retries are indistinguishable from a
    // fresh logical call at this layer (each retry is a full separate
    // `request`/`response` pair Playwright hands us) — unlike the SDK's
    // internal `fetchRawText` retry loop headless mode can approximate by
    // repeated-call windowing, there is no equivalent signal here, so
    // `attempt` is always 0. Documented limitation, not a bug (S10 feedback
    // pack): browser-mode retries simply appear as additional samples.
    collector.recordHttpSample({
      userId,
      mode: MODE,
      endpointClass,
      method,
      status,
      durationMs: clock.now() - startedAt,
      attempt: 0,
      // S24: see the `HARNESS_POLL_MARKER` doc above.
      origin: originOf(url)
    });
  };

  const onResponse = (response: Response): void => {
    recordSample(response.request(), response.status());
  };

  const onRequestFailed = (request: Request): void => {
    // status 0 mirrors installTimingFetch's transport-failure sentinel.
    recordSample(request, 0);
  };

  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== 'error') return;
    // S11 retry defect (3): `message.location().url` is the URL Chromium
    // attaches to a browser-GENERATED console entry (a failed resource
    // load, unlike a script's own `console.error()` call) — for a plain
    // failed `<img>`/fetch it is the failing RESOURCE's own url; for a
    // failed FAVICON-class fetch specifically, Chromium instead attaches
    // its own sentinel host `icon.invalid` (confirmed live: every
    // `net::ERR_NAME_NOT_RESOLVED` console entry this run produced carried
    // exactly that — see `errors.ts`'s `BENIGN_EXTERNAL_ASSET_HOSTS` doc).
    // Either way this is a real improvement over the previous `page.url()`
    // (always the app's own route), which could never match
    // `matchesNotReady`'s endpoint-needle check (a not-ready 404 console
    // echo was never reclassified back to `not_ready`) NOR identify
    // anything about which resource actually failed — the activity.ndjson
    // error line kept no URL/host at all. Falls back to `page.url()` only
    // if Chromium didn't attach a location url.
    const url = message.location().url || page.url();
    const classified = classifyConsoleError({ message: message.text(), url });
    const origin = hostOf(url);
    collector.error({
      userId,
      mode: MODE,
      errorClass: classified.errorClass,
      message: classified.message,
      endpointClass: origin ?? url
    });
  };

  const onPageError = (error: Error): void => {
    const classified = classifyConsoleError({ message: error.message });
    collector.error({
      userId,
      mode: MODE,
      errorClass: classified.errorClass,
      message: classified.message
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    uninstall() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    }
  };
};

/**
 * DESIGN §5.1: `page_load`/`wallet_connect` are browser-only phases that
 * ring.ts structurally has no home for (they happen once per user session,
 * outside any hop — confirmed: neither name appears anywhere in
 * `core/ring.ts`). Per `core/userDriver.ts`'s own module doc, this is the
 * ONE other place (besides HTTP samples) a driver is expected to touch the
 * collector directly, mirroring how `headlessUser.ts` is allowed to for
 * `recordHttpSample`. `hopRoute`/`assetKind` have no meaningful value for a
 * whole-session phase, so both are given fixed sentinels (`'init'` /
 * `'eth'`) — flagged here for S11/S20, since DESIGN does not specify one.
 */
export const recordSessionPhase = (
  collector: Collector,
  phase: 'page_load' | 'wallet_connect',
  durationMs: number
): void => {
  collector.recordPhase({ phase, mode: MODE, hopRoute: 'init', assetKind: 'eth', durationMs });
};

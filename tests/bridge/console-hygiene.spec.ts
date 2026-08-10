import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

import {
  E2E_BACKEND_MODE,
  E2E_BRIDGE_SUCCESS_TIMEOUT_MS,
  E2E_FROM_CHAIN_ID,
  E2E_NATIVE_BRIDGE_AMOUNT,
  E2E_TO_CHAIN_ID
} from '@/app/constants/e2e';
import { expect, test } from '@playwright/test';

import { BridgePage } from './models/bridge-page';

// Regression test for the S6 interactive console-error QA triage. That triage drove the real
// AppKit UI (no E2E bypass) through the full 11-phase bridge journey and
// classified every console error/warning + failed request observed. This
// spec turns "no NEW console noise" into a property CI can enforce: it
// drives a *lighter* core journey (same devnet, same aggkit backend,
// Playwright's own E2E-bypassed wallet -- see the note below), collects
// every console error/warning and failed/error-status request for the
// whole run, and asserts nothing appears outside an explicit allowlist
// where every entry cites the triage row that classified it
// environmental/upstream.
//
// IMPORTANT caveat (see console-triage.md's "S8 fix disposition" section):
// playwright.config.ts forces NEXT_PUBLIC_E2E_ENABLED=true for every
// webServer it launches, and app/context/wallet.tsx skips
// `createAppKit(...)` entirely under that flag (IS_E2E_ENABLED), using a
// mocked LocalWalletProvider instead of the real Reown/AppKit widget. That
// means triage rows 3-11 and 16 (all Reown/AppKit/WalletConnect noise) are
// NOT actually exercised by this spec today -- their allowlist entries below
// are precautionary/documentary (they match nothing right now, but keep this
// spec correct if that E2E bypass is ever narrowed or a future change makes
// AppKit initialize during Playwright runs). What this spec DOES exercise
// live, every run, is aggkit's own polling noise (rows 1-2) and the app's
// own request traffic -- that's where a real regression would show up.
// Verifying the Reown/AppKit degradation itself (does row 3/4's
// fixed-by-degradation half of the fix actually suppress those calls
// against the real widget) requires an interactive session, not Playwright
// -- flagged for S9's full interactive re-run.
test.skip(
  E2E_BACKEND_MODE !== 'devnet',
  'Console hygiene depends on devnet-specific aggkit polling behavior (rows 1-2); see the comment above.'
);

type CapturedIssue = {
  kind: 'console' | 'network';
  level: 'error' | 'warning';
  text: string;
  url: string;
};

type AllowlistEntry = {
  // Cites the triage row (or "dev-mode" for browser/Next.js-standard noise
  // not tabled with its own row number) that classified this as
  // environmental/upstream, not a dev-ui bug.
  row: string;
  note: string;
  matches: (issue: CapturedIssue) => boolean;
};

const urlIncludes = (issue: CapturedIssue, needle: string) => issue.url.includes(needle);
const textIncludes = (issue: CapturedIssue, needle: string) => issue.text.includes(needle);

const ALLOWLIST: AllowlistEntry[] = [
  {
    row: 'triage row 1',
    note: 'aggkit /l1-info-tree-index 500 ("not yet included") -- documented, intentional not-ready polling contract; SDK treats it as null, not suppressible from dev-ui/SDK (browser logs any non-2xx fetch regardless of JS handling).',
    matches: (issue) => urlIncludes(issue, '/bridge/v1/l1-info-tree-index')
  },
  {
    row: 'triage row 2',
    note: 'aggkit /injected-l1-info-leaf 404 ("GER not yet injected") -- same not-ready polling contract as row 1.',
    matches: (issue) => urlIncludes(issue, '/bridge/v1/injected-l1-info-leaf')
  },
  {
    row: 'triage row 3',
    note: "Reown/AppKit remote-config+asset fetches to api.web3modal.org (config, project-limits, getWallets, getAssetImage) with a placeholder projectId. S8 degrades 2 of 4 via `basic: true`; the other 2 are documented-unsuppressible (see console-triage.md). Currently inert under this spec's E2E bypass -- see the file-level comment.",
    matches: (issue) => urlIncludes(issue, 'api.web3modal.org')
  },
  {
    row: 'triage row 4',
    note: '"[Reown Config] Failed to fetch remote project configuration" / "Failed to fetch usage" -- AppKit\'s own console.warn wrappers around row 3\'s calls. Currently inert under this spec\'s E2E bypass.',
    matches: (issue) =>
      textIncludes(issue, '[Reown Config] Failed to fetch remote project configuration') ||
      textIncludes(issue, 'Failed to fetch usage')
  },
  {
    row: 'triage row 5',
    note: "WalletConnect identity lookup (rpc.walletconnect.org) 401 with a placeholder projectId -- fires on every account sync regardless of AppKit options, documented-unsuppressible. Currently inert under this spec's E2E bypass.",
    matches: (issue) => urlIncludes(issue, 'rpc.walletconnect.org')
  },
  {
    row: 'triage row 6',
    note: "WalletConnect analytics batch (pulse.walletconnect.org) -- AppKit's MANDATORY_EVENTS bypass features.analytics:false by design, documented-unsuppressible. Currently inert under this spec's E2E bypass.",
    matches: (issue) => urlIncludes(issue, 'pulse.walletconnect.org')
  },
  {
    row: 'triage row 8',
    note: "<svg> attribute width/height errors from @phosphor-icons/webcomponents, bundled transitively by @reown/appkit UI. Currently inert under this spec's E2E bypass.",
    matches: (issue) => textIncludes(issue, '<svg> attribute')
  },
  {
    row: 'triage row 9',
    note: 'w3m-footer / w3m-router-container "scheduled an update" Lit diagnostic, internal to @reown/appkit-ui. Currently inert under this spec\'s E2E bypass.',
    matches: (issue) =>
      textIncludes(issue, 'scheduled an update') &&
      (textIncludes(issue, 'w3m-footer') || textIncludes(issue, 'w3m-router-container'))
  },
  {
    row: 'triage row 10',
    note: "fonts.reown.com preloaded-but-unused warnings from @reown/appkit-ui's initializeTheming. Currently inert under this spec's E2E bypass.",
    matches: (issue) => urlIncludes(issue, 'fonts.reown.com')
  },
  {
    row: 'triage row 11',
    note: '"Lit is in dev mode" -- Lit\'s own dev-mode self-check, bundled via @reown/appkit-ui, absent under a production build. Currently inert under this spec\'s E2E bypass.',
    matches: (issue) => textIncludes(issue, 'Lit is in dev mode')
  },
  {
    row: 'dev-mode (triage row 15)',
    note: "HEAD prefetch requests to the app's own routes, cancelled by a subsequent navigation -- standard Next.js router prefetch-cancellation behavior.",
    matches: (issue) => issue.kind === 'network' && textIncludes(issue, 'ERR_ABORTED')
  },
  {
    row: 'triage row 16',
    note: "Coinbase Wallet SDK analytics beacon (cca-lite.coinbase.com), bundled transitively via @reown/appkit-adapter-wagmi's default connector set. Excluding the connector is a product decision outside this audit's scope.",
    matches: (issue) => urlIncludes(issue, 'cca-lite.coinbase.com')
  },
  {
    // NOT a console-triage.md row -- discovered while authoring this spec,
    // documented here instead since it's an artifact of the shared E2E
    // devnet wallet's history, not something the S6 triage journey (a
    // different, native-only wallet) ever exercised. Root-caused via a CDP
    // Network.requestWillBeSent + live-DOM probe: this wallet has an older,
    // already-`Completed` ERC20 bridge transaction (from a prior
    // erc20-approve-bridge.spec.ts run against this same persistent
    // enclave+wallet) whose origin token ("E2E", the test-only contract
    // tests/e2e/globalSetup.ts deploys) has no local token-list entry and no
    // hosted icon on Polygon's asset CDN. transactionListItem.tsx's
    // `getTokenLogoBySymbol` fallback (app/utils/tokens.ts) then requests
    // `https://assets.polygon.technology/tokenAssets/e2e.svg`, which 404s /
    // gets ORB-blocked. This is a real (if minor) gap in the CDN-fallback's
    // handling of unhosted symbols, but it's orthogonal to every S8 work
    // item -- it existed before this spec and isn't touched by any change in
    // this commit. Flagged in the S8 report for a future pass rather than
    // fixed here (out of this step's chartered scope).
    row: 'discovered-during-S8 (not a triage row)',
    note: 'assets.polygon.technology token-icon CDN 404/ORB for the test-only "E2E" ERC20 symbol on an already-completed historical transaction in the shared E2E wallet -- pre-existing, unrelated to any S8 change.',
    matches: (issue) => urlIncludes(issue, 'assets.polygon.technology/tokenAssets/')
  }
];

const classifyIssue = (issue: CapturedIssue): AllowlistEntry | undefined =>
  ALLOWLIST.find((entry) => entry.matches(issue));

const attachCollectors = (page: Page) => {
  const consoleIssues: CapturedIssue[] = [];
  const networkIssues: CapturedIssue[] = [];

  const onConsole = (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    consoleIssues.push({
      kind: 'console',
      level: type,
      text: msg.text(),
      url: msg.location().url
    });
  };

  const onResponse = (response: Response) => {
    if (response.status() < 400) return;
    networkIssues.push({
      kind: 'network',
      level: 'error',
      text: `HTTP ${response.status()} ${response.statusText()}`,
      url: response.url()
    });
  };

  const onRequestFailed = (request: Request) => {
    networkIssues.push({
      kind: 'network',
      level: 'error',
      text: request.failure()?.errorText ?? 'request failed',
      url: request.url()
    });
  };

  page.on('console', onConsole);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return {
    consoleIssues,
    networkIssues,
    detach: () => {
      page.off('console', onConsole);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    }
  };
};

// Renders each unclassified issue with enough context (level, url, text) to
// triage a genuine new regression without re-running the spec.
const formatUnexpected = (issues: CapturedIssue[]): string =>
  issues
    .map(
      (issue, index) =>
        `${index + 1}. [${issue.kind}/${issue.level}] ${issue.text}\n   ${issue.url}`
    )
    .join('\n');

test('core journey produces no console errors/warnings outside the documented allowlist', async ({
  page
}) => {
  test.setTimeout(E2E_BRIDGE_SUCCESS_TIMEOUT_MS + 60_000);

  const { consoleIssues, networkIssues, detach } = attachCollectors(page);
  const bridgePage = new BridgePage({ page });

  try {
    // load -> connect -> transactions page -> open/close details modal.
    // A quick native bridge guarantees a transaction row exists (rather than
    // depending on whatever history the shared E2E wallet happens to already
    // have on the live enclave), and its still-pending status keeps
    // TrackerDetail mounted when the modal opens (transactionDetailsModal.tsx
    // only mounts it while status !== 'CLAIMED') -- exercising that
    // component's console behavior too, not just the row list's.
    await bridgePage.navigate();
    await bridgePage.connectWallet();
    await bridgePage.selectChainPair(E2E_FROM_CHAIN_ID, E2E_TO_CHAIN_ID);
    await bridgePage.fillAmount(E2E_NATIVE_BRIDGE_AMOUNT);
    await bridgePage.submitBridge();
    await bridgePage.waitForTransactionModal();
    await bridgePage.waitForBridgeSuccess();

    const explorerHref = await bridgePage.bridgeSuccessExplorerLink.getAttribute('href');
    const transactionHash = explorerHref?.match(/0x[a-fA-F0-9]{64}$/)?.[0];
    if (!transactionHash) {
      throw new Error(
        'console-hygiene: could not read the bridge transaction hash from the success view'
      );
    }

    await bridgePage.bridgeSuccessCta.click();
    await expect(bridgePage.getTransactionRow(transactionHash)).toBeVisible();

    await bridgePage.openTransactionDetails(transactionHash);
    await expect(bridgePage.trackerDetail).toBeVisible();

    await bridgePage.closeTransactionDetailsModal();
    await expect(bridgePage.trackerDetail).toHaveCount(0);
  } finally {
    detach();
  }

  const allIssues = [...consoleIssues, ...networkIssues];
  const unexpectedErrors = allIssues.filter(
    (issue) => issue.level === 'error' && !classifyIssue(issue)
  );

  // Warnings are asserted against the same allowlist rather than
  // errors-only: every warning-producing source in this repo's dependency
  // tree (rows 4, 9, 10, 11) is already enumerated above from the S6/S8
  // triage work, so there's no flaky/unknown warning source to carve out --
  // an unclassified warning is just as much a signal of a new regression as
  // an unclassified error.
  const unexpectedWarnings = allIssues.filter(
    (issue) => issue.level === 'warning' && !classifyIssue(issue)
  );

  expect(unexpectedErrors, formatUnexpected(unexpectedErrors)).toEqual([]);
  expect(unexpectedWarnings, formatUnexpected(unexpectedWarnings)).toEqual([]);
});

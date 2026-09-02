import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  containerTestsUnavailableReason,
  getContainerImageDigest,
  getImageDigest,
  removeContainer,
  runContainer,
  waitForHttpResponse
} from './docker';

// T-1: exercises the REAL agglayer-dev-ui:c1-test image (built by C-1) via a
// real Chromium session, rather than `next dev`. This is the first time the
// static export produced by the Docker build has been driven by a browser at
// all -- see plans/dev-ui-docker-ghcr/c2-runtime-config-proof.md §4, whose
// browser-proof technique (drive the running container with Playwright,
// gate on AppConfigGate's test-ids, read the chain-selector text) this file
// turns into a permanent, repeatable spec instead of a throwaway script.
test.skip(
  () => Boolean(containerTestsUnavailableReason()),
  containerTestsUnavailableReason() ?? ''
);

const HOST_PORT = 19180;
const CONTAINER_NAME = 't1-container-app';
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
const CONFIG_A_PATH = path.resolve(__dirname, 'fixtures', 'config-a.json');

// config-a.json's devnet mode -- see tests/container/fixtures/config-a.json.
// Hardcoded rather than read via tests/e2e/appConfig.ts's loadAppConfigForNode
// deliberately: that helper reads the REPO ROOT config.json, not this
// directory's fixture, and asserting against the fixture's own known values
// is what actually proves the mounted file (not some other config) drove the
// render.
const CONFIG_A_FROM_CHAIN_NAME = 'Devnet L1';
const CONFIG_A_TO_CHAIN_NAME = 'Devnet L2-001';

type CapturedIssue = {
  kind: 'console' | 'network';
  level: 'error' | 'warning';
  text: string;
  url: string;
};

type AllowlistEntry = {
  // Cites the triage row from tests/bridge/console-hygiene.spec.ts's own
  // ALLOWLIST that classified this noise as environmental/upstream --
  // reusing that spec's allowlist idiom rather than inventing a new
  // classification scheme.
  row: string;
  note: string;
  matches: (issue: CapturedIssue) => boolean;
};

const urlIncludes = (issue: CapturedIssue, needle: string) => issue.url.includes(needle);
const textIncludes = (issue: CapturedIssue, needle: string) => issue.text.includes(needle);

// Unlike tests/bridge/console-hygiene.spec.ts (which runs under
// playwright.config.ts's NEXT_PUBLIC_E2E_ENABLED=true bypass, so
// app/context/wallet.tsx never calls the real createAppKit()), this
// container was built by `pnpm run build:production` with no E2E flag --
// the exact same build a real deployment ships. So rows 3/4/10/16, which
// console-hygiene.spec.ts documents as "currently inert" precaution-only
// entries, are LIVE here: this spec is the first one in the repo that
// actually observes AppKit's real degraded-mode (`basic: true`, placeholder
// NEXT_PUBLIC_PROJECT_ID -- see Dockerfile's build:production comment and
// a1-runtime-config-design.md §6.3) network chatter. Empirically captured by
// running this exact container+fixture combination locally (see this step's
// feedback pack) rather than guessed.
const ALLOWLIST: AllowlistEntry[] = [
  {
    row: 'triage row 3 (console-hygiene.spec.ts)',
    note: "Reown/AppKit remote-config fetch to api.web3modal.org with the image's baked placeholder projectId (YOUR_PROJECT_ID_HERE) -- 403 is expected for a placeholder id. LIVE in this spec (not inert), because this container's build has no E2E bypass.",
    matches: (issue) => urlIncludes(issue, 'api.web3modal.org')
  },
  {
    row: 'triage row 4 (console-hygiene.spec.ts)',
    note: '"Failed to fetch usage" -- AppKit\'s own console.warn wrapper around row 3\'s 403. LIVE in this spec.',
    matches: (issue) => textIncludes(issue, 'Failed to fetch usage')
  },
  {
    row: 'triage row 10 (console-hygiene.spec.ts)',
    note: "fonts.reown.com preloaded-but-unused warning from @reown/appkit-ui's initializeTheming. The browser reports this as a bare console.warn (its location is the page document, not the font URL), so this matches on message text rather than issue.url. LIVE in this spec.",
    matches: (issue) => textIncludes(issue, 'fonts.reown.com')
  },
  {
    row: 'triage row 15 / dev-mode (console-hygiene.spec.ts)',
    note: "HEAD/navigation prefetch requests to the app's own routes (e.g. /transactions), cancelled by Next.js router prefetch-cancellation -- standard behavior, not specific to E2E bypass.",
    matches: (issue) =>
      issue.kind === 'network' && textIncludes(issue, 'ERR_ABORTED') && urlIncludes(issue, BASE_URL)
  },
  {
    row: 'triage row 16 (console-hygiene.spec.ts)',
    note: "Coinbase Wallet SDK analytics beacon (cca-lite.coinbase.com), bundled transitively via @reown/appkit-adapter-wagmi's default connector set. LIVE in this spec.",
    matches: (issue) => urlIncludes(issue, 'cca-lite.coinbase.com')
  },
  {
    row: 'X-1: transport-level failure reaching a NON-app origin',
    note:
      'Any endpoint this page dials that is not the container itself is an environment ' +
      'property, not an app defect: the mounted fixture config points rpcUrl at the ' +
      "kurtosis devnet's ephemeral host port (http://127.0.0.1:<port>/l1rpc) and iconUrl " +
      'at raw.githubusercontent.com, and AppKit pulls fonts from fonts.reown.com. X-1 ' +
      'measured this: with the devnet down but egress up, 8 issues went unclassified ' +
      '(ERR_CONNECTION_REFUSED on the L1 rpcUrl); with all egress blocked, 27 went ' +
      'unclassified (fonts.reown.com and raw.githubusercontent.com — note row 10 matches ' +
      'on message TEXT, and a blocked request\'s text is "net::ERR_NAME_NOT_RESOLVED" ' +
      'with the host only in the URL, so it did not catch them). Without this entry the ' +
      'spec passes only on a machine that happens to have a live enclave AND outbound ' +
      'egress, which contradicts this suite\'s "no devnet required" contract and would ' +
      'make it red on a CI runner. Deliberately scoped: app-origin failures (BASE_URL) ' +
      'and every console/JS error still fail the test.',
    matches: (issue) =>
      !urlIncludes(issue, BASE_URL) &&
      /net::ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|CONNECTION_RESET|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|ABORTED|EMPTY_RESPONSE|PROXY_CONNECTION_FAILED)\b/.test(
        issue.text
      )
  },
  {
    row: 'X-1: Coinbase Analytics SDK fetch rejection (companion to row 16)',
    note:
      'The same cca-lite.coinbase.com beacon as row 16, but surfaced as a JS-level ' +
      'console error from the SDK\'s own catch handler ("Analytics SDK: TypeError: ' +
      'Failed to fetch") whose reported location is <anonymous>, so neither the host ' +
      'matcher nor the transport matcher above sees it. Only appears when egress is ' +
      'blocked entirely (X-1 measured it on a fully network-isolated simulation); ' +
      "matched narrowly on the SDK's own message prefix.",
    matches: (issue) =>
      textIncludes(issue, 'Analytics SDK:') && textIncludes(issue, 'Failed to fetch')
  }
];

const classifyIssue = (issue: CapturedIssue): AllowlistEntry | undefined =>
  ALLOWLIST.find((entry) => entry.matches(issue));

const formatUnexpected = (issues: CapturedIssue[]): string =>
  issues
    .map(
      (issue, index) =>
        `${index + 1}. [${issue.kind}/${issue.level}] ${issue.text}\n   ${issue.url}`
    )
    .join('\n');

const attachCollectors = (page: Page) => {
  const issues: CapturedIssue[] = [];

  const onConsole = (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    issues.push({ kind: 'console', level: type, text: msg.text(), url: msg.location().url });
  };
  const onResponse = (response: Response) => {
    if (response.status() < 400) return;
    issues.push({
      kind: 'network',
      level: 'error',
      text: `HTTP ${response.status()} ${response.statusText()}`,
      url: response.url()
    });
  };
  const onRequestFailed = (request: Request) => {
    issues.push({
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
    issues,
    detach: () => {
      page.off('console', onConsole);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    }
  };
};

test.describe('container: real built image, mounted config', () => {
  test.beforeAll(async () => {
    removeContainer(CONTAINER_NAME);
    runContainer({ name: CONTAINER_NAME, hostPort: HOST_PORT, configPath: CONFIG_A_PATH });
    await waitForHttpResponse(`${BASE_URL}/config.json`);
  });

  test.afterAll(() => {
    removeContainer(CONTAINER_NAME);
  });

  test('same image digest is running as the C-1 artifact under test (no rebuild)', () => {
    const runningDigest = getContainerImageDigest(CONTAINER_NAME);
    const imageDigest = getImageDigest();
    expect(runningDigest).toBe(imageDigest);
  });

  test('renders the app and reflects the mounted config.json chains, with no unexpected console noise', async ({
    page
  }) => {
    const { issues, detach } = attachCollectors(page);

    try {
      await page.goto(BASE_URL);

      // AppConfigGate: must leave 'pending' and never land on 'error'.
      await expect(page.getByTestId('app-config-loading')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('app-config-error')).toHaveCount(0);

      await expect(page.getByTestId('bridge-card')).toBeVisible();

      // Wallet-free assertion points (no connect, no signature) -- the
      // chain names come straight from the MOUNTED config.json's
      // defaultFromChainKey/defaultToChainKey, not from any repo-root file
      // baked into the image (the image's baked default has different,
      // placeholder-URL chains entirely -- see entrypoint.sh's header
      // comment and a1-runtime-config-design.md §6.3).
      await expect(page.getByTestId('from-chain-selector')).toContainText(CONFIG_A_FROM_CHAIN_NAME);
      await expect(page.getByTestId('to-chain-selector')).toContainText(CONFIG_A_TO_CHAIN_NAME);

      // Let any async post-load noise (AppKit init, font preload timers)
      // surface before asserting the allowlist -- mirrors
      // console-hygiene.spec.ts's approach of only asserting after the
      // interaction under test has fully settled.
      await page.waitForTimeout(4000);
    } finally {
      detach();
    }

    const unexpected = issues.filter((issue) => !classifyIssue(issue));
    expect(unexpected, formatUnexpected(unexpected)).toEqual([]);
  });
});

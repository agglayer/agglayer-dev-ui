import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  containerTestsUnavailableReason,
  getContainerLogs,
  getContainerState,
  removeContainer,
  runContainer,
  waitForContainerExit,
  waitForHttpResponse
} from './docker';

// T-1's negative test: an invalid mounted config must surface the intended
// failure, not a blank page. Per
// plans/dev-ui-docker-ghcr/c2-runtime-config-proof.md §6 and
// a1-runtime-config-design.md §6.3/entrypoint.sh's header comment, there are
// TWO distinct invalid-config failure modes with different blast radii:
//
//   1. jq-STRUCTURALLY-valid but Zod-schema-invalid: entrypoint.sh's jq
//      check only looks at top-level shape (chains is a non-empty object,
//      appModes.default/configs agree, autoclaim/externalLinks are
//      objects) -- it does not validate individual field values. Such a
//      config passes the container and nginx starts, and the failure
//      surfaces only in the BROWSER, at AppConfigGate's real Zod validator.
//      This is the case this step's acceptance criteria calls out by name
//      ("jq-valid but schema-invalid config passes the container and fails
//      in the browser at the gate") -- covered by the first test below.
//   2. jq-STRUCTURALLY-invalid: entrypoint.sh's own check fails, the
//      container never starts nginx and exits 1 immediately. Covered
//      separately (not a browser test) by the second test below, per the
//      step's "if practical, note the container-fatal case separately".
test.skip(
  () => Boolean(containerTestsUnavailableReason()),
  containerTestsUnavailableReason() ?? ''
);

const SCHEMA_INVALID_CONFIG_PATH = path.resolve(
  __dirname,
  'fixtures',
  'config-invalid-schema.json'
);
const STRUCTURAL_INVALID_CONFIG_PATH = path.resolve(
  __dirname,
  'fixtures',
  'config-invalid-structural.json'
);

test.describe('browser-visible case: jq-valid, Zod-invalid config', () => {
  const HOST_PORT = 19182;
  const CONTAINER_NAME = 't1-container-invalid-schema';
  const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;

  test.beforeAll(async () => {
    removeContainer(CONTAINER_NAME);
    // tests/container/fixtures/config-invalid-schema.json is config-a.json
    // with chains.DEVNET_L1.rpcUrl set to "not-a-url" -- entrypoint.sh's jq
    // check never inspects nested chain fields, so this file passes the
    // container's structural gate (verified independently while authoring
    // this fixture: `jq -e '<entrypoint's exact expression>'` exits 0
    // against this file) and nginx starts normally.
    runContainer({
      name: CONTAINER_NAME,
      hostPort: HOST_PORT,
      configPath: SCHEMA_INVALID_CONFIG_PATH
    });
    await waitForHttpResponse(`${BASE_URL}/config.json`);
  });

  test.afterAll(() => {
    removeContainer(CONTAINER_NAME);
  });

  test('container starts and serves the invalid file unmodified (proves the failure is browser-side, not container-side)', () => {
    const state = getContainerState(CONTAINER_NAME);
    expect(state.status).toBe('running');
  });

  test('the browser gate renders app-config-error, not a blank page, and never mounts the wallet UI', async ({
    page
  }) => {
    await page.goto(BASE_URL);

    // Must resolve to the error state, not hang on loading nor render
    // children.
    await expect(page.getByTestId('app-config-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('app-config-loading')).toHaveCount(0);

    const errorText = await page.getByTestId('app-config-error').innerText();
    // config/configValidator.mjs's parseConfigOrThrow message shape --
    // asserting on it (not just "an error screen exists") proves this is
    // the REAL Zod schema failure this fixture was built to trigger, not
    // some unrelated fetch/network error rendering the same test-id.
    expect(errorText).toContain('schema validation failed');
    expect(errorText).toContain('rpcUrl');

    // AppConfigGate's early return means AppModeProvider/WalletProvider
    // never mount (a1-runtime-config-design.md §3.4) -- assert that
    // directly rather than only inferring it from the error screen's
    // presence: the header (and its connect-wallet control) lives inside
    // <Providers>, below the gate.
    await expect(page.getByTestId('header-desktop')).toHaveCount(0);
    await expect(page.getByTestId('connect-wallet')).toHaveCount(0);
    await expect(page.getByTestId('bridge-card')).toHaveCount(0);

    // The gate's Retry button is present and re-runs the same (still
    // invalid) fetch -- clicking it must re-land on the same error state,
    // not crash or silently succeed.
    await page.getByTestId('app-config-retry').click();
    await expect(page.getByTestId('app-config-error')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('container-fatal case: jq-structurally-invalid config (noted separately, not a browser test)', () => {
  const HOST_PORT = 19183;
  const CONTAINER_NAME = 't1-container-invalid-structural';

  test.afterAll(() => {
    removeContainer(CONTAINER_NAME);
  });

  test('container refuses to start, exits 1, and never listens', async () => {
    removeContainer(CONTAINER_NAME);
    // tests/container/fixtures/config-invalid-structural.json sets
    // appModes.default to a mode with no matching appModes.configs entry --
    // exactly the structural rule entrypoint.sh's jq expression
    // `(.appModes.configs[.appModes.default]? != null)` enforces. Verified
    // independently while authoring this fixture that jq's structural check
    // exits 1 against this file (same technique
    // c2-runtime-config-proof.md §1/§6 used for its own config-3-invalid.json).
    runContainer({
      name: CONTAINER_NAME,
      hostPort: HOST_PORT,
      configPath: STRUCTURAL_INVALID_CONFIG_PATH
    });

    const state = await waitForContainerExit(CONTAINER_NAME, 10_000);
    expect(state.status).toBe('exited');
    expect(state.exitCode).toBe(1);

    const logs = getContainerLogs(CONTAINER_NAME);
    expect(logs).toContain('FATAL');
    expect(logs).toContain('Refusing to start');
    // nginx's own startup notice must never appear -- proves the failure
    // happened before `exec nginx`, not as a crash after it started.
    expect(logs).not.toContain('nginx/');
  });
});

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

// T-1's browser-level assertion of the runtime-config contract (per the
// step's acceptance criteria): "container with config A -> UI reflects A;
// restart the same image with config B -> UI reflects B." This is the
// browser-driven counterpart to
// plans/dev-ui-docker-ghcr/c2-runtime-config-proof.md, which proved the same
// property at the docker-inspect/curl level (§0-§3) and once, ad hoc, at the
// browser level (§4) with a throwaway script. This file makes that browser
// proof a permanent, repeatable spec using this repo's own fixtures.
test.skip(
  () => Boolean(containerTestsUnavailableReason()),
  containerTestsUnavailableReason() ?? ''
);

const HOST_PORT = 19181;
const CONTAINER_NAME = 't1-container-swap';
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;

const CONFIG_A_PATH = path.resolve(__dirname, 'fixtures', 'config-a.json');
const CONFIG_B_PATH = path.resolve(__dirname, 'fixtures', 'config-b.json');

// See tests/container/fixtures/config-{a,b}.json. Deliberately disjoint
// chain names/ids between the two fixtures so a match against the wrong one
// is impossible to miss.
const CONFIG_A_NAMES = { from: 'Devnet L1', to: 'Devnet L2-001' };
const CONFIG_B_NAMES = { from: 'T1 Fixture Prime', to: 'T1 Fixture Secunda' };

test.afterAll(() => {
  removeContainer(CONTAINER_NAME);
});

test('restarting the same image with a different mounted config changes what the browser renders', async ({
  page
}) => {
  const imageDigestUnderTest = getImageDigest();

  // --- Run 1: config A ---
  removeContainer(CONTAINER_NAME);
  runContainer({ name: CONTAINER_NAME, hostPort: HOST_PORT, configPath: CONFIG_A_PATH });
  await waitForHttpResponse(`${BASE_URL}/config.json`);

  const digestRunA = getContainerImageDigest(CONTAINER_NAME);
  expect(digestRunA, 'run A must be the exact image under test').toBe(imageDigestUnderTest);

  await page.goto(BASE_URL);
  await expect(page.getByTestId('app-config-error')).toHaveCount(0);
  await expect(page.getByTestId('from-chain-selector')).toContainText(CONFIG_A_NAMES.from);
  await expect(page.getByTestId('to-chain-selector')).toContainText(CONFIG_A_NAMES.to);

  // --- "Restart the same image" with config B. The operational contract
  // (a1-runtime-config-design.md §8: "read once per page load ... restart
  // the container to apply a new configuration") is a full container
  // restart, not a live reload -- so this removes and re-runs the
  // container, from the SAME image tag/digest, with a different bind mount.
  // This is the exact mechanism C-2 verified never triggers a rebuild.
  removeContainer(CONTAINER_NAME);
  runContainer({ name: CONTAINER_NAME, hostPort: HOST_PORT, configPath: CONFIG_B_PATH });
  await waitForHttpResponse(`${BASE_URL}/config.json`);

  const digestRunB = getContainerImageDigest(CONTAINER_NAME);
  expect(digestRunB, 'run B must be the SAME image digest as run A (no rebuild)').toBe(digestRunA);

  // A hard navigation (not client-side routing) is required: AppConfigGate
  // reads config exactly once per page load (design.md §8, "R12 — explicit
  // non-support statement") by design, so reusing the same Page/tab without
  // reloading would only prove the browser cache, not the new container.
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });

  await expect(page.getByTestId('app-config-error')).toHaveCount(0);
  await expect(page.getByTestId('from-chain-selector')).toContainText(CONFIG_B_NAMES.from);
  await expect(page.getByTestId('to-chain-selector')).toContainText(CONFIG_B_NAMES.to);

  // And the previous config's chain names must be gone, not just "B's names
  // are present somewhere" -- guards against a stale-cache false pass.
  await expect(page.getByTestId('from-chain-selector')).not.toContainText(CONFIG_A_NAMES.from);
  await expect(page.getByTestId('to-chain-selector')).not.toContainText(CONFIG_A_NAMES.to);
});

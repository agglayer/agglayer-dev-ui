import { execFileSync, spawnSync } from 'node:child_process';

// Shared helpers for the T-1 container E2E specs (tests/container/*.spec.ts).
// These specs exercise the REAL built artifact -- the agglayer-dev-ui:c1-test
// image produced by C-1 -- rather than `next dev`, which is what every other
// Playwright spec in this repo runs against (see playwright.config.ts). They
// are driven by playwright.container.config.ts, a separate config file so
// this suite never requires the devnet-only env vars
// (E2E_PRIVATE_KEY/NEXT_PUBLIC_PROJECT_ID/NEXT_PUBLIC_AGGKIT_PROXY) that
// playwright.config.ts hard-requires at module scope, and never starts the
// `next dev` webServers -- this suite's only dependency is Docker + the
// prebuilt image.

export const IMAGE_TAG = 'agglayer-dev-ui:c1-test';
export const MOUNTED_CONFIG_PATH = '/etc/agglayer-dev-ui/config.json';

/** True when the Docker daemon is reachable from this host. */
export const isDockerAvailable = (): boolean => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** True when the exact image under test (built by C-1) is present locally. */
export const isTestImageAvailable = (): boolean => {
  try {
    const out = execFileSync('docker', ['images', '-q', IMAGE_TAG], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
};

/**
 * One combined gate for `test.skip(...)` at the top of every spec in this
 * directory: skips cleanly (not a failure) whenever Docker isn't reachable or
 * the C-1 image hasn't been built, exactly like this repo's existing
 * `E2E_BACKEND_MODE`-based skip idiom (see console-hygiene.spec.ts /
 * l2-to-l2.spec.ts) does for devnet-only specs.
 */
export const containerTestsUnavailableReason = (): string | undefined => {
  if (!isDockerAvailable()) {
    return 'Docker is not available on this host (docker info failed) -- skipping container E2E specs.';
  }
  if (!isTestImageAvailable()) {
    return `Image ${IMAGE_TAG} is not present locally (build it per plans/dev-ui-docker-ghcr/c1 before running this suite) -- skipping container E2E specs.`;
  }
  return undefined;
};

/** The full image content digest, for asserting "same image, no rebuild" across runs. */
export const getImageDigest = (): string =>
  execFileSync('docker', ['inspect', '--format', '{{.Id}}', IMAGE_TAG], {
    encoding: 'utf8'
  }).trim();

export const getContainerImageDigest = (containerName: string): string =>
  execFileSync('docker', ['inspect', '--format', '{{.Image}}', containerName], {
    encoding: 'utf8'
  }).trim();

export type ContainerState = {
  status: string;
  exitCode: number;
};

export const getContainerState = (containerName: string): ContainerState => {
  const out = execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', containerName],
    { encoding: 'utf8' }
  ).trim();
  const [status, exitCodeRaw] = out.split('|');
  return { status, exitCode: Number.parseInt(exitCodeRaw, 10) };
};

const getContainerLogsOnce = (containerName: string): string => {
  // `docker logs` writes each line to whichever stream the container wrote
  // it to -- entrypoint.sh's log() helper writes everything (including the
  // FATAL line) to stderr, via `printf '%s\n' "$*" >&2`. execFileSync's
  // return value is stdout ONLY; on a zero exit code (which `docker logs`
  // always has, even for an exited container) any stderr content is
  // silently discarded rather than returned -- it would otherwise inherit
  // straight through to this process's own stderr. spawnSync captures both
  // streams regardless of exit code, so stdout+stderr are concatenated here
  // to get the container's full combined log, matching what an operator
  // running `docker logs` at a terminal would see.
  const result = spawnSync('docker', ['logs', containerName], { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
};

/**
 * `docker logs` immediately after a container reaches `Status: exited` can
 * occasionally observe the log stream before dockerd's logging driver has
 * finished flushing (a real race, not this repo's code) -- poll briefly
 * rather than accept a possibly-truncated read.
 */
export const getContainerLogs = (containerName: string, timeoutMs = 5_000): string => {
  const deadline = Date.now() + timeoutMs;
  let logs = getContainerLogsOnce(containerName);
  while (logs.trim().length === 0 && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const waitMs = Math.min(200, Math.max(remaining, 0));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    logs = getContainerLogsOnce(containerName);
  }
  return logs;
};

/**
 * Starts a detached container of IMAGE_TAG named `name`, publishing its
 * port-80 nginx to the host at `hostPort`, with `configPath` bind-mounted
 * (read-only) at the entrypoint's expected MOUNTED_CONFIG_PATH. Mirrors
 * exactly the `docker run` invocation C-2 verified
 * (plans/dev-ui-docker-ghcr/c2-runtime-config-proof.md §2-3).
 *
 * Does NOT wait for readiness -- callers that expect the container to reach
 * a listening nginx should follow with waitForHttpOk; callers testing the
 * container-fatal path (an invalid mount) should instead inspect
 * getContainerState after a short delay.
 */
export const runContainer = ({
  name,
  hostPort,
  configPath
}: {
  name: string;
  hostPort: number;
  configPath: string;
}): void => {
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `${hostPort}:80`,
    '-v',
    `${configPath}:${MOUNTED_CONFIG_PATH}:ro`,
    IMAGE_TAG
  ]);
};

/** Removes a container by name, ignoring "already gone" errors. */
export const removeContainer = (name: string): void => {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  } catch {
    // already removed / never created -- fine for cleanup idempotency.
  }
};

/** Polls `url` until it returns an HTTP response (any status) or times out. */
export const waitForHttpResponse = async (url: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { cache: 'no-store' });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Timed out waiting for ${url} to respond after ${timeoutMs}ms. Last error: ${String(lastError)}`
  );
};

/** Waits until `docker inspect` reports the container has exited (Status === "exited"). */
export const waitForContainerExit = async (
  containerName: string,
  timeoutMs = 10_000
): Promise<ContainerState> => {
  const deadline = Date.now() + timeoutMs;
  let state = getContainerState(containerName);
  while (state.status !== 'exited' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = getContainerState(containerName);
  }
  return state;
};

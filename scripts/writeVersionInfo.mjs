#!/usr/bin/env node
// Writes public/version.json (gitignored), so the deployed front-end's
// version can be checked from outside the app itself -- e.g.
// `curl https://<host>/version.json` -- without opening a browser or
// relying on the app having loaded successfully.
//
// Runs on every dev/build entry point, same as scripts/syncPublicConfig.mjs.
//
// The git commit is best-effort: the Dockerfile's app-builder stage copies
// no .git directory into its build context (see Dockerfile's HUSKY=0
// comment), so `git rev-parse` fails there. DEV_UI_BUILD_COMMIT lets a build
// pipeline that *does* have the commit available (e.g. from $GITHUB_SHA)
// inject it without needing .git; with neither available this falls back to
// "unknown" rather than failing the build over metadata.
//
// The version has the same problem one level up: package.json's "version"
// field is not tied to how this app is actually released -- docker-publish
// .yaml tags images from the release/dispatch ref, never from package.json
// -- so a Docker build reading package.json alone reports a stale/unrelated
// number. DEV_UI_BUILD_VERSION lets a build pipeline that knows the real
// released version (or dispatch tag) override it the same way
// DEV_UI_BUILD_COMMIT overrides the commit; with no override this falls
// back to package.json's version, same as before.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const DESTINATION_PATH = path.join(REPO_ROOT, 'public', 'version.json');

const resolveCommit = () => {
  if (process.env.DEV_UI_BUILD_COMMIT) return process.env.DEV_UI_BUILD_COMMIT;

  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
};

const resolveVersion = () => {
  if (process.env.DEV_UI_BUILD_VERSION) return process.env.DEV_UI_BUILD_VERSION;

  const { version } = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  return version;
};

/**
 * @returns {{ destination: string, info: { version: string, commit: string, builtAt: string } }}
 */
export const writeVersionInfo = () => {
  const info = {
    version: resolveVersion(),
    commit: resolveCommit(),
    builtAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(DESTINATION_PATH), { recursive: true });
  fs.writeFileSync(DESTINATION_PATH, `${JSON.stringify(info, null, 2)}\n`);

  return { destination: DESTINATION_PATH, info };
};

const run = () => {
  const { destination, info } = writeVersionInfo();
  process.stdout.write(
    `Wrote ${path.relative(REPO_ROOT, destination)} -> ${JSON.stringify(info)}\n`
  );
};

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown version-info error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

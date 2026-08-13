#!/usr/bin/env node
// Validates the repo-root config.json, then byte-copies it to
// public/config.json (gitignored). Idempotent, safe to run repeatedly.
//
// Why this exists (see plans/dev-ui-docker-ghcr/a1-runtime-config-design.md §1):
// the app now fetches /config.json at runtime instead of importing config.json
// as a module, so it needs a copy under public/ for `next dev` to serve and for
// `next build` (output: 'export') to carry into out/. Validation runs BEFORE
// the copy so an invalid root config.json never leaves a stale-but-valid
// public/config.json standing, and never publishes an invalid one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromDiskOrThrow } from '../config/configLoaderNode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'config.json');
const DESTINATION_PATH = path.join(REPO_ROOT, 'public', 'config.json');

/**
 * @returns {{ source: string, destination: string }}
 */
export const syncPublicConfig = () => {
  // allowRelative + no origin: this is a shape check, not a resolution pass.
  // A relative aggkitProxy value must survive the copy verbatim so the
  // browser can resolve it against its own origin at runtime (design.md §1.4,
  // §5.4). This also means the copy must be a byte-for-byte fs.copyFileSync,
  // never a re-serialize -- reformatting would still be semantically
  // equivalent JSON, but C-2 depends on the mounted file and the repo file
  // being byte-identical in format.
  loadConfigFromDiskOrThrow({ configPath: SOURCE_PATH, allowRelative: true });

  fs.mkdirSync(path.dirname(DESTINATION_PATH), { recursive: true });
  fs.copyFileSync(SOURCE_PATH, DESTINATION_PATH);

  return { source: SOURCE_PATH, destination: DESTINATION_PATH };
};

const run = () => {
  const { source, destination } = syncPublicConfig();
  process.stdout.write(
    `Synced ${path.relative(REPO_ROOT, source)} -> ${path.relative(REPO_ROOT, destination)}\n`
  );
};

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown sync error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

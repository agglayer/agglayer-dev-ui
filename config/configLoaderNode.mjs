// The only file allowed to touch `node:fs` in the config-loading layer. Must
// never be imported from `app/` (that bundle is browser-only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfigOrThrow } from './configLoader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config.json');

/**
 * @typedef {import('./configValidator.mjs').JsonConfig} JsonConfig
 */

/**
 * Reads and validates a config.json off disk. Defaults to the repo-root
 * config.json, resolved from this module's own location (robust to the
 * caller's `process.cwd()`).
 *
 * @param {{ configPath?: string, origin?: string, allowRelative?: boolean, sourceName?: string }} [options]
 * @returns {JsonConfig}
 */
export const loadConfigFromDiskOrThrow = (options = {}) => {
  const {
    configPath = DEFAULT_CONFIG_PATH,
    origin,
    allowRelative = false,
    sourceName = 'config.json'
  } = options;

  const fileContent = fs.readFileSync(configPath, 'utf8');

  let rawConfig;
  try {
    rawConfig = JSON.parse(fileContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown JSON parse error';
    throw new Error(`config.json parse failed: ${message}`);
  }

  return normalizeConfigOrThrow(rawConfig, { sourceName, origin, allowRelative });
};

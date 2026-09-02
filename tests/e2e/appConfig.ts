import type { ResolvedAppConfig } from '@/app/config';
import type { JsonConfig } from '@/app/types/config';

import fs from 'node:fs';
import path from 'node:path';

import { initAppConfig } from '@/app/config';
import { normalizeConfigOrThrow } from '@/config/configLoader.mjs';

// Node-side bootstrap for Playwright specs/helpers that need the resolved app
// config outside the browser (which is normally populated by
// app/components/appConfigGate.tsx). Memoized and explicitly called -- never
// relied on as an import side effect (design.md §4.4): preflight.spec.ts
// reads config at module scope, and ESLint's import-ordering rule controls
// the relative evaluation order of sibling imports, so a side-effect import
// would be an ordering landmine.
//
// Deliberately reads + parses config.json itself and calls the shared,
// browser-safe config/configLoader.mjs directly, rather than delegating to
// config/configLoaderNode.mjs's loadConfigFromDiskOrThrow (design.md §4.4's
// literal suggestion). Reason (discovered empirically, not in design.md):
// Playwright's own require-hook-based TS/.mjs transform cannot handle a
// statically-imported .mjs module that references `import.meta`
// (configLoaderNode.mjs's DEFAULT_CONFIG_PATH is derived from
// `import.meta.url`) -- it throws `ReferenceError: exports is not defined in
// ES module scope` the moment such a module is required from a transformed
// .ts file, independent of any alias/path used to reach it (reproduced in an
// isolated minimal playwright.config.ts with no other project code
// involved). config/configLoader.mjs has zero `import.meta`/Node-builtin
// usage and imports fine the same way, so the fix is to keep the disk read
// here (this file is plain CJS-compiled TS, so plain `__dirname` is safe)
// and reuse only the shared normalize/validate path.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');

let cachedConfig: ResolvedAppConfig | undefined;

export const loadAppConfigForNode = (): ResolvedAppConfig => {
  if (cachedConfig) return cachedConfig;

  const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(fileContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown JSON parse error';
    throw new Error(`config.json parse failed: ${message}`);
  }

  const origin = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
  const configJson = normalizeConfigOrThrow(rawConfig, {
    sourceName: 'config.json',
    origin
  }) as JsonConfig;

  cachedConfig = initAppConfig(configJson);
  return cachedConfig;
};

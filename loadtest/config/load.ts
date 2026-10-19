// Thin file-system loader around schema.ts's pure `parseLoadtestConfig`.
// Kept separate from schema.ts so schema.ts stays I/O-free (importable from
// a browser-side test or bundled without pulling in `node:fs`).
import fs from 'node:fs';
import path from 'node:path';

import type { LoadtestConfig } from './schema';

import { parseLoadtestConfig } from './schema';

// Reads and parses a loadtest.config.json from disk, resolving relative
// paths against the current working directory (standard CLI convention —
// the same convention `pnpm loadtest validate <path>` uses).
export const loadLoadtestConfig = (configPath: string): LoadtestConfig => {
  const absolutePath = path.resolve(configPath);

  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(
      `could not read loadtest config at "${absolutePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `"${absolutePath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parseLoadtestConfig(json);
};

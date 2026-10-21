// Test-only loader: copies a committed fixture (`<name>/*.fixture`) into a temp
// run directory with the file names the report generator expects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const makeTempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-html-'));

/** Returns the `out` directory of a copy of the fixture, with `meta.txt` one level up. */
export const copyFixtureRun = (
  fixture: 'run-g' | 'run-a-fail',
  root: string,
  runName: string,
  options: { withNdjson?: boolean } = {}
): string => {
  const out = path.join(root, runName, 'out');
  fs.mkdirSync(out, { recursive: true });
  const src = path.join(HERE, fixture);
  fs.copyFileSync(path.join(src, 'results.json.fixture'), path.join(out, 'results.json'));
  if (options.withNdjson !== false) {
    fs.copyFileSync(path.join(src, 'activity.ndjson.fixture'), path.join(out, 'activity.ndjson'));
  }
  fs.copyFileSync(path.join(src, 'meta.txt.fixture'), path.join(root, runName, 'meta.txt'));
  return out;
};

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

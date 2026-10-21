import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { applyCorsRelayFlag } from './corsRelayFlag';
import { deriveDevnetConfig } from './deriveDevnet';
import { parseLoadtestConfig } from './schema';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const devnetDoc = (): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(
      deriveDevnetConfig({
        repoRoot: '/unused-repo-root-for-tests',
        summaryPath: path.join(FIXTURES_DIR, 'summary.json'),
        ciConfigPath: path.join(FIXTURES_DIR, 'config.ci.devnet.json'),
        env: {}
      }).config
    )
  ) as Record<string, unknown>;

describe('browser.corsRelay config option', () => {
  it('is off (absent) by default', () => {
    const config = parseLoadtestConfig(devnetDoc());
    expect(config.browser.corsRelay).toBeUndefined();
    expect(config.browser.corsRelay === true).toBe(false);
  });

  it('is accepted when set in the config, and must be a boolean', () => {
    const doc = devnetDoc();
    doc.browser = { corsRelay: true };
    expect(parseLoadtestConfig(doc).browser.corsRelay).toBe(true);

    doc.browser = { corsRelay: 'yes' };
    expect(() => parseLoadtestConfig(doc)).toThrow();
  });
});

describe('applyCorsRelayFlag (--cors-relay)', () => {
  it('enables the relay only when the flag is present', () => {
    const config = parseLoadtestConfig(devnetDoc());
    expect(applyCorsRelayFlag(config, true).browser.corsRelay).toBe(true);
    expect(applyCorsRelayFlag(config, false)).toBe(config);
  });

  it('never turns off a relay the config itself enabled', () => {
    const doc = devnetDoc();
    doc.browser = { corsRelay: true };
    const config = parseLoadtestConfig(doc);
    expect(applyCorsRelayFlag(config, false).browser.corsRelay).toBe(true);
  });

  it('keeps the other browser fields', () => {
    const config = parseLoadtestConfig(devnetDoc());
    const out = applyCorsRelayFlag(config, true);
    expect(out.browser).toEqual({ ...config.browser, corsRelay: true });
  });
});

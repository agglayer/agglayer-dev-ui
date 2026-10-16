// R22 (loadtest/REVIEW.md): `ui/build.ts` used to spread the ENTIRE parent
// environment into the `next build` child process (`stdio: 'inherit'`
// means that child's own output bypasses this tool's redaction entirely).
// `allowlistedEnvForBuildChild` is the fix, exported specifically so this
// can be asserted without spawning a real build.
import { describe, expect, it } from 'vitest';

import { allowlistedEnvForBuildChild } from './build';

describe('allowlistedEnvForBuildChild (R22, loadtest/REVIEW.md)', () => {
  it('forwards PATH/shell plumbing and NEXT_PUBLIC_*/NODE_*/NPM_*/PNPM_* prefixes', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      HOME: '/home/user',
      NODE_OPTIONS: '--max-old-space-size=4096',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
      PNPM_HOME: '/home/user/.local/share/pnpm',
      NEXT_PUBLIC_AGGKIT_PROXY: 'http://127.0.0.1:8555/aggkitapi'
    };
    const out = allowlistedEnvForBuildChild(env);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/user');
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(out.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org');
    expect(out.PNPM_HOME).toBe('/home/user/.local/share/pnpm');
    expect(out.NEXT_PUBLIC_AGGKIT_PROXY).toBe('http://127.0.0.1:8555/aggkitapi');
  });

  it('does NOT forward a real secret the operator exported for the loadtest tool itself', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      LOADTEST_MNEMONIC: 'test test test test test test test test test test test junk',
      LOADTEST_DEVNET_FUNDER_KEY:
        '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625',
      MY_CUSTOM_SECRET_TOKEN: 'super-secret'
    };
    const out = allowlistedEnvForBuildChild(env);
    expect(out.LOADTEST_MNEMONIC).toBeUndefined();
    expect(out.LOADTEST_DEVNET_FUNDER_KEY).toBeUndefined();
    expect(out.MY_CUSTOM_SECRET_TOKEN).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['NODE_ENV', 'PATH']);
  });

  it('skips undefined values rather than forwarding them as the literal string "undefined"', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '/usr/bin', HOME: undefined };
    const out = allowlistedEnvForBuildChild(env);
    expect(out.HOME).toBeUndefined();
    expect('HOME' in out).toBe(false);
  });
});

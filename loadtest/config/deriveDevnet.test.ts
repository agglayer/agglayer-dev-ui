// Exercises deriveDevnetConfig against a FIXTURE copy of
// tests/devnet/summary.json (loadtest/config/__fixtures__/summary.json) —
// never the live file, so this test can't be broken by a devnet re-snapshot
// and can't accidentally assert against stale live data either.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { DeriveDevnetOptions } from './deriveDevnet';

import { deriveDevnetConfig } from './deriveDevnet';
import { parseLoadtestConfig } from './schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

const baseOptions = (env: Record<string, string | undefined> = {}): DeriveDevnetOptions => ({
  repoRoot: '/unused-repo-root-for-tests',
  summaryPath: path.join(FIXTURES_DIR, 'summary.json'),
  ciConfigPath: path.join(FIXTURES_DIR, 'config.ci.devnet.json'),
  env
});

describe('deriveDevnetConfig', () => {
  it('derives chain/network ids, proxy URL, ERC20 and bridge address from the fixture summary.json', () => {
    const { config } = deriveDevnetConfig(baseOptions());
    const parsed = parseLoadtestConfig(config);

    expect(parsed.aggkitProxyUrl).toBe('http://127.0.0.1:8555/aggkitapi');
    expect(parsed.chains.map((chain) => [chain.key, chain.chainId, chain.networkId])).toStrictEqual(
      [
        ['L1', 271828, 0],
        ['L2A', 20201, 1],
        ['L2B', 20202, 2]
      ]
    );
    parsed.chains.forEach((chain) => {
      expect(chain.bridgeAddress).toBe('0xC8cbEBf950B9Df44d987c8619f092beA980fF038');
    });

    const erc20Asset = parsed.assets.find((asset) => asset.kind === 'erc20');
    expect(erc20Asset?.address).toBe('0xe293A6b8F558422813499bb5C89B60adD8c54636');
    expect(erc20Asset?.originNetworkId).toBe(0);

    expect(parsed.ring).toStrictEqual(['L1', 'L2A', 'L2B', 'L1']);
  });

  it('maps the devnet autoclaim map from config.ci.devnet.json onto every ring hop via getRouteType', () => {
    const { config } = deriveDevnetConfig(baseOptions());
    const parsed = parseLoadtestConfig(config);

    expect(parsed.autoclaim).toStrictEqual({
      'L1->L2A': { expected: true, waitMs: 120_000 },
      'L2A->L2B': { expected: true, waitMs: 300_000 },
      'L2B->L1': { expected: false }
    });
  });

  it('never inlines the funder private key — only a secretRef by env var name', () => {
    const { config, hint } = deriveDevnetConfig(baseOptions());
    const parsed = parseLoadtestConfig(config);

    expect(parsed.users.funder?.privateKeyRef).toStrictEqual({ env: 'LOADTEST_DEVNET_FUNDER_KEY' });
    expect(JSON.stringify(parsed)).not.toContain(
      '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625'
    );
    expect(hint).toContain('accounts.e2e_wallet.private_key');
    expect(hint).not.toContain(
      '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625'
    );
  });

  it('honors DEVNET_PROXY_PORT for both the aggkit proxy URL and the RPC URLs', () => {
    const { config } = deriveDevnetConfig(baseOptions({ DEVNET_PROXY_PORT: '9999' }));
    const parsed = parseLoadtestConfig(config);

    expect(parsed.aggkitProxyUrl).toBe('http://127.0.0.1:9999/aggkitapi');
    expect(parsed.chains.find((chain) => chain.key === 'L1')?.rpcUrl).toBe(
      'http://127.0.0.1:9999/l1rpc'
    );
  });

  it('honors AGGKIT_PROXY_PORT as the direct (non-haproxy) alternative when DEVNET_PROXY_PORT is unset', () => {
    const { config } = deriveDevnetConfig(baseOptions({ AGGKIT_PROXY_PORT: '8556' }));
    const parsed = parseLoadtestConfig(config);

    expect(parsed.aggkitProxyUrl).toBe('http://127.0.0.1:8556');
  });

  it('the produced config passes validate as-is (parseLoadtestConfig does not throw)', () => {
    const { config } = deriveDevnetConfig(baseOptions());
    expect(() => parseLoadtestConfig(config)).not.toThrow();
  });

  // S10 attempt #1 shipped a devnet config where `hopMs` (900_000) sat BELOW
  // `readyToClaimMs` (900_000 tied, then briefly inverted across a retry) —
  // a hop could never survive long enough to even reach its own
  // `readyToClaimMs` timeout before the `hopMs` umbrella (ring.ts's T28)
  // failed it first, silently truncating the grace window S3.4's autoclaim
  // escalation depends on. This regression-locks the ordering invariant
  // `readyToClaimMs < hopMs < lapMs` directly on deriveDevnetConfig's OWN
  // literal timeout values (not schema defaults, which this function never
  // reads) so a future edit to the hardcoded `timeouts` block above cannot
  // silently reintroduce it.
  it('preserves the timeout ordering invariant readyToClaimMs < hopMs < lapMs (S12, guards the S10 config defect)', () => {
    const { config } = deriveDevnetConfig(baseOptions());
    const parsed = parseLoadtestConfig(config);

    expect(parsed.timeouts.readyToClaimMs).toBeLessThan(parsed.timeouts.hopMs);
    expect(parsed.timeouts.hopMs).toBeLessThan(parsed.timeouts.lapMs);
  });
});

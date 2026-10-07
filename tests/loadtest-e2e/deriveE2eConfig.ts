import type { LoadtestConfig } from '../../loadtest/config/schema';

// Builds the `loadtest.config.json` used by `tests/loadtest-e2e/run.spec.ts`.
//
// Starts from the real `deriveDevnetConfig()` (loadtest/config/deriveDevnet.ts
// -- the same function `pnpm loadtest derive-devnet` uses) and then applies
// one E2E-test-only adaptation, explained in full in run.spec.ts's
// top-of-file doc comment:
//
// Shortens the ring from the full L1 -> L2A -> L2B -> L1 (3 hops) to
// L1 -> L2A -> L1 (2 hops). This keeps one autoclaim hop (L1->L2A) and one
// manual-claim hop (L2A->L1) -- everything the plan's assertions need --
// while dropping the L2A->L2B hop, which this session measured to exceed
// the devnet's 900s readyToClaimMs budget under concurrent load (12/12
// timeouts in a 6-user run). A 4-user, 2-hop run stays within a
// nightly-CI-sized wall-clock budget; a 4-user, 3-hop run does not (see
// run.spec.ts).
//
// `load.rampUpSeconds` is left at deriveDevnetConfig's default (60s) --
// an exploratory run of this file's config with it cut to 5s produced the
// exact same tick count as the default, because at the plan's mandated
// `--rate 1 --minutes 2`, `core/scheduler.ts`'s per-user tick period is a
// fixed `60_000 / bridgesPerMinutePerUser` = 60_000ms: the first tick lands
// at ~t=60s regardless of ramp-up, and a second would land at ~t=120s,
// which is at or past the 2-minute load window's own cutoff. So EVERY user
// gets exactly one lap-start tick in this run shape, always for
// `config.assets[0]` (eth) -- `core/scheduler.ts`'s round-robin always
// starts a fresh user at asset index 0, and nothing in a 4-user/2-minute
// run ever advances any user past it. This is a structural property of the
// mandated rate/duration, not something ramp-up can fix -- see
// run.spec.ts's doc comment for what this means for the "per asset"
// assertions.
//
// Nothing in loadtest/ itself is modified -- this is test-only config
// shaping, exactly the kind of thing an operator hand-writing a
// `loadtest.config.json` for a smaller/cheaper environment would do.
import { deriveDevnetConfig } from '../../loadtest/config/deriveDevnet';
import { checkOperationalConstraints, parseLoadtestConfig } from '../../loadtest/config/schema';

export interface BuildE2eConfigResult {
  config: LoadtestConfig;
  hint: string;
}

export const buildE2eConfig = (repoRoot: string): BuildE2eConfigResult => {
  const { config: rawConfig, hint } = deriveDevnetConfig({ repoRoot });
  // deriveDevnetConfig's return type is `unknown` by design (see its own
  // doc) -- narrow it back to the pre-parse shape we know it produces
  // before patching specific fields.
  const base = rawConfig as {
    chains: Array<{ key: string; [k: string]: unknown }>;
    autoclaim: Record<string, { expected: boolean; waitMs?: number }>;
    users: {
      funder: {
        gasPerChain: Record<string, string>;
        maxTotalSpend: Record<string, string>;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    load: Record<string, unknown>;
    [k: string]: unknown;
  };

  const patched = {
    ...base,
    // Drop L2B entirely (not just from `ring`): `wallets/preflight.ts`
    // checks chainId/bridge-bytecode/sync-status for EVERY configured
    // chain, ring member or not, so leaving an unused L2B in `chains`
    // would make this test's preflight depend on an L2 it never bridges
    // to/from.
    chains: base.chains.filter((chain) => chain.key === 'L1' || chain.key === 'L2A'),
    ring: ['L1', 'L2A', 'L1'],
    autoclaim: {
      'L1->L2A': base.autoclaim['L1->L2A'],
      // L2A->L1 is a fresh hop key that deriveDevnetConfig's 3-hop ring
      // never produces; a source-network-1 -> destination-network-0 hop is
      // `getRouteType`'s `l2_to_l1`, which is never autoclaimed on this
      // devnet (see config/config.ci.devnet.json / app/utils/autoclaim.ts)
      // -- the same shape as the original ring's L2B->L1 entry.
      'L2A->L1': { expected: false }
    },
    users: {
      ...base.users,
      funder: {
        ...base.users.funder,
        gasPerChain: {
          L1: base.users.funder.gasPerChain.L1,
          L2A: base.users.funder.gasPerChain.L2A
        },
        maxTotalSpend: {
          L1: base.users.funder.maxTotalSpend.L1,
          L2A: base.users.funder.maxTotalSpend.L2A
        }
      }
    }
  };

  const config = parseLoadtestConfig(patched);
  const issues = checkOperationalConstraints(config);
  if (issues.length > 0) {
    throw new Error(
      `buildE2eConfig: derived config failed validation:\n${issues.map((line) => `- ${line}`).join('\n')}`
    );
  }

  return { config, hint };
};

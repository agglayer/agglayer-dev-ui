import type { LoadtestConfig } from '../../loadtest/config/schema';

// Builds the `loadtest.config.json` used by
// `tests/loadtest-e2e/run.fullring.spec.ts` (S30,
// plans/bridge-loadtest-plan.md §7/§8's coverage-design decision — see that
// file's top-of-file doc comment for the full reasoning).
//
// Unlike `deriveE2eConfig.ts` (the ~2-minute, 2-hop `run.spec.ts` config),
// this one does NOT shorten the ring: `deriveDevnetConfig()`'s default ring
// IS the tool's normal `L1 -> L2A -> L2B -> L1` (3 hops), so this file only
// needs to change the wallet start index -- everything else (chains,
// autoclaim map, funder gas/spend per chain) is already correct for all
// three chains because nothing is being dropped from `ring`/`chains`.
//
// `users.wallets.startIndex` is moved to 98000, distinct from every other
// wallet range this session used (0/e2e-fixture default, 90300 in the PR's
// "reliable configuration", 92000/92xxx in S26's live runs, 96000+ in this
// step's own devnet instructions), so this spec's wallets never overlap
// it (or `run.spec.ts`'s, which stays at the derived default 0) even when
// both specs run back-to-back against the SAME devnet instance in one
// nightly job.
import { deriveDevnetConfig } from '../../loadtest/config/deriveDevnet';
import { checkOperationalConstraints, parseLoadtestConfig } from '../../loadtest/config/schema';

export interface BuildFullRingE2eConfigResult {
  config: LoadtestConfig;
  hint: string;
}

const WALLET_START_INDEX = 98000;

export const buildFullRingE2eConfig = (repoRoot: string): BuildFullRingE2eConfigResult => {
  const { config: rawConfig, hint } = deriveDevnetConfig({ repoRoot });
  // deriveDevnetConfig's return type is `unknown` by design (see its own
  // doc) -- narrow it back to the pre-parse shape we know it produces
  // before patching the one field this file changes.
  const base = rawConfig as {
    users: { [k: string]: unknown };
    [k: string]: unknown;
  };

  const patched = {
    ...base,
    users: {
      ...base.users,
      wallets: { mnemonicRef: { env: 'LOADTEST_MNEMONIC' }, startIndex: WALLET_START_INDEX }
    }
  };

  const config = parseLoadtestConfig(patched);
  const issues = checkOperationalConstraints(config);
  if (issues.length > 0) {
    throw new Error(
      `buildFullRingE2eConfig: derived config failed validation:\n${issues.map((line) => `- ${line}`).join('\n')}`
    );
  }

  return { config, hint };
};

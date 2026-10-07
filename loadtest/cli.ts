#!/usr/bin/env node
// `pnpm loadtest <command>` entry point. S04 implemented the two commands
// that don't require workers/funding/a live run (`derive-devnet`,
// `validate`); S05 adds `fund` and `preflight` (DESIGN §4).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LoadtestConfig } from './config/schema';
import type { ResultsJson } from './metrics/report';

import { deriveDevnetConfig } from './config/deriveDevnet';
import {
  checkOperationalConstraints,
  parseLoadtestConfig,
  serializeLoadtestConfig
} from './config/schema';
import { renderSummaryMd } from './metrics/report';
import { runLoadTest } from './runner';
import { buildUi } from './ui/build';
import { serveUi } from './ui/serve';
import { deriveWallets } from './wallets/derive';
import { fundWallets } from './wallets/fund';
import { PreflightError, runPreflight } from './wallets/preflight';
import { redactError } from './wallets/redact';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const printUsage = (): void => {
  process.stdout.write(
    [
      'Usage:',
      '  pnpm loadtest derive-devnet [--out <path>]',
      '  pnpm loadtest validate [<path>]',
      '  pnpm loadtest fund [<path>] [--users N] [--i-know-this-is-mainnet]',
      '  pnpm loadtest preflight [<path>] [--users N]',
      '  pnpm loadtest build-ui [<path>]',
      '  pnpm loadtest serve-ui [<path>] [--out <dir>]',
      '  pnpm loadtest run [--config <path>] [--users N] [--browser N] [--rate Y]',
      '                    [--minutes Z] [--assets eth,erc20] [--fund]',
      '                    [--i-know-this-is-mainnet] [--out <dir>]',
      '  pnpm loadtest report --dir <dir>',
      ''
    ].join('\n')
  );
};

const parseFlagValue = (argv: string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
};

const hasFlag = (argv: string[], flag: string): boolean => argv.includes(flag);

// Flags that consume the following argv slot as their value — needed so
// the positional-config-path scan below doesn't mistake `--users`'s value
// ("20") for the config path.
const VALUE_FLAGS = new Set(['--users', '--out']);

// The first non-flag, non-flag-value argument is the config path; both
// `fund` and `preflight` accept it in the same position `validate` does.
const parsePositionalConfigPath = (argv: string[]): string => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) index += 1; // skip this flag's value too
      continue;
    }
    return arg;
  }
  return 'loadtest.config.json';
};

// `--users N` is a convenience override for exercising `fund`/`preflight`
// against a smaller wallet set than the config declares (e.g. the S05
// acceptance run's `--users 20` against a config generated with
// `users.total: 400`) without hand-editing the config file first.
// `users.browser` is clamped down with it so `USERS_BROWSER_EXCEEDS_TOTAL`
// can never fire as a side effect of the override.
const overrideUsersTotal = (
  config: LoadtestConfig,
  usersArg: string | undefined
): LoadtestConfig => {
  if (usersArg === undefined) return config;
  const total = Number.parseInt(usersArg, 10);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`--users must be a positive integer, got "${usersArg}"`);
  }
  return {
    ...config,
    users: {
      ...config.users,
      total,
      browser: Math.min(config.users.browser, total)
    }
  };
};

const loadConfigForCommand = (argv: string[]): LoadtestConfig => {
  const configPath = path.resolve(process.cwd(), parsePositionalConfigPath(argv));
  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw) as unknown;
  const parsed = parseLoadtestConfig(json);

  const operationalIssues = checkOperationalConstraints(parsed);
  if (operationalIssues.length > 0) {
    throw new Error(
      `loadtest config validation failed:\n${operationalIssues.map((line) => `- ${line}`).join('\n')}`
    );
  }

  return overrideUsersTotal(parsed, parseFlagValue(argv, '--users'));
};

// DESIGN §2.1: `validate` warns (does not fail) when `output.dir` is inside
// the repo and not matched by `.gitignore`. Best-effort — a missing `git`
// binary or a repo-less checkout just skips the warning rather than failing
// `validate` over it.
const warnIfOutputDirNotIgnored = (config: LoadtestConfig): void => {
  const absoluteDir = path.resolve(REPO_ROOT, config.output.dir);
  if (!absoluteDir.startsWith(`${REPO_ROOT}${path.sep}`)) return;

  try {
    execFileSync('git', ['check-ignore', '-q', absoluteDir], { cwd: REPO_ROOT });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      process.stderr.write(
        `warning: output.dir "${config.output.dir}" is inside the repo and not matched by .gitignore\n`
      );
    }
    // status > 1 (e.g. not a git repo, git missing): best-effort, ignore.
  }
};

const runDeriveDevnet = (argv: string[]): void => {
  const outArg = parseFlagValue(argv, '--out') ?? 'loadtest.config.json';
  const outPath = path.resolve(process.cwd(), outArg);

  const { config, hint } = deriveDevnetConfig({ repoRoot: REPO_ROOT });

  // Re-parse through the schema so what's written to disk is exactly what
  // `validate` will accept later, and so a provenance bug here (e.g. a
  // missing autoclaim hop) fails loudly at generation time.
  const validated = parseLoadtestConfig(config);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${serializeLoadtestConfig(validated)}\n`);

  process.stdout.write(`Wrote ${path.relative(process.cwd(), outPath)}\n`);
  process.stdout.write(`${hint}\n`);
};

const runValidate = (argv: string[]): void => {
  const configArg = argv[0] ?? 'loadtest.config.json';
  const configPath = path.resolve(process.cwd(), configArg);

  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw) as unknown;
  const config = parseLoadtestConfig(json);

  const operationalIssues = checkOperationalConstraints(config);
  if (operationalIssues.length > 0) {
    throw new Error(
      `loadtest config validation failed:\n${operationalIssues.map((line) => `- ${line}`).join('\n')}`
    );
  }

  warnIfOutputDirNotIgnored(config);

  process.stdout.write(`${path.relative(process.cwd(), configPath)} is valid.\n`);
};

// DESIGN §4 — funds derived wallets (devnet: anvil_setBalance + ERC20
// transfer from the e2e wallet; testnet/mainnet: capped funder transfer).
const runFund = async (argv: string[]): Promise<void> => {
  const config = loadConfigForCommand(argv);
  const wallets = deriveWallets(config);
  const mainnetConfirmed = hasFlag(argv, '--i-know-this-is-mainnet');

  const result = await fundWallets({
    config,
    wallets,
    mainnetConfirmed,
    logger: (message) => process.stdout.write(`${message}\n`)
  });

  process.stdout.write(
    `fund: env=${result.env} strategy=${result.strategy} users=${wallets.length} duration=${result.durationMs}ms\n`
  );
  if (result.erc20FallbackAddress !== undefined) {
    process.stdout.write(`fund: erc20 fallback deployed at ${result.erc20FallbackAddress}\n`);
  }
};

// DESIGN §4.5 — asserts the ring is fundable and reachable before a run.
const runPreflightCommand = async (argv: string[]): Promise<void> => {
  const config = loadConfigForCommand(argv);
  const wallets = deriveWallets(config);

  const result = await runPreflight({ config, wallets });

  process.stdout.write(`${result.table}\n`);

  if (!result.ok) {
    const [first, ...rest] = result.failures;
    const restNote = rest.length > 0 ? ` (+${rest.length} more failure(s))` : '';
    throw new PreflightError(`preflight failed: ${first.code}: ${first.message}${restNote}`);
  }

  process.stdout.write('preflight: all checks passed.\n');
};

// DESIGN §8 — builds a standalone, E2E-enabled static export of the dev-ui
// app for browser-mode load testing (`out/`), without touching the repo's
// committed config.json. The config path here is only used to derive the
// generated app config (chains/ring/autoclaim/aggkitProxyUrl); `build-ui`
// itself doesn't need `--users` or the other run-shaping flags the commands
// above accept, so it deliberately doesn't go through `loadConfigForCommand`.
const runBuildUi = async (argv: string[]): Promise<void> => {
  const configPath = parsePositionalConfigPath(argv);
  const result = await buildUi({ configPath, repoRoot: REPO_ROOT });

  process.stdout.write(
    `build-ui: built env=${result.env} aggkitProxy=${result.aggkitProxyUrl} -> ${path.relative(process.cwd(), result.outDir)} (${result.durationMs}ms)\n`
  );
};

// DESIGN §8 — serves a `build-ui` export on the config's `uiBaseUrl` until
// interrupted. `serveUi` itself (loadtest/ui/serve.ts) is a plain reusable
// function; this command is just a thin CLI wrapper that keeps the process
// alive — `run` (S11) is expected to call `serveUi` directly instead.
const runServeUi = async (argv: string[]): Promise<void> => {
  const config = loadConfigForCommand(argv);
  if (config.uiBaseUrl === undefined) {
    throw new Error('serve-ui: loadtest config has no uiBaseUrl to serve on');
  }

  const outArg = parseFlagValue(argv, '--out');
  const outDir = path.resolve(REPO_ROOT, outArg ?? 'out');

  const handle = await serveUi({ outDir, uiBaseUrl: config.uiBaseUrl });
  process.stdout.write(
    `serve-ui: serving ${path.relative(process.cwd(), outDir)} on ${handle.url}\n`
  );

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void handle.close().finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};

// DESIGN §1/§8, S11 — filters `config.assets` down to the kinds named by
// `--assets eth,erc20` (comma-separated, case-insensitive), returning the
// matched indices INTO `config.assets` (never renumbered/reordered) so a
// `HopSpec.assetIndex` a driver later resolves via `config.assets[i]` stays
// correct. Omitting the flag runs every configured asset.
const parseAssetsFlag = (argv: string[], config: LoadtestConfig): number[] => {
  const raw = parseFlagValue(argv, '--assets');
  if (raw === undefined) return config.assets.map((_, index) => index);
  const wanted = new Set(
    raw
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0)
  );
  const indices = config.assets
    .map((asset, index) => ({ asset, index }))
    .filter(({ asset }) => wanted.has(asset.kind))
    .map(({ index }) => index);
  if (indices.length === 0) {
    throw new Error(
      `--assets "${raw}" matched no configured asset kind (config has: ${config.assets.map((a) => a.kind).join(', ')})`
    );
  }
  return indices;
};

// DESIGN §1's component map, wired end to end — S11.
// `cli.ts` owns all argv parsing (including the `--users`/`--browser`
// clamping `fund`/`preflight` already established); `runner.ts`'s
// `runLoadTest` is handed one already-validated, already-overridden config.
const runRun = async (argv: string[]): Promise<void> => {
  const configArg = parseFlagValue(argv, '--config') ?? 'loadtest.config.json';
  const configPath = path.resolve(process.cwd(), configArg);

  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw) as unknown;
  let config = parseLoadtestConfig(json);

  const operationalIssues = checkOperationalConstraints(config);
  if (operationalIssues.length > 0) {
    throw new Error(
      `loadtest config validation failed:\n${operationalIssues.map((line) => `- ${line}`).join('\n')}`
    );
  }

  config = overrideUsersTotal(config, parseFlagValue(argv, '--users'));

  const browserArg = parseFlagValue(argv, '--browser');
  if (browserArg !== undefined) {
    const browser = Number.parseInt(browserArg, 10);
    if (!Number.isFinite(browser) || browser < 0) {
      throw new Error(`--browser must be a non-negative integer, got "${browserArg}"`);
    }
    if (browser > config.users.total) {
      throw new Error(`--browser (${browser}) must be <= users.total (${config.users.total})`);
    }
    config = { ...config, users: { ...config.users, browser } };
  }

  const rateArg = parseFlagValue(argv, '--rate');
  if (rateArg !== undefined) {
    const rate = Number.parseFloat(rateArg);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`--rate must be a positive number, got "${rateArg}"`);
    }
    config = { ...config, load: { ...config.load, bridgesPerMinutePerUser: rate } };
  }

  const minutesArg = parseFlagValue(argv, '--minutes');
  if (minutesArg !== undefined) {
    const minutes = Number.parseFloat(minutesArg);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(`--minutes must be a positive number, got "${minutesArg}"`);
    }
    config = { ...config, load: { ...config.load, durationMinutes: minutes } };
  }

  const activeAssetIndices = parseAssetsFlag(argv, config);

  const outArg = parseFlagValue(argv, '--out');
  const outDir = path.resolve(REPO_ROOT, outArg ?? config.output.dir);

  const result = await runLoadTest({
    config,
    activeAssetIndices,
    configPath,
    repoRoot: REPO_ROOT,
    fund: hasFlag(argv, '--fund'),
    mainnetConfirmed: hasFlag(argv, '--i-know-this-is-mainnet'),
    outDir,
    logger: (line) => process.stdout.write(`${line}\n`)
  });

  process.stdout.write(
    `run: ${result.aborted ? `ABORTED (${result.abortCause ?? 'unknown cause'})` : 'complete'} -> ${path.relative(process.cwd(), result.outDir)}\n`
  );
};

// S11 — re-renders `summary.md` from an already-written `results.json`,
// without a live collector (`metrics/report.ts`'s `renderSummaryMd` is pure
// over `ResultsJson` + config — see that module's doc). `results.json`'s
// own `config` field is already `redactConfigForReport`-shaped
// (`{ref:"env:NAME"}` instead of `{env:"NAME"}`); feeding it back through
// `renderSummaryMd` (which redacts again, a no-op on that shape) is exactly
// what makes this byte-identical to the original run's `summary.md`.
const runReport = (argv: string[]): void => {
  const dirArg = parseFlagValue(argv, '--dir');
  if (dirArg === undefined) throw new Error('report requires --dir <dir>');
  const dir = path.resolve(process.cwd(), dirArg);

  const resultsPath = path.join(dir, 'results.json');
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as ResultsJson;
  const config = results.config as LoadtestConfig;

  const summaryMd = renderSummaryMd(results, config);
  const summaryPath = path.join(dir, 'summary.md');
  fs.writeFileSync(summaryPath, summaryMd);

  process.stdout.write(`report: wrote ${path.relative(process.cwd(), summaryPath)}\n`);
};

const main = async (): Promise<void> => {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'derive-devnet':
      runDeriveDevnet(rest);
      return;
    case 'validate':
      runValidate(rest);
      return;
    case 'fund':
      await runFund(rest);
      return;
    case 'preflight':
      await runPreflightCommand(rest);
      return;
    case 'build-ui':
      await runBuildUi(rest);
      return;
    case 'serve-ui':
      await runServeUi(rest);
      return;
    case 'run':
      await runRun(rest);
      return;
    case 'report':
      runReport(rest);
      return;
    default:
      printUsage();
      if (command !== undefined) process.exitCode = 1;
      return;
  }
};

main()
  .catch((error: unknown) => {
    // DESIGN §2.2: every error message reaching a log is redacted — this is
    // the single choke point every CLI command's thrown error passes
    // through, so no command needs to remember to redact its own errors.
    process.stderr.write(`${redactError(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // loadtest/REVIEW.md R1: `browser/pool.ts`'s `dispose()` awaiting every
    // in-flight launch (the actual leak fix) stops a NEW Chromium process
    // from being resurrected after teardown, but it does not guarantee the
    // event loop drains on its own — a viem client, an open keep-alive
    // socket, or any other still-referenced handle left over from a `run`
    // is enough to hang the process indefinitely *after* `run: complete`
    // has already printed (`runRun` prints it only once `runLoadTest` --
    // and therefore `disposeEverything` -- has resolved). Calling
    // `process.exit()` explicitly once `main()` has settled, rather than
    // relying on the event loop to drain naturally, is the documented (but
    // previously unimplemented) other half of the R1 fix — this line was
    // missing from the code despite loadtest/REVIEW.md's "R1 — FIXED" entry
    // describing it as already present.
    process.exit(process.exitCode ?? 0);
  });

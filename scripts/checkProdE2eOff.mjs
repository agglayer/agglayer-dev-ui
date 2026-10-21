// The E2E runtime key override (window.__AGGLAYER_E2E_PRIVATE_KEY__,
// app/context/e2eAccount.ts) is only as safe as the guarantee that
// NEXT_PUBLIC_E2E_ENABLED is never `true` in a deployed build. This check
// makes that guarantee explicit: it scans the production env surfaces a
// build actually consumes and fails if any of them could turn E2E on.
//
// Surfaces (a build-time var reaches the bundle only through these):
//   - .env.production                      (copied over .env.local by
//                                           build:production / the Dockerfile)
//   - .github/workflows/deploy.yaml        (Cloudflare Workers deploy; its
//                                           env: values are build-time env)
//   - Dockerfile                           (the production image; Dockerfile
//                                           .loadtest is a test-harness image
//                                           and deliberately NOT scanned)
//
// Semantics follow the app exactly: `IS_E2E_ENABLED` is
// `process.env.NEXT_PUBLIC_E2E_ENABLED === 'true'` (app/constants/e2e.ts), so
// only the literal string `true` (after quote stripping) turns E2E on. Any
// other non-empty value -- `1`, `TRUE`, a `${{ secrets.* }}` reference whose
// secret could hold `true` -- is still rejected here deliberately: it is not
// E2E-enabling under today's semantics, but leaving a truthy-looking value in
// a production surface is a latent footgun (a refactor of the comparison, or
// a future `=== '1'` fallback, would arm it silently). Set the var to
// `false` or remove the line; E2E builds set it in the e2e workflow only.
//
// Usage: node ./scripts/checkProdE2eOff.mjs (wired into CI via
// package.json's `check:prod-e2e` script). Exits 1 listing every violation.

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const E2E_KEY = 'NEXT_PUBLIC_E2E_ENABLED';

// The production surfaces this repo actually ships. Keys are descriptive
// labels; values are repo-root-relative paths.
const PROD_SURFACES = [
  { kind: 'env-file', path: '.env.production' },
  { kind: 'workflow-env', path: '.github/workflows/deploy.yaml' },
  { kind: 'dockerfile', path: 'Dockerfile' }
];

// Returns the assignment's value with surrounding quotes stripped, or null if
// the line does not assign NEXT_PUBLIC_E2E_ENABLED. Full-line comments are
// handled by the callers' regexes anchoring on the key at statement start;
// trailing comments are stripped here for env-file style (`KEY=v # comment`).
const extractAssignment = (kind, line) => {
  let match;
  if (kind === 'env-file') {
    // `KEY=VALUE` (optionally quoted); a `#` starts a trailing comment.
    match = line.match(new RegExp(`^\\s*${E2E_KEY}=(.*)$`));
    if (!match) return null;
    const value = match[1].replace(/\s#.*$/, '').trim();
    return value.replace(/^['"]|['"]$/g, '');
  }
  if (kind === 'workflow-env') {
    // YAML mapping value, with or without a leading `- ` (block list form):
    //   env: NEXT_PUBLIC_E2E_ENABLED: 'true'   |   - NEXT_PUBLIC_E2E_ENABLED: ${{ secrets.X }}
    match = line.match(new RegExp(`^\\s*-?\\s*${E2E_KEY}:\\s*(.*)$`));
    if (!match) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  if (kind === 'dockerfile') {
    // `ARG KEY[=value]` / `ENV KEY[=value]` (ENV KEY value legacy form too).
    match = line.match(new RegExp(`^\\s*(?:ARG|ENV)\\s+${E2E_KEY}(?:\\s|=)(.*)$`));
    if (!match) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
};

// Pure core: given a surface kind and the file's text, return the offending
// `line` numbers and values. Exported for the unit test
// (config/checkProdE2eOff.test.mjs).
export const findProdE2eViolations = (kind, text) => {
  const violations = [];
  text.split('\n').forEach((line, index) => {
    const value = extractAssignment(kind, line);
    if (value === null) return;
    if (value === 'false' || value === '') return;
    violations.push({ line: index + 1, value });
  });
  return violations;
};

const run = async () => {
  const failures = [];
  for (const surface of PROD_SURFACES) {
    let text;
    try {
      text = await readFile(surface.path, 'utf8');
    } catch {
      // A missing surface file cannot set the var; nothing to check there.
      continue;
    }
    for (const { line, value } of findProdE2eViolations(surface.kind, text)) {
      failures.push(`${surface.path}:${line}: ${E2E_KEY}=${value === '' ? '<empty>' : value}`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      [
        'Production build must never enable E2E (IS_E2E_ENABLED, app/constants/e2e.ts;',
        'see app/context/e2eAccount.ts for why that guarantee is load-bearing). Offending',
        'assignment(s):',
        ...failures.map((f) => `  - ${f}`),
        "Remove the assignment (or set it explicitly to 'false'). E2E builds set",
        `${E2E_KEY}=true in .github/workflows/e2e.yaml only.`
      ].join('\n') + '\n'
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${E2E_KEY} is not enabled in any production surface (${PROD_SURFACES.map((s) => s.path).join(', ')})\n`
  );
};

// Run the CLI only when executed directly; the unit test
// (config/checkProdE2eOff.test.mjs) imports the pure core above. Note
// import.meta.url is already a URL — pathToFileURL is applied to the
// (realpath-resolved) argv[1] PATH for the comparison, never to the URL.
const thisModule = import.meta.url;
const entryModule = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (entryModule === thisModule) {
  await run();
}

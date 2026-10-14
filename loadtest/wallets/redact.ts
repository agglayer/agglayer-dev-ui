// DESIGN §2.2: "metrics/errors.ts redacts any 0x[0-9a-fA-F]{40,} run to
// 0x…<last4> before a message reaches a log, results.json, activity.ndjson
// or summary.md (S05 asserts redaction; S12 re-asserts on every log path)."
// metrics/errors.ts itself is S07's deliverable and does not exist yet, so
// S05 owns this redactor for its own log paths (fund.ts, preflight.ts,
// cli.ts's top-level error handler) and S07 should import it from here
// rather than re-deriving the pattern.
//
// The pattern intentionally also matches a bare 40-hex-char address (not
// just a 64-hex-char private key) — DESIGN §4.3 rule 4 draws the line at
// "the funder address is logged, the key is not": that's a statement about
// which values a caller *chooses* to log directly (an address, printed on
// purpose, never routed through this function), not a claim that this
// redactor is address-aware. Over-redacting an address inside a free-text
// *error* message is an acceptable, deliberate trade-off; a private key
// slipping through because the regex was narrowed to spare addresses is not.
const HEX_RUN_PATTERN = /0x[0-9a-fA-F]{40,}/g;

// R21 (loadtest/REVIEW.md): `HEX_RUN_PATTERN` alone required the literal
// `0x` prefix, so a private key transcribed WITHOUT it (a 64-hex-char
// string on its own) slipped through entirely. Word-boundary-delimited so
// it doesn't also eat into a longer 0x-prefixed run already handled above.
const BARE_HEX_KEY_PATTERN = /\b[0-9a-fA-F]{64}\b/g;

// R21: a BIP-39 mnemonic has NO hex shape at all — neither pattern above
// could ever catch one, and `LOADTEST_MNEMONIC` is a first-class,
// documented secret input (`wallets/secrets.ts`) that is also the
// HIGHEST-VALUE secret this tool handles: it derives every user wallet, so
// leaking it exposes all of them, not just one. Word-list-free heuristic
// (no BIP-39 dictionary is bundled): 12-24 whitespace-separated lowercase-
// ASCII-alpha "words" of 3-8 letters each (real BIP-39 words are always
// exactly this shape) in a row is redacted as a whole sequence, never
// per-word — a mnemonic's value is the ORDERED SEQUENCE, not any one word.
// Deliberately broad (this can over-redact an unrelated run of short
// lowercase words in a message) — the file's own header note already
// accepts over-redaction as the right trade-off for the address pattern
// above; the same reasoning applies here with a higher-value secret at
// stake.
const MNEMONIC_PATTERN = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;

/**
 * A path segment that could be a provider API key: 16+ characters of
 * `[A-Za-z0-9_-]`. Hostnames contain dots and are never token-shaped. One rule
 * shared by the run-time endpoint naming (`workers/headless/uiCallset.ts`) and
 * the render-time rewrites (`metrics/redactReport.ts`), so a name written during
 * a run and a name rewritten later never disagree.
 */
export const isTokenLikeSegment = (segment: string): boolean =>
  /^[A-Za-z0-9_-]{16,}$/.test(segment);

// S53 / heavy-load design F2: an RPC provider key lives in the URL itself
// (`https://host/<key>`, `https://host/v3/<key>`, `?apikey=...`, or
// `user:pass@host`), and viem transport errors embed `URL: <rpcUrl>` in their
// message — none of the patterns above would catch that. Any http(s) URL in
// free text that carries anything beyond a bare origin (userinfo, a path other
// than `/`, a query or a fragment) is reduced to `scheme://host[:port]/<redacted>`.
// A bare origin (`http://127.0.0.1:8545`) is left alone: it holds no secret and
// keeps diagnostics readable. Trailing sentence punctuation is not part of the URL.
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`)\]}]+/gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const URL_PARTS = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i;

const redactUrlMatch = (match: string): string => {
  const trailing = URL_TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
  const url = trailing === '' ? match : match.slice(0, -trailing.length);
  const parts = URL_PARTS.exec(url);
  if (parts === null) return match;
  const [, scheme, authority, rest] = parts;
  const hasUserinfo = authority.includes('@');
  if (!hasUserinfo && (rest === '' || rest === '/')) return match;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  return `${scheme.toLowerCase()}://${hostPort}/<redacted>${trailing}`;
};

export const redactSecrets = (text: string): string =>
  text
    .replace(URL_PATTERN, redactUrlMatch)
    .replace(HEX_RUN_PATTERN, (match) => `0x…${match.slice(-4)}`)
    .replace(BARE_HEX_KEY_PATTERN, (match) => `…${match.slice(-4)}`)
    .replace(MNEMONIC_PATTERN, () => '<redacted mnemonic>');

/** Formats any thrown value as a redacted string, safe to log or throw onward. */
export const redactError = (error: unknown): string =>
  redactSecrets(error instanceof Error ? error.message : String(error));

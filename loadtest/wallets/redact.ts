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

export const redactSecrets = (text: string): string =>
  text
    .replace(HEX_RUN_PATTERN, (match) => `0x…${match.slice(-4)}`)
    .replace(BARE_HEX_KEY_PATTERN, (match) => `…${match.slice(-4)}`)
    .replace(MNEMONIC_PATTERN, () => '<redacted mnemonic>');

/** Formats any thrown value as a redacted string, safe to log or throw onward. */
export const redactError = (error: unknown): string =>
  redactSecrets(error instanceof Error ? error.message : String(error));

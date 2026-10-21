// Escaping for the single-file HTML report (S54, heavy-load design §4.1).
//
// Every dynamic value that reaches the page goes through `esc()`; the only other
// way text enters a script context is `safeJsonForScript()`. Pure, no I/O except
// the hash helper (node:crypto).
import { createHash } from 'node:crypto';

/** Strings from the data (error samples, meta values) are cut to this many characters before escaping. */
export const MAX_TEXT_CHARS = 300;

export const clip = (text: string, max: number = MAX_TEXT_CHARS): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** Text and double-quoted attribute escape: `& < > " '`. Accepts any value; `null`/`undefined` give an empty string. */
export const esc = (value: unknown, max: number = MAX_TEXT_CHARS): string =>
  clip(value === null || value === undefined ? '' : String(value), max)
    .replace(/[&<>"']/g, (ch) => ENTITIES[ch])
    // A scheme separator is written as entities so the page holds no literal
    // `http://` / `https://` (nothing can read as a resource load); it renders
    // and copies as the plain URL.
    .replace(/\b(https?):\/\//gi, '$1:&#47;&#47;');

/**
 * JSON for an inline `<script type="application/json">`: `<`, `>`, `&` and the
 * two line separators are written as `\uXXXX`, so no string value can close the
 * element or start a comment, and the text is still valid JSON.
 */
export const safeJsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/\b(https?):\/\//gi, '$1:\\u002f\\u002f')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** `'sha256-<base64>'` source expression for a CSP `script-src`. */
export const cspHash = (scriptText: string): string =>
  `'sha256-${createHash('sha256').update(scriptText, 'utf8').digest('base64')}'`;

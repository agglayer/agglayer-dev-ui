import { describe, expect, it } from 'vitest';

import { summarizeError } from './format';

describe('summarizeError', () => {
  it('uses the message of an Error', () => {
    expect(summarizeError(new Error('HTTP error 403'))).toBe('HTTP error 403');
  });

  it('strips HTML tags and collapses whitespace (e.g. a Cloudflare block page)', () => {
    const html = 'HTTP error 403 with body: <html>\n<h1>Sorry,   you have been blocked</h1></html>';
    expect(summarizeError(new Error(html))).toBe(
      'HTTP error 403 with body: Sorry, you have been blocked'
    );
  });

  it('truncates long messages', () => {
    const out = summarizeError(new Error('x'.repeat(500)));
    expect(out).toHaveLength(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back for empty/unknown values', () => {
    expect(summarizeError(undefined)).toBe('Unknown error');
    expect(summarizeError(new Error(''))).toBe('Unknown error');
  });
});

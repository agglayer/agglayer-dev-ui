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

  it('redacts URLs (RPC URLs may embed an API key)', () => {
    const msg =
      'HTTP request failed.\nURL: https://rpc.example.xyz/SECRETTOKEN123456\nRequest body: {"method":"eth_call"}';
    const out = summarizeError(new Error(msg));
    expect(out).toContain('[redacted URL]');
    expect(out).not.toContain('SECRETTOKEN123456');
    expect(out).not.toContain('rpc.example.xyz');
    expect(summarizeError(new Error('failed wss://ws.example.io/KEY999'))).toBe(
      'failed [redacted URL]'
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

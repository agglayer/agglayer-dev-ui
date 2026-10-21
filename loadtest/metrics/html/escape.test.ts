import { describe, expect, it } from 'vitest';

import { clip, cspHash, esc, MAX_TEXT_CHARS, safeJsonForScript } from './escape';

describe('esc', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });

  it('turns null, undefined and numbers into text', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
  });

  it('cuts a long string to the cap before escaping', () => {
    const out = esc('<'.repeat(MAX_TEXT_CHARS + 50));
    expect(out).toBe(`${'&lt;'.repeat(MAX_TEXT_CHARS)}…`);
    expect(clip('abc', 2)).toBe('ab…');
  });

  it('never leaves a literal http:// or https:// scheme separator in the output', () => {
    const out = esc('see https://host.example.invalid/x and http://127.0.0.1:8545');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain('https:&#47;&#47;host.example.invalid/x');
  });
});

describe('safeJsonForScript', () => {
  const nasty = {
    a: '</script><!--',
    b: 'x & y > z',
    c: `line${String.fromCharCode(0x2028)}sep${String.fromCharCode(0x2029)}`,
    d: 'https://host.example.invalid/p'
  };

  it('contains none of the characters that can end or open a script element', () => {
    const text = safeJsonForScript(nasty);
    expect(text).not.toMatch(new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`));
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('is still valid JSON that round-trips the data', () => {
    expect(JSON.parse(safeJsonForScript(nasty))).toStrictEqual(nasty);
  });
});

describe('cspHash', () => {
  it('is a quoted sha256 source expression', () => {
    expect(cspHash('abc')).toBe("'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='");
  });
});

import { describe, expect, it } from 'vitest';

import { redactError, redactSecrets } from './redact';

const PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';
const ADDRESS = '0xE34aaF64b29273B7D567FCFc40544c014EEe9970';

describe('redactSecrets', () => {
  it('redacts a 64-hex-char private key to 0x…<last4>', () => {
    const redacted = redactSecrets(`funder key is ${PRIVATE_KEY}`);
    expect(redacted).not.toContain(PRIVATE_KEY);
    expect(redacted).toContain(`0x…${PRIVATE_KEY.slice(-4)}`);
  });

  it('also redacts a bare 40-hex-char address run (documented trade-off, DESIGN §2.2)', () => {
    const redacted = redactSecrets(`sender ${ADDRESS} failed`);
    expect(redacted).not.toContain(ADDRESS);
    expect(redacted).toContain(`0x…${ADDRESS.slice(-4)}`);
  });

  it('redacts multiple occurrences in one message', () => {
    const redacted = redactSecrets(`from ${PRIVATE_KEY} to ${ADDRESS}`);
    expect(redacted).not.toContain(PRIVATE_KEY);
    expect(redacted).not.toContain(ADDRESS);
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('preflight failed: PREFLIGHT_GAS: u3 underfunded on L2A')).toBe(
      'preflight failed: PREFLIGHT_GAS: u3 underfunded on L2A'
    );
  });

  it('does not touch a short hex run below the 40-char threshold', () => {
    expect(redactSecrets('selector 0x3c351e10')).toBe('selector 0x3c351e10');
  });

  // R21 (loadtest/REVIEW.md): the original pattern required the literal
  // `0x` prefix, so a key transcribed without it slipped through entirely.
  it('R21: redacts an UN-PREFIXED 64-hex-char private key', () => {
    const bareKey = PRIVATE_KEY.slice(2); // drop the "0x"
    const redacted = redactSecrets(`raw key ${bareKey} leaked`);
    expect(redacted).not.toContain(bareKey);
    expect(redacted).toContain(`…${bareKey.slice(-4)}`);
  });

  // R21: LOADTEST_MNEMONIC is the highest-value secret this tool handles
  // (it derives every user wallet) and had NO redaction coverage at all —
  // a mnemonic has no hex shape, so neither pre-existing pattern could ever
  // catch one.
  it('R21: redacts a BIP-39-shaped mnemonic (12 lowercase words)', () => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const redacted = redactSecrets(`funder mnemonic is ${mnemonic} — resolve failed`);
    expect(redacted).not.toContain(mnemonic);
    expect(redacted).toContain('<redacted mnemonic>');
  });

  it('R21: redacts a 24-word mnemonic too', () => {
    const words = [
      'abandon',
      'ability',
      'able',
      'about',
      'above',
      'absent',
      'absorb',
      'abstract',
      'absurd'
    ];
    const mnemonic = Array.from({ length: 24 }, (_, i) => words[i % words.length]).join(' ');
    const redacted = redactSecrets(`mnemonic: ${mnemonic}`);
    expect(redacted).not.toContain(mnemonic);
    expect(redacted).toContain('<redacted mnemonic>');
  });

  it('R21: does not redact ordinary short technical prose (well under 12 words)', () => {
    const message = 'preflight failed: PREFLIGHT_GAS: u3 underfunded on L2A';
    expect(redactSecrets(message)).toBe(message);
  });
});

describe('redactError', () => {
  it('formats an Error message, redacted', () => {
    expect(redactError(new Error(`send failed, key ${PRIVATE_KEY}`))).toBe(
      `send failed, key 0x…${PRIVATE_KEY.slice(-4)}`
    );
  });

  it('formats a non-Error thrown value, redacted', () => {
    expect(redactError(`raw string with ${PRIVATE_KEY}`)).toBe(
      `raw string with 0x…${PRIVATE_KEY.slice(-4)}`
    );
  });
});

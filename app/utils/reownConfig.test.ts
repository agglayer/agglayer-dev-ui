import { describe, expect, it } from 'vitest';

import { isPlaceholderProjectId, PRODUCTION_METADATA_URL, resolveMetadataUrl } from './reownConfig';

describe('isPlaceholderProjectId', () => {
  it('treats the checked-in .env.example/.env.local literal as a placeholder', () => {
    expect(isPlaceholderProjectId('YOUR_PROJECT_ID_HERE')).toBe(true);
  });

  it('treats an empty string as a placeholder', () => {
    expect(isPlaceholderProjectId('')).toBe(true);
  });

  it('treats a whitespace-only string as a placeholder', () => {
    expect(isPlaceholderProjectId('   ')).toBe(true);
  });

  it('treats undefined/null as a placeholder', () => {
    expect(isPlaceholderProjectId(undefined)).toBe(true);
    expect(isPlaceholderProjectId(null)).toBe(true);
  });

  it('does not treat a real-shaped WalletConnect Cloud project id as a placeholder', () => {
    expect(isPlaceholderProjectId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
  });

  it('is case-sensitive (does not over-match near-miss strings)', () => {
    expect(isPlaceholderProjectId('your_project_id_here')).toBe(false);
  });
});

describe('resolveMetadataUrl', () => {
  it('uses the provided origin when given one', () => {
    expect(resolveMetadataUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('falls back to the production URL for an empty origin', () => {
    expect(resolveMetadataUrl('')).toBe(PRODUCTION_METADATA_URL);
  });

  it('falls back to the production URL for a whitespace-only origin', () => {
    expect(resolveMetadataUrl('   ')).toBe(PRODUCTION_METADATA_URL);
  });

  it('reads window.location.origin when no origin argument is given (jsdom test environment)', () => {
    // vitest's jsdom environment always defines `window`, so the SSR
    // (`typeof window === 'undefined'`) branch itself can't run here -- that
    // branch is exercised for real whenever this module is evaluated during
    // Next.js SSR/static export, where `window` genuinely doesn't exist.
    expect(resolveMetadataUrl()).toBe(window.location.origin);
  });
});

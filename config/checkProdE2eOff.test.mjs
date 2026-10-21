import { describe, expect, it } from 'vitest';

import { findProdE2eViolations } from '../scripts/checkProdE2eOff.mjs';

// Guards the production-E2E guard itself (scripts/checkProdE2eOff.mjs): the
// runtime E2E key override (app/context/e2eAccount.ts) is only safe while
// NEXT_PUBLIC_E2E_ENABLED stays out of every production build surface, so the
// scanner must catch an enabling assignment in each surface's syntax and must
// stay quiet on 'false', empty, and commented-out lines. Semantics come from
// the app: IS_E2E_ENABLED === (NEXT_PUBLIC_E2E_ENABLED === 'true').
describe('findProdE2eViolations', () => {
  describe('.env.production surface (env-file kind)', () => {
    it('flags an enabling assignment', () => {
      const text = [
        '# production env',
        'NEXT_PUBLIC_AGGKIT_PROXY=https://proxy.example',
        'NEXT_PUBLIC_E2E_ENABLED=true',
        'NEXT_PUBLIC_E2E_PRIVATE_KEY=0xabc'
      ].join('\n');
      expect(findProdE2eViolations('env-file', text)).toEqual([{ line: 3, value: 'true' }]);
    });

    it('flags a truthy-looking non-true value (latent footgun, e.g. a secrets reference)', () => {
      const text = 'NEXT_PUBLIC_E2E_ENABLED=${{ secrets.NEXT_PUBLIC_E2E_ENABLED }}';
      expect(findProdE2eViolations('env-file', text)).toEqual([
        { line: 1, value: '${{ secrets.NEXT_PUBLIC_E2E_ENABLED }}' }
      ]);
    });

    it('flags a quoted true', () => {
      expect(findProdE2eViolations('env-file', `NEXT_PUBLIC_E2E_ENABLED="true"`)).toEqual([
        { line: 1, value: 'true' }
      ]);
    });

    it('stays quiet on false, empty, and commented-out assignments', () => {
      const text = [
        'NEXT_PUBLIC_E2E_ENABLED=false',
        "NEXT_PUBLIC_E2E_ENABLED=''",
        '# NEXT_PUBLIC_E2E_ENABLED=true  (commented out -- not an assignment)',
        'NEXT_PUBLIC_E2E_ENABLED= # empty',
        'NEXT_PUBLIC_OTHER_FLAG=true'
      ].join('\n');
      expect(findProdE2eViolations('env-file', text)).toEqual([]);
    });
  });

  describe('deploy workflow surface (workflow-env kind)', () => {
    it('flags a mapping assignment and a block-list assignment', () => {
      const text = [
        '      - run: pnpm exec wrangler deploy --env production',
        '        env:',
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_WORKER_API_TOKEN }}',
        '          NEXT_PUBLIC_E2E_ENABLED: true',
        '      - name: step',
        '        env:',
        '          - NEXT_PUBLIC_E2E_ENABLED: ${{ secrets.NEXT_PUBLIC_E2E_ENABLED }}'
      ].join('\n');
      expect(findProdE2eViolations('workflow-env', text)).toEqual([
        { line: 4, value: 'true' },
        { line: 7, value: '${{ secrets.NEXT_PUBLIC_E2E_ENABLED }}' }
      ]);
    });

    it('stays quiet on false, empty, and other vars', () => {
      const text = [
        '        env:',
        "          NEXT_PUBLIC_E2E_ENABLED: 'false'",
        '          NEXT_PUBLIC_E2E_ENABLED:', // empty value == unset
        '          NEXT_PUBLIC_PROJECT_ID: ${{ secrets.NEXT_PUBLIC_PROJECT_ID }}'
      ].join('\n');
      expect(findProdE2eViolations('workflow-env', text)).toEqual([]);
    });

    it('does not match a similarly-prefixed variable', () => {
      const text = '          NEXT_PUBLIC_E2E_ENABLED_V2: true';
      expect(findProdE2eViolations('workflow-env', text)).toEqual([]);
    });
  });

  describe('Dockerfile surface (dockerfile kind)', () => {
    it('flags ARG and ENV assignments in both forms', () => {
      const text = [
        'ARG NEXT_PUBLIC_E2E_ENABLED=true',
        'ENV NEXT_PUBLIC_E2E_ENABLED=true',
        'ENV NEXT_PUBLIC_E2E_ENABLED ${{ secrets.NEXT_PUBLIC_E2E_ENABLED }}'
      ].join('\n');
      expect(findProdE2eViolations('dockerfile', text)).toEqual([
        { line: 1, value: 'true' },
        { line: 2, value: 'true' },
        { line: 3, value: '${{ secrets.NEXT_PUBLIC_E2E_ENABLED }}' }
      ]);
    });

    it('stays quiet on false and on unrelated ARG/ENV lines', () => {
      const text = [
        'ARG NODE_VERSION=24',
        'ENV HUSKY=0',
        'ARG NEXT_PUBLIC_E2E_ENABLED=false',
        'ENV DEV_UI_BUILD_COMMIT=abc123'
      ].join('\n');
      expect(findProdE2eViolations('dockerfile', text)).toEqual([]);
    });
  });
});

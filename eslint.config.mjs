import { defineConfig, globalIgnores } from 'eslint/config';

import { frontend, recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ...frontend(),
  globalIgnores([
    '.next/**',
    '.next-partial-failure/**',
    'out/**',
    'build/**',
    'dist/**',
    'next-env.d.ts',
    // Vendored agglayer/sdk source staged for the Docker build by
    // scripts/stage-sdk-src.sh (gitignored, not ours to lint). Without this,
    // simply following docs/docker.md's documented local build prerequisite
    // turns `pnpm run lint` -- and therefore `pnpm run check` -- red with
    // dozens of errors in someone else's repo. Flat config, unlike eslintrc,
    // does not skip dot-directories by default.
    // TEMPORARY -- remove per plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §5
    '.sdk-src/**'
  ])
]);

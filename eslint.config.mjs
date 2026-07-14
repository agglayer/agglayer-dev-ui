import { defineConfig, globalIgnores } from 'eslint/config';

import { frontend, recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ...frontend(),
  globalIgnores(['.next/**', '.next-partial-failure/**', 'out/**', 'build/**', 'dist/**', 'next-env.d.ts'])
]);

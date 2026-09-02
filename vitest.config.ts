import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Mirrors tsconfig.json's `@/*` -> `./*` path mapping (Next.js resolves
  // this natively; Vite/Vitest does not without an explicit alias). Needed
  // so tests can import app code the same way the app itself does — the
  // only pre-existing test (app/utils/address.test.ts) sidestepped this by
  // using a relative import, which isn't viable once a hook/component under
  // test pulls in its own `@/app/...` dependencies (S8).
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'app/**/*.{test,spec}.{ts,tsx}',
      'src/**/*.{test,spec}.{ts,tsx}',
      'config/**/*.{test,spec}.mjs'
    ],
    exclude: ['node_modules/**', '.next/**', 'out/**', 'tests/**']
  }
});

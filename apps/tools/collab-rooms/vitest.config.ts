import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // What build.mjs swaps in for the Workers-only module.
    alias: [{ find: /^cloudflare:workers$/, replacement: here('./src/runtime/cloudflare-workers.ts') }],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

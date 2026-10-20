import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
  },
  resolve: {
    alias: {
      // `cloudflare:workers` has no node resolution; point it at a stub so
      // src/index.ts (which re-exports the Durable Object classes) can load.
      'cloudflare:workers': fileURLToPath(new URL('./src/test/cloudflare-workers-stub.ts', import.meta.url)),
    },
  },
});

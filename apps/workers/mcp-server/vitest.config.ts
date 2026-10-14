import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // pglite (the WeldReach route tests) downloads its WASM and applies every
    // tenant migration on first use.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      // The WeldReach inbox module (read here, sent from the public API) imports
      // @weldsuite/smtp, which connects through `cloudflare:sockets`, a Workers-only
      // module. Nothing in this worker ever connects; the stub only lets it load.
      'cloudflare:sockets': path.resolve(__dirname, '../../../packages/core/smtp/src/testing/cloudflare-sockets-stub.ts'),
    },
  },
});

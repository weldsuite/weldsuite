import { defineConfig } from 'vitest/config';
import path from 'node:path';

// social-publish.test.ts mocks ../lib/social-context. With isolate:false every file shares one
// module registry, so once another file has loaded the routes the mock no longer applies. The
// `test` script therefore runs that file in its own vitest process (see package.json).
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard).
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    // All specs share ONE in-process pglite instance (expensive to build and
    // memory-heavy). Run them in a single fork without per-file isolation so
    // the module-level cache in src/test/pglite.ts is reused across files —
    // migrations run exactly once. (Parallel forks each booting their own
    // pglite race the WASM error stack: "ERRORDATA_STACK_SIZE exceeded".)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    isolate: false,
    // pglite WASM download + full tenant migration on first call is slow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workers-only module; the mail send routes import @weldsuite/worker-email.
      'cloudflare:email': path.resolve(
        __dirname,
        '../../../packages/core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
      // Workers-only module; the WeldReach reply route sends over @weldsuite/smtp, which connects
      // through it. Same idea as the smtp package's own stub, but a test can install a socket
      // factory (a fake SMTP server), so the real send path runs with no seam in the worker code.
      'cloudflare:sockets': path.resolve(__dirname, './src/test/cloudflare-sockets-stub.ts'),
    },
  },
});

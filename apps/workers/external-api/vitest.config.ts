import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
    },
  },
});

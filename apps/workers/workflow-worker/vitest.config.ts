import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard),
    // matching the app-api convention.
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    // pglite boot + the WeldSuite tenant migrations take a few seconds on the
    // first test; give beforeAll hooks room.
    testTimeout: 30_000,
    hookTimeout: 90_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

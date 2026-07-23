import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard, matching the
    // packages/ai / app-api / workflow-worker convention.
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
  },
});

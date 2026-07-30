import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard),
    // matching the app-api and workflow-worker convention.
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
  },
  resolve: {
    alias: {
      // `cloudflare:workers` is a Workers-runtime module with no node
      // resolution; point it at a test stub so modules that transitively
      // import a workflow can load.
      'cloudflare:workers': path.resolve(__dirname, './src/test/stubs/cloudflare-workers.ts'),
    },
  },
});

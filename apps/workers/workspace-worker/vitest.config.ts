import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Several test files boot PGlite (WASM Postgres), which crashes when many instances start
    // at once (see the note on the unit jobs in .github/workflows/ci.yml): run the files one by one.
    fileParallelism: false,
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard),
    // matching the app-api and workflow-worker convention.
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
  },
  resolve: {
    alias: {
      // `cloudflare:workers` and `cloudflare:workflows` are Workers-runtime
      // modules with no node resolution; point them at test stubs so modules
      // that transitively import a workflow can load.
      'cloudflare:workers': path.resolve(__dirname, './src/test/stubs/cloudflare-workers.ts'),
      'cloudflare:workflows': path.resolve(__dirname, './src/test/stubs/cloudflare-workflows.ts'),
    },
  },
});

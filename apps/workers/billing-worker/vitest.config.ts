import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard),
    // matching the app-api, workspace-worker and workflow-worker convention.
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
  },
  resolve: {
    alias: {
      // `cloudflare:email` is a Workers-runtime module with no node resolution;
      // @weldsuite/emails' binding transport (partner mail) imports it, so point
      // it at a test stub. Tests never send email.
      'cloudflare:email': path.resolve(__dirname, './src/test/stubs/cloudflare-email.ts'),
    },
  },
});

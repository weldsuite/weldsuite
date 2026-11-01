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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The Workflow runtime, for the Rust parity fixtures (src/testing/rust-fixtures.test.ts).
      'cloudflare:workers': path.resolve(__dirname, './src/testing/cloudflare-workers-stub.ts'),
      'cloudflare:workflows': path.resolve(__dirname, './src/testing/cloudflare-workers-stub.ts'),
      // Workers-only module; the WeldDesk inbox actions notify the team through
      // @weldsuite/notifications, whose email channel imports @weldsuite/emails.
      'cloudflare:email': path.resolve(
        __dirname,
        '../../../packages/core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
    },
  },
});

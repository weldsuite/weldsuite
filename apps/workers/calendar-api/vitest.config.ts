import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The Workers runtime runs in UTC, and so does the calendar code that reads
// local time (the auto-scheduler's working hours, `new Date('2030-03-01T10:00')`).
// The tests run there too, so they agree with production and with the Rust
// backend in conformance mode, whatever the machine's zone.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workers-only module; any worker that (transitively) imports
      // @weldsuite/worker-email needs this under vitest.
      'cloudflare:email': path.resolve(
        __dirname,
        '../../../packages/core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
    },
  },
});

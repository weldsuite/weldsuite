import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
      // Workers-only module; src/index.ts exports the CallInternal
      // WorkerEntrypoint.
      'cloudflare:workers': path.resolve(
        __dirname,
        '../../../packages/core/worker-kit/src/testing/cloudflare-workers-stub.ts',
      ),
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

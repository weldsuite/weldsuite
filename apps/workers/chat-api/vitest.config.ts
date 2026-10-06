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
    // Coverage feeds SonarQube Cloud (see sonar-project.properties). lcov paths
    // are written relative to the repo root so Sonar can match them.
    coverage: {
      provider: 'v8',
      reporter: ['text', ['lcov', { projectRoot: path.resolve(__dirname, '../../..') }]],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**'],
    },
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
      // Workers-only module; src/index.ts re-exports the UnpinExpiredMessage
      // workflow class (@weldsuite/chat-domain), which extends WorkflowEntrypoint.
      'cloudflare:workers': path.resolve(
        __dirname,
        '../../../packages/domains/chat/src/testing/cloudflare-workers-stub.ts',
      ),
    },
  },
});

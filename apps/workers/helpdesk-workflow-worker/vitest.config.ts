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
    // The first pglite database takes a while: it applies every tenant migration.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // Workers-only module: ConversationWorkflow extends WorkflowEntrypoint,
      // AssignmentRouter extends DurableObject.
      'cloudflare:workers': path.resolve(
        import.meta.dirname,
        '../../../packages/core/worker-kit/src/testing/cloudflare-workers-stub.ts',
      ),
    },
  },
});

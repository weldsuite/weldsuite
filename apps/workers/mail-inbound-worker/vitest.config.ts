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
      // `cloudflare:workers` is a Workers-runtime module with no node
      // resolution; `email-storage.store.test.ts` constructs a real
      // `MailboxStoreObject` (`@weldsuite/mail-domain/mailbox-object`,
      // `extends DurableObject`) through the mail-domain object-store test
      // fakes, so it needs to load under vitest (same pattern as
      // apps/workers/workspace-worker and `@weldsuite/mail-domain` itself).
      'cloudflare:workers': path.resolve(__dirname, './src/test/stubs/cloudflare-workers.ts'),
    },
  },
});

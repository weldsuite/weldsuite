import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // pglite (the WeldReach route tests) downloads its WASM and applies every
    // tenant migration on first use.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The project-control and delivery schema (new tables and columns) has no
    // migration yet: pglite diffs it in memory against the last snapshot. Empty
    // once the migration exists; remove then (worker-kit testing/pglite.ts).
    // Task writes through flow-domain keep the typed task_dependencies rows.
    env: { PGLITE_SCHEMA_DELTA: '1' },
  },
  resolve: {
    alias: {
      // Workers-only module; WeldDesk inbox writes notify the team through
      // @weldsuite/notifications, whose email channel imports @weldsuite/emails.
      'cloudflare:email': path.resolve(
        __dirname,
        '../../../packages/core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
      // The WeldReach inbox module (read here, sent from the public API) imports
      // @weldsuite/smtp, which connects through `cloudflare:sockets`, a Workers-only
      // module. Nothing in this worker ever connects; the stub only lets it load.
      'cloudflare:sockets': path.resolve(__dirname, '../../../packages/core/smtp/src/testing/cloudflare-sockets-stub.ts'),
      // Workers-only module; the object-mode mail tests pull in the C2 fakes
      // (`@weldsuite/mail-domain/store/object/testing/fake-env`), which run
      // the real `MailboxStoreObject` class (`extends DurableObject`). Same
      // stub mail-api's own vitest config uses.
      'cloudflare:workers': path.resolve(
        __dirname,
        '../../../packages/domains/mail/src/testing/cloudflare-workers-stub.ts',
      ),
    },
  },
});

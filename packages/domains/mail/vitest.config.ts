import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks' },
  resolve: {
    alias: {
      // Workers-only module; the send helpers import @weldsuite/worker-email.
      'cloudflare:email': path.resolve(
        __dirname,
        '../../core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
    },
  },
});

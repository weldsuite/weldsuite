import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks' },
  resolve: {
    alias: {
      // Workers-only modules the room imports, which don't resolve under node.
      'cloudflare:workers': path.resolve(__dirname, '../../core/worker-kit/src/testing/cloudflare-workers-stub.ts'),
      'cloudflare:email': path.resolve(__dirname, '../../core/worker-email/src/testing/cloudflare-email-stub.ts'),
    },
  },
});

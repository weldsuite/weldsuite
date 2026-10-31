import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    pool: 'forks',
  },
  resolve: {
    alias: {
      // Workers-only modules: the sign-in email transport imports
      // `cloudflare:email`, the rate limiter extends `cloudflare:workers`.
      'cloudflare:email': path.resolve(import.meta.dirname, '../../../packages/core/worker-email/src/testing/cloudflare-email-stub.ts'),
      'cloudflare:workers': path.resolve(import.meta.dirname, './src/testing/cloudflare-workers-stub.ts'),
    },
  },
});

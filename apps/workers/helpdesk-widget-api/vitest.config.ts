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
      '@': path.resolve(import.meta.dirname, './src'),
      // Workers-only modules. @weldsuite/emails' binding transport (the
      // sign-in code mail, and notifications) imports `cloudflare:email`; the
      // PortalRateLimiter Durable Object extends `cloudflare:workers`.
      'cloudflare:email': path.resolve(
        import.meta.dirname,
        '../../../packages/core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
      'cloudflare:workers': path.resolve(import.meta.dirname, './src/testing/cloudflare-workers-stub.ts'),
    },
  },
});

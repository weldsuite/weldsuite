import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
  resolve: {
    alias: {
      // Workers-only module, pulled in by @weldsuite/worker-email (binding transport).
      'cloudflare:email': path.resolve(
        __dirname,
        '../worker-email/src/testing/cloudflare-email-stub.ts',
      ),
    },
  },
});

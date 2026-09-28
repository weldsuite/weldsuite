import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: {
    alias: {
      // Workers-only module; see src/testing/cloudflare-email-stub.ts.
      'cloudflare:email': path.resolve(__dirname, './src/testing/cloudflare-email-stub.ts'),
    },
  },
});

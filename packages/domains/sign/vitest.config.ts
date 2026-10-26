import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks' },
  resolve: {
    alias: {
      // Workers-only module: SignCodeAttempts extends its DurableObject.
      'cloudflare:workers': path.resolve(__dirname, '../../core/worker-kit/src/testing/cloudflare-workers-stub.ts'),
    },
  },
});

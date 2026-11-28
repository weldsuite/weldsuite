import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: {
    alias: {
      // CollabRoom (durable-room.ts) extends the Workers-only `DurableObject`, which doesn't resolve under node.
      'cloudflare:workers': path.resolve(__dirname, 'src/testing/cloudflare-workers-stub.ts'),
    },
  },
});

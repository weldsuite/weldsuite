import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks' },
  resolve: {
    alias: {
      // @weldsuite/smtp connects over cloudflare:sockets (a Workers-only module); tests inject a fake socket.
      'cloudflare:sockets': path.resolve(__dirname, '../../core/smtp/src/testing/cloudflare-sockets-stub.ts'),
    },
  },
});

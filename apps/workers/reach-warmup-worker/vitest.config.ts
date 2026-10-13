import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workers-only modules; tests inject fake sockets.
      'cloudflare:sockets': path.resolve(__dirname, '../../../packages/core/smtp/src/testing/cloudflare-sockets-stub.ts'),
    },
  },
});

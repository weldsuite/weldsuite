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
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Workers-only module: the Durable Objects and the Workflow extend its classes.
      { find: 'cloudflare:workers', replacement: path.resolve(__dirname, './src/testing/cloudflare-workers-stub.ts') },
      { find: 'cloudflare:workflows', replacement: path.resolve(__dirname, './src/testing/cloudflare-workflows-stub.ts') },
    ],
  },
});

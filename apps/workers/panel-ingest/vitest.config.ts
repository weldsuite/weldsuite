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
      // Workers-only module; the Durable Object classes extend DurableObject.
      { find: 'cloudflare:workers', replacement: path.resolve(__dirname, './src/testing/cloudflare-workers-stub.ts') },
      // The SDK bundle is a build artefact that wrangler imports as text; tests never need it built.
      {
        find: /^@weldsuite\/panel-sdk\/dist\/panel\.global\.js$/,
        replacement: path.resolve(__dirname, './src/testing/sdk-bundle-stub.ts'),
      },
    ],
  },
});

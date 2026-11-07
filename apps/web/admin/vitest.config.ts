/// <reference types="vitest" />
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['lib/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      // Next aliases `server-only` itself; it isn't a dependency of this app,
      // so modules marked with it resolve to an empty module under vitest.
      'server-only': path.resolve(__dirname, 'test/server-only.ts'),
    },
  },
});

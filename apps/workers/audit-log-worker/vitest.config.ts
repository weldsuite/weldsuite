import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    // Exact matches only: a plain string alias would also rewrite subpaths such
    // as `@weldsuite/db/schema` (imported by `@weldsuite/core-domain`).
    alias: [
      {
        find: /^@weldsuite\/entity-events$/,
        replacement: path.resolve(__dirname, '../../../packages/core/entity-events/src/index.ts'),
      },
      {
        find: /^@weldsuite\/db$/,
        replacement: path.resolve(__dirname, '../../../packages/core/db/src/index.ts'),
      },
    ],
  },
});

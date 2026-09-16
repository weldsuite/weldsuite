import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@weldsuite/entity-events': path.resolve(
        __dirname,
        '../../../packages/core/entity-events/src/index.ts',
      ),
      '@weldsuite/entity-events/types': path.resolve(
        __dirname,
        '../../../packages/core/entity-events/src/types.ts',
      ),
      '@weldsuite/db/schema': path.resolve(
        __dirname,
        '../../../packages/core/db/src/schema/index.ts',
      ),
    },
  },
});

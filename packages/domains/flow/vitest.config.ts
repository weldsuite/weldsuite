import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    passWithNoTests: true,
    // The project-control and delivery schema has no migration yet: pglite diffs
    // it in memory against the last snapshot. Empty once the migration exists;
    // remove then (worker-kit testing/pglite.ts).
    env: { PGLITE_SCHEMA_DELTA: '1' },
  },
});

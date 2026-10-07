import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The teamspace access rules are covered end to end by know-api's route tests.
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

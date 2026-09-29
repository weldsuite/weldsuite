import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the commerce portal tests live in commerce-api).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

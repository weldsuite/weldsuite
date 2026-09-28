import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the WeldData route tests live in data-api).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the WeldMeet route tests live in meet-api).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

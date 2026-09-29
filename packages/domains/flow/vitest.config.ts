import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the WeldFlow route tests live in flow-api).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

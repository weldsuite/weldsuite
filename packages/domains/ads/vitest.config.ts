import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the ads tests live in ads-api).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

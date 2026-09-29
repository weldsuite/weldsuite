import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the WeldDesk route tests live in the desk and call workers).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

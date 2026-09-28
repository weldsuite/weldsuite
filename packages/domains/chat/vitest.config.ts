import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No tests of its own yet (the chat-calls / RTK webhook tests live in the workers).
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks', passWithNoTests: true },
});

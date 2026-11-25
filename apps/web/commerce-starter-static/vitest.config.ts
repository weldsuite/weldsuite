import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: the prerender plugin is not wanted in unit tests.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts', 'prerender/**/*.test.ts'] },
});

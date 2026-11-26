import { defineConfig } from 'vitest/config';

// Unit tests for the HTTP transport (the error types, step-up). No DOM;
// `fetch` is stubbed per test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

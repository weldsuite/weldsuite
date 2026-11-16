import { defineConfig } from 'vitest/config';

// Unit tests for the pure modules shared by the platform and the mobile apps
// (schemas, OIDC claim rules). No DOM, no network.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

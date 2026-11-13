import { defineConfig } from 'vitest/config';

// Only the pure modules are tested here (no React Native): the native
// modules (`expo-*`, AsyncStorage, Clerk) are injected or mocked per test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

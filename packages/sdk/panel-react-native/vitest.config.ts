import { defineConfig } from 'vitest/config';

// Plain node: the SDK's React Native parts sit behind the `platform` adapter,
// which the tests replace (src/test/harness.ts) or mock (platform-native.test.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

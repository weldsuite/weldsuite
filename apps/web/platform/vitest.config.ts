/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard).
    // Distinct filename so it never collides with Playwright's test-results/.
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    // Unit + component tests live next to source. E2E (Playwright) is
    // excluded — it has its own runner. Route-tree gen and build
    // artefacts are excluded too.
    include: [
      'app/**/*.test.{ts,tsx}',
      'lib/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
      'hooks/**/*.test.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
      'src/routeTree.gen.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'app/**/*.{ts,tsx}',
        'lib/**/*.{ts,tsx}',
        'components/**/*.{ts,tsx}',
        'hooks/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.stories.{ts,tsx}',
        '**/*.gen.ts',
        'src/routes/**',
        'providers/**',
        'dist/**',
        'drizzle/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});

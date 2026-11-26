import { defineConfig } from '@playwright/test';

/**
 * The store images (`store-screenshots.ts`), apart from the test run:
 *
 *   pnpm --filter weldpass-extension screenshots   # → store/screenshots/
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'store-screenshots.ts',
  globalSetup: './global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '../test-results',
});

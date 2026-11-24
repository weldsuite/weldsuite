import { defineConfig } from '@playwright/test';

/**
 * Loads the unpacked extension into Chromium against local login pages and a
 * fake WeldSuite server (`fake-server.ts`). One browser, one worker: the
 * extension's state is the browser profile's.
 *
 *   pnpm --filter weldpass-extension exec playwright install chromium   # once
 *   pnpm --filter weldpass-extension test:e2e
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  outputDir: '../test-results',
  use: { trace: 'retain-on-failure' },
});

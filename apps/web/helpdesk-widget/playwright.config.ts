import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration for Helpdesk Widget
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  // Test directory
  testDir: './e2e',

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter configuration
  // 'junit' feeds the aggregated test dashboard (apps/tools/test-dashboard).
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
    ['junit', { outputFile: 'test-results/playwright-junit.xml' }],
    ...(process.env.CI ? [['github'] as const] : []),
  ],

  // Shared settings for all projects
  use: {
    // Base URL for all tests
    baseURL: 'http://localhost:3100',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',

    // Default timeout for actions
    actionTimeout: 10000,

    // Navigation timeout
    navigationTimeout: 30000,
  },

  // Global timeout for each test
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },

  // Configure projects for different browsers/devices
  projects: [
    // Desktop Chrome - primary testing target
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },

    // Desktop Firefox
    {
      name: 'Desktop Firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
      },
    },

    // Mobile Chrome - widget must work on mobile
    {
      name: 'Mobile Chrome',
      use: {
        ...devices['Pixel 5'],
      },
    },

    // Mobile Safari - iOS testing
    {
      name: 'Mobile Safari',
      use: {
        ...devices['iPhone 13'],
      },
    },

    // Tablet - iPad testing
    {
      name: 'Tablet',
      use: {
        ...devices['iPad (gen 7)'],
      },
    },
  ],

  // Web server configuration - auto-start dev server
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  // Output directory for test artifacts
  outputDir: 'test-results',
});

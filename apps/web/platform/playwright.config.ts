import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.test') });

const authFile = path.join(__dirname, 'e2e/.auth/user.json');

export default defineConfig({
  testDir: './e2e',
  // Mints a Clerk Testing Token before the suite so automated sign-in isn't
  // blocked as bot traffic. See e2e/global-setup.ts.
  globalSetup: require.resolve('./e2e/global-setup'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // 'junit' feeds the aggregated test dashboard (apps/tools/test-dashboard).
  reporter: [
    ['html'],
    ['list'],
    ['junit', { outputFile: 'test-results/playwright-junit.xml' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // Authenticated specs — uses the saved Clerk session.
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
      },
      dependencies: ['setup'],
      // Everything except the explicit `unauth/` folder and the
      // `api/` (no-browser) folder runs here.
      testIgnore: ['**/specs/unauth/**', '**/api/**'],
    },
    // Unauthenticated specs — covers `/auth/*` pages, the login flow,
    // and any pre-auth marketing surfaces. NO storageState, so each
    // test starts as an anonymous visitor.
    {
      name: 'chromium-unauth',
      use: {
        ...devices['Desktop Chrome'],
      },
      // No `dependencies` — unauth specs don't need the login setup.
      testMatch: ['**/specs/unauth/**/*.spec.ts'],
    },
    // Firefox smoke — only the route-loop smoke specs run here so we
    // catch CSS/IndexedDB/Service Worker regressions without paying
    // for the full suite on every PR. Full suite stays on Chromium.
    {
      name: 'firefox-smoke',
      use: {
        ...devices['Desktop Firefox'],
        storageState: authFile,
      },
      dependencies: ['setup'],
      testMatch: ['**/specs/smoke/**/*.spec.ts'],
    },
    // API-level specs — exercise app-api directly via Playwright's
    // `request` fixture. No browser, no Clerk session, no webServer
    // dependency. Skips when the test-fixtures env vars aren't set.
    {
      name: 'api',
      use: {
        baseURL: process.env.TEST_API_URL || 'http://localhost:8789',
      },
      testMatch: ['**/api/**/*.spec.ts'],
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});

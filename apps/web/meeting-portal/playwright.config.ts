import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e for the meeting-portal (guest join flow).
 *
 * The portal's own `/api/meeting/*` routes need a tenant DB + Cloudflare
 * RealtimeKit, neither of which is available in CI. Every spec therefore mocks
 * those routes with `page.route(...)` (see e2e/helpers/mock-meeting-api.ts), so
 * the entire server-driven guest journey — loading, errors, landing + form
 * validation, waiting, the waiting room (waitlisted → admitted / denied), and
 * host-must-join-first — is fully deterministic with no backend.
 *
 * The connected in-call room runs on live RealtimeKit/WebRTC and is out of e2e
 * scope; its host-control gating is covered by the @weldsuite/weldmeet-ui
 * component tests instead.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/playwright-junit.xml' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3020',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The landing screen requests camera/mic for the pre-join preview — grant
    // them and use fake devices so getUserMedia resolves deterministically and
    // never blocks on a permission prompt.
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3020',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

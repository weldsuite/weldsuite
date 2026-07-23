import { defineConfig, devices } from '@playwright/experimental-ct-react';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// This package is `"type": "module"`, so `__dirname` isn't defined — derive it.
const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright Component Testing for @weldsuite/weldmeet-ui.
 *
 * These mount the shared in-call UI components (rendered by BOTH the platform
 * app and the meeting portal) in isolation with a fake `meeting` object, so we
 * can assert the host-control gating WITHOUT a live Cloudflare RealtimeKit /
 * WebRTC connection — which is unreachable in normal e2e. See ./ct/*.ct.spec.tsx.
 *
 * Run: pnpm --filter @weldsuite/weldmeet-ui test:ct
 */
export default defineConfig({
  testDir: './ct',
  testMatch: '**/*.ct.spec.tsx',
  snapshotDir: './ct/__snapshots__',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
    ctPort: 3110,
    // The components import workspace packages (@weldsuite/ui, lucide-react)
    // that ship raw .tsx/.ts source — let CT's Vite transform + resolve them.
    ctViteConfig: {
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(dirname, 'src'),
        },
      },
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

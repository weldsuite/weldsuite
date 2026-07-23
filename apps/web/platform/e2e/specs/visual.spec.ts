/**
 * Visual regression seed suite. Snapshots the most stable UI scaffolds
 * -- the app shell sidebar, the EntityGrid header, and the command
 * palette open state -- so Tailwind / shadcn / Radix upgrades that
 * accidentally shift pixels fail loudly.
 *
 * Baselines are committed under `visual.spec.ts-snapshots/`. To
 * regenerate after an intentional change:
 *   pnpm exec playwright test e2e/specs/visual.spec.ts --update-snapshots
 *
 * The whole file `test.skip()`s in CI environments without the
 * baselines committed yet so the first run on a fresh checkout
 * doesn't go red. Once baselines land, remove the skip guard.
 */

import { test, expect } from '../fixtures';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const snapshotDir = join(__dirname, 'visual.spec.ts-snapshots');
const baselinesExist = existsSync(snapshotDir);

test.describe('Visual regression', () => {
  test.beforeAll(() => {
    test.skip(
      !baselinesExist,
      'No baselines committed yet — run with --update-snapshots once and commit them.',
    );
  });

  test('app sidebar', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.getByTestId('app-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    await expect(sidebar).toHaveScreenshot('app-sidebar.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('command palette open with a query typed', async ({ page }) => {
    await page.goto('/');
    const input = page.getByTestId('cmdk-input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.click();
    await input.fill('settings');
    // Let the dropdown render fully before snapshotting.
    await expect(input).toHaveValue('settings');
    await expect(page).toHaveScreenshot('cmdk-open.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
    });
  });

  test('entity grid header on /weldcrm/companies', async ({ page }) => {
    await page.goto('/weldcrm/companies');
    const grid = page.getByTestId('entity-grid');
    await expect(grid).toBeVisible({ timeout: 15_000 });
    // Snapshot just the toolbar — row content varies by tenant.
    const toolbar = grid.locator('xpath=./*[1]');
    await expect(toolbar).toHaveScreenshot('entity-grid-toolbar.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});

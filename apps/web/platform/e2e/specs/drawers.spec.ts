/**
 * Drawer specs — WeldAgent, calendar, notifications all share the
 * "header button toggles a side drawer" pattern. These tests verify
 * the open/close cycle of each.
 */

import { test, expect } from '../fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.sessionStorage.removeItem('weldsuite.notificationsPanel.open');
    window.sessionStorage.removeItem('weldsuite.calendarDrawer.open');
    window.sessionStorage.removeItem('weldsuite.weldAgentDrawer.open');
  });
});

test.describe('Header drawers', () => {
  test('notifications drawer open + close cycle', async ({ page }) => {
    await page.goto('/');
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();
    await expect(page.getByTestId('notifications-panel')).toBeVisible({
      timeout: 5_000,
    });

    await bell.click();
    await expect(page.getByTestId('notifications-panel')).toBeHidden({
      timeout: 5_000,
    });
  });

  test('calendar drawer opens after clicking the toggle', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Desktop-only toggle (md:flex) — wait for it to render rather than an
    // instant isVisible() check, which races the first paint and false-skips.
    const btn = page.getByTestId('calendar-toggle');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    await btn.click();
    await expect(page.getByTestId('calendar-drawer')).toBeVisible({ timeout: 5_000 });

    await btn.click();
    await expect(page.getByTestId('calendar-drawer')).toBeHidden({ timeout: 5_000 });
  });

  test('weldagent drawer opens after clicking the toggle', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    const btn = page.getByTestId('weldagent-toggle');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    await btn.click();
    // Panel is lazy-loaded; allow extra time for the chunk to download.
    await expect(page.getByTestId('weldagent-drawer')).toBeVisible({ timeout: 10_000 });

    await btn.click();
    await expect(page.getByTestId('weldagent-drawer')).toBeHidden({ timeout: 5_000 });
  });
});

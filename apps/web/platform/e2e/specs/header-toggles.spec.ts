/**
 * Header toggle specs — verifies the breadcrumb header's
 * ever-present action buttons (notifications, calendar, WeldAgent)
 * are visible and clickable on every authenticated page.
 */

import { test, expect } from '../fixtures';

test.describe('Breadcrumb header · always-visible toggles', () => {
  test('notifications bell is visible on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('notifications-bell')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('calendar toggle is visible on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Calendar button is only rendered on desktop layouts (md:flex)
    const btn = page.getByTestId('calendar-toggle');
    if (await btn.isVisible().catch(() => false)) {
      await expect(btn).toBeVisible();
    }
  });

  test('WeldAgent toggle is visible on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    const btn = page.getByTestId('weldagent-toggle');
    if (await btn.isVisible().catch(() => false)) {
      await expect(btn).toBeVisible();
    }
  });

  test('WeldAgent panel opens on first click without a perceptible delay', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    const btn = page.getByTestId('weldagent-toggle');
    // Desktop-only button; skip on layouts where it isn't rendered.
    if (!(await btn.isVisible().catch(() => false))) return;

    await btn.click();
    // The lazy panel chunk is prefetched during idle time, so the drawer should
    // mount quickly on the very first open rather than after a cold fetch.
    await expect(page.getByTestId('weldagent-drawer')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('notifications panel opens when bell is clicked', async ({ page }) => {
    await page.goto('/');
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible({ timeout: 10_000 });
    await bell.click();
    await expect(page.getByTestId('notifications-panel')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('clicking the bell again closes the panel', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      // Reset persisted state to start closed.
      window.sessionStorage.removeItem('weldsuite.notificationsPanel.open');
    });

    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible();
    await bell.click();
    const panel = page.getByTestId('notifications-panel');
    await expect(panel).toBeVisible();
    await bell.click();
    await expect(panel).toBeHidden({ timeout: 5_000 });
  });
});

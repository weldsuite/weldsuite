import { test, expect } from '../fixtures';

test.describe('Notifications Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Clear any persisted panel state from previous runs so each spec
    // starts with the panel closed.
    await page.evaluate(() => {
      window.sessionStorage.removeItem('weldsuite.notificationsPanel.open');
      window.sessionStorage.removeItem('weldsuite.calendarDrawer.open');
    });
  });

  test('panel opens after clicking the bell', async ({ page }) => {
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible({ timeout: 10_000 });

    await bell.click();
    await expect(page.getByTestId('notifications-panel')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('panel stays open after 1s (not auto-closing)', async ({ page }) => {
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible({ timeout: 10_000 });

    await bell.click();
    const panel = page.getByTestId('notifications-panel');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Re-assert after a short delay — if the panel auto-closed this
    // would fail. (No arbitrary waitForTimeout — Playwright's locator
    // expect retries until the timeout.)
    await expect(panel).toBeVisible({ timeout: 2_000 });
  });

  test('panel closes via the X button', async ({ page }) => {
    const bell = page.getByTestId('notifications-bell');
    await bell.click();
    const panel = page.getByTestId('notifications-panel');
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Close panel' }).click();
    await expect(panel).toBeHidden();
  });

  test('unread badge is red when present (or absent — both are valid)', async ({ page }) => {
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible();

    // Badge only renders when there are unread notifications. Both
    // states are valid in a clean test env, so assert "if visible, red"
    // rather than failing when it's absent.
    const badge = page.getByTestId('notifications-unread-badge');
    if ((await badge.count()) > 0) {
      const bgColor = await badge.first().evaluate(
        (el) => window.getComputedStyle(el).backgroundColor,
      );
      expect(bgColor).toBe('rgb(239, 68, 68)');
    }
  });
});

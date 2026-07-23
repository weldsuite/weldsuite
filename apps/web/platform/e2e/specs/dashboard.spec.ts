import { test, expect } from '../fixtures';

test.describe('Dashboard', () => {
  test('dashboard page loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/$/);
  });

  test('app sidebar renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('can navigate to CRM from sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-nav-weldcrm')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('app-nav-weldcrm').click();
    await expect(page).toHaveURL(/\/weldcrm/, { timeout: 10_000 });
  });

  test('can navigate to Helpdesk from sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-nav-welddesk')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('app-nav-welddesk').click();
    await expect(page).toHaveURL(/\/welddesk/, { timeout: 10_000 });
  });

  // The auto-applied `consoleErrors` fixture (fixtures.ts) asserts no
  // unexpected console errors on every test in this suite — no separate
  // dashboard-specific console test is needed.
});

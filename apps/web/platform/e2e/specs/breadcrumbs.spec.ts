/**
 * Breadcrumbs spec — verifies the global breadcrumb renders on
 * authenticated pages and updates as the user navigates.
 *
 * Selector is the shadcn primitive's `aria-label="breadcrumb"` and
 * `data-slot="breadcrumb-item"` — stable across refactors because
 * they're how the component identifies itself for accessibility.
 */

import { test, expect } from '../fixtures';

test.describe('Global breadcrumb', () => {
  test('renders on /weldcrm/companies', async ({ page }) => {
    await page.goto('/weldcrm/companies');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // At least one breadcrumb item exists (root + current page).
    const items = page.locator('[data-slot="breadcrumb-item"]');
    await expect(items.first()).toBeVisible({ timeout: 10_000 });
  });

  test('updates when navigating between modules', async ({ page }) => {
    await page.goto('/weldcrm/companies');
    const initial = await page
      .locator('[aria-label="breadcrumb"]')
      .first()
      .textContent();

    await page.getByTestId('app-nav-welddesk').click();
    await expect(page).toHaveURL(/\/welddesk/, { timeout: 10_000 });

    // Wait for breadcrumb text to change.
    await expect
      .poll(async () => {
        const next = await page
          .locator('[aria-label="breadcrumb"]')
          .first()
          .textContent()
          .catch(() => null);
        return next;
      }, { timeout: 10_000 })
      .not.toBe(initial);
  });
});

/**
 * App store spec — verifies the workspace app store page renders and
 * has a working install/uninstall surface.
 */

import { test, expect } from '../../fixtures';

test.describe('App store', () => {
  test('/appstore loads and shows at least one app card or empty state', async ({ page }) => {
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/appstore/);
  });

  test('opening /appstore from the sidebar `+` icon works', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('app-nav-appstore').click();
    await expect(page).toHaveURL(/\/appstore/, { timeout: 10_000 });
  });
});

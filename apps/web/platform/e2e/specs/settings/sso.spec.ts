/**
 * Interaction spec for /settings/sso.
 *
 * The page needs `sso:read` (the seeded test user is the workspace owner).
 * What is under the heading depends on the workspace's plan and add-on, so
 * the checks stay on what every workspace sees: the heading and the sidebar
 * entry. Nothing here changes the workspace's single sign-on configuration or
 * billing.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · Single sign-on', () => {
  test('page renders the Single sign-on heading', async ({ page }) => {
    await page.goto('/settings/sso');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const heading = page.locator('h1').filter({ hasText: /single sign-on/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('the Workspace group of the settings sidebar links to it', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('app-sidebar').getByRole('link', { name: /^single sign-on$/i }).click();

    await expect(page).toHaveURL(/\/settings\/sso\/?$/);
    await expect(page.locator('h1').filter({ hasText: /single sign-on/i })).toBeVisible({ timeout: 10_000 });
  });
});

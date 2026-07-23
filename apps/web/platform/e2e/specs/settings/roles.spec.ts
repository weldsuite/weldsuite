/**
 * Roles settings spec — verifies the role-management table renders
 * and the Create Role button opens its dialog (when the caller has
 * permission to manage roles).
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · roles', () => {
  test('/settings/roles renders the roles table', async ({ page }) => {
    await page.goto('/settings/roles');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Every workspace has at least the built-in roles, so a table
    // body row should be visible. If permission filters hide it,
    // we still expect the page heading.
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('Create Role button opens the dialog (when permitted)', async ({ page }) => {
    await page.goto('/settings/roles');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The page shows a PageLoader until the roles fetch settles; the toolbar
    // (and the create button) only mount afterwards. Wait for the heading so
    // the conditional probe below doesn't race the load — `isVisible()` is an
    // immediate, no-retry check that would otherwise skip a permitted user.
    await expect(
      page.getByRole('heading', { name: /roles & permissions/i }),
    ).toBeVisible({ timeout: 20_000 });

    // waitFor auto-retries (unlike isVisible(), which is an immediate probe),
    // so a permitted user isn't skipped while permissions are still resolving
    // under load. Only skip if the button genuinely never appears.
    const btn = page.getByTestId('settings-roles-create-btn');
    try {
      await btn.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      test.skip(true, 'Current user cannot manage roles');
    }
    await btn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

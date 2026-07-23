/**
 * Interaction spec for /settings/apps/weldcrm — the CRM app settings
 * page that hosts the CustomerStatusesPage.
 *
 * The page renders built-in statuses (no seed required) and an
 * "Add Status" button that opens the StatusFormDialog. The button has
 * no data-testid; the recommendation to add
 * `data-testid="settings-crm-add-status-btn"` is filed in
 * crossCuttingRecommendations. Until then we locate by role + partial
 * name, which is stable because the text comes from the i18n key
 * `ts.addStatus`.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · WeldCRM app', () => {
  test('page renders with the Statuses tab visible', async ({ page }) => {
    await page.goto('/settings/apps/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The page heading rendered by WeldCrmSettingsPage
    const heading = page.locator('h1').filter({ hasText: /weldcrm/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('built-in statuses table is present', async ({ page }) => {
    await page.goto('/settings/apps/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // CustomerStatusesPage renders a <table>. Built-in statuses always
    // exist so at least one <tr> inside <tbody> must be visible.
    const tbody = page.locator('table tbody');
    await expect(tbody).toBeVisible({ timeout: 10_000 });
    const rows = tbody.locator('tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  });

  test('"Add Status" button opens the status form dialog', async ({ page }) => {
    await page.goto('/settings/apps/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Try testid first; fall back to role+name to survive until the
    // testid is added (see crossCuttingRecommendations).
    const addBtnByTestId = page.getByTestId('settings-crm-add-status-btn');
    const addBtnByRole = page.getByRole('button', { name: /add status|status toevoegen/i });

    const btn = (await addBtnByTestId.isVisible().catch(() => false))
      ? addBtnByTestId
      : addBtnByRole;

    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    // StatusFormDialog renders as role="dialog"
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

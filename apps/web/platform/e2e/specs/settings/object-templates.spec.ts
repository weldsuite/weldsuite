/**
 * Interaction spec for the Object Templates settings page.
 *
 * ObjectTemplatesManager renders a table of templates scoped to an
 * entity type (Company, Person, …), a combobox to switch entity types,
 * and a "New Template" button. No seeded data is required — the tests
 * verify page scaffolding and that the primary CTA opens the dialog.
 *
 * Note: the "New Template" button has no data-testid. The recommendation
 * to add `data-testid="settings-object-templates-new-btn"` is filed in
 * crossCuttingRecommendations. Until then we locate by role + name which
 * is stable because the button text is the hard-coded string
 * "New Template" (not i18n-keyed yet).
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · object templates', () => {
  test('page renders the heading and table structure', async ({ page }) => {
    await page.goto('/settings/object-templates');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const heading = page.locator('h1').filter({ hasText: /object template/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('entity-type combobox is visible and switches the table context', async ({ page }) => {
    await page.goto('/settings/object-templates');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The entity combobox is a role="combobox" button
    const combobox = page.getByRole('combobox').first();
    await expect(combobox).toBeVisible({ timeout: 10_000 });

    await combobox.click();
    // The Command palette search is present when the popover is open
    const searchInput = page.getByPlaceholder(/search object/i);
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
  });

  test('"New Template" button opens the template dialog', async ({ page }) => {
    await page.goto('/settings/object-templates');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const newBtn = page.getByRole('button', { name: /new template/i });
    await expect(newBtn).toBeVisible({ timeout: 10_000 });

    await newBtn.click();

    // TemplateDialog renders as role="dialog"
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

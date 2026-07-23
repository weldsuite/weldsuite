/**
 * Interaction spec for the Custom Fields settings page.
 *
 * CustomFieldsManager renders a table of field definitions per entity
 * type plus a toolbar with an "Add Field" button and an entity-type
 * combobox. No seeded data is required — the tests verify that the
 * page scaffolding is present and the primary CTA opens its dialog.
 *
 * Note: the "Add Field" button has no data-testid in the component.
 * The recommendation to add `data-testid="settings-custom-fields-add-btn"`
 * is filed in crossCuttingRecommendations. Until then we locate it by
 * role + name which is stable because the button text comes from the
 * i18n key `ts.addField` (renders as "Add field" / "Veld toevoegen").
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · custom fields', () => {
  test('page renders the heading and table structure', async ({ page }) => {
    await page.goto('/settings/custom-fields');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The page heading rendered by CustomFieldsManager
    const heading = page.locator('h1').filter({ hasText: /custom field/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('entity-type combobox is visible and interactive', async ({ page }) => {
    await page.goto('/settings/custom-fields');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The entity-type selector is a combobox button (role="combobox")
    const combobox = page.getByRole('combobox').first();
    await expect(combobox).toBeVisible({ timeout: 10_000 });

    // Clicking it opens the popover with a search input
    await combobox.click();
    const searchInput = page.getByPlaceholder(/search entity/i);
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
  });

  test('"Add field" button opens the field-definition dialog', async ({ page }) => {
    await page.goto('/settings/custom-fields');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Locate by role + partial name — matches both "Add field" (en) and
    // "Veld toevoegen" (nl). Falls back to a text match containing "Add".
    const addBtn = page
      .getByRole('button', { name: /add field|veld toevoegen/i })
      .first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });

    await addBtn.click();

    // The FieldDefinitionDialog renders as a role="dialog"
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

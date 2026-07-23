/**
 * General settings spec — verifies the workspace-name editor renders
 * with a stable id selector and the save button.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · general', () => {
  test('/settings/general renders the workspace name input', async ({ page }) => {
    await page.goto('/settings/general');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#workspace-name-input')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('typing into the workspace name input updates the field', async ({ page }) => {
    await page.goto('/settings/general');
    const input = page.locator('#workspace-name-input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    const original = (await input.inputValue()) || '';

    // Fill with the original + a marker. Doesn't save — we just
    // verify the field is editable.
    const probe = `${original} (E2E probe)`;
    await input.fill(probe);
    await expect(input).toHaveValue(probe);

    // Restore so subsequent tests aren't affected.
    await input.fill(original);
  });

  test('save button is present', async ({ page }) => {
    await page.goto('/settings/general');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // The save button is the first primary button after the input.
    const saveBtn = page.getByRole('button', { name: /save/i }).first();
    await expect(saveBtn).toBeVisible({ timeout: 10_000 });
  });
});

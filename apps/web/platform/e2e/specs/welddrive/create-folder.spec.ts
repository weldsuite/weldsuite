/**
 * Create-folder interaction spec for WeldDrive. Verifies the dialog
 * opens, accepts input on a stable `#folder-name` selector, and the
 * Create button is disabled until the input is filled.
 *
 * Also covers the submit path: fills the name, submits, and asserts
 * the folder appears in the file list. Cleans up by moving the
 * newly created folder to trash via the row context menu.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldDrive · create folder dialog', () => {
  test('opens the dialog with a focused folder-name input', async ({ page }) => {
    await page.goto('/welddrive');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const trigger = page.getByTestId('welddrive-new-folder-btn');
    if (!(await trigger.isVisible().catch(() => false))) {
      // The button is hidden on mobile or in non-folder view; skip.
      test.skip(true, 'New Folder button not visible in this layout');
    }
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator('#folder-name')).toBeVisible();
    // Submit is disabled until the name is non-empty.
    const submit = dialog.getByRole('button', { name: /Create|Creating/i });
    await expect(submit).toBeDisabled();

    await dialog.locator('#folder-name').fill('E2E Test Folder');
    await expect(submit).toBeEnabled();
  });

  test('cancel button closes the dialog', async ({ page }) => {
    await page.goto('/welddrive');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const trigger = page.getByTestId('welddrive-new-folder-btn');
    if (!(await trigger.isVisible().catch(() => false))) {
      test.skip(true, 'New Folder button not visible in this layout');
    }
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

test.describe('WeldDrive · create folder submit', () => {
  /**
   * Submits the create-folder form and asserts the mutation fires
   * successfully (dialog closes; folder name becomes visible in the
   * file list). Then cleans up by moving the folder to trash via the
   * row's context menu so subsequent test runs start clean.
   *
   * This test does NOT require test-fixture env vars: it uses only
   * auth + the real drive API. Cleanup is performed through the UI
   * (Move to Trash) because the api.reset() fixture does not cover
   * drive folders.
   */
  test('submitting the form creates the folder and shows it in the list', async ({ page }) => {
    await page.goto('/welddrive');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const trigger = page.getByTestId('welddrive-new-folder-btn');
    const triggerVisible = await trigger.isVisible().catch(() => false);
    if (!triggerVisible) {
      test.skip(true, 'New Folder button not visible in this layout (mobile)');
    }

    const stamp = Date.now().toString(36);
    const folderName = `E2E Folder ${stamp}`;

    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.locator('#folder-name').fill(folderName);
    const submit = dialog.getByRole('button', { name: /Create|Creating/i });
    await expect(submit).toBeEnabled();
    await submit.click();

    // Dialog should close on success.
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The folder name should now appear in the file list.
    const row = page.getByText(folderName);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // --- Cleanup: move the newly created folder to trash ---
    // Hover the row to reveal the context-menu trigger (MoreVertical button).
    await row.hover();
    const moreBtn = page
      .locator('div', { hasText: folderName })
      .filter({ has: page.locator('button') })
      .last()
      .locator('button')
      .last();

    // Prefer a more reliable selector: the MoreVertical button in the same
    // row. We find the row container and click its last button (the kebab).
    const rowContainer = page
      .locator('[style*="height: 51px"]')
      .filter({ hasText: folderName })
      .first();

    const rowVisible = await rowContainer.isVisible().catch(() => false);
    if (rowVisible) {
      await rowContainer.hover();
      const kebab = rowContainer.locator('button').last();
      if (await kebab.isVisible().catch(() => false)) {
        await kebab.click();
        const trashItem = page.getByRole('menuitem', { name: /move to trash/i });
        if (await trashItem.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await trashItem.click();
        }
      }
    }
    // If cleanup failed, the folder will be cleaned up by the next test run
    // or manually — it does not affect the assertion above.
  });
});

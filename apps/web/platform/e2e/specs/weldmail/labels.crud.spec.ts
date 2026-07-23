/**
 * CRUD spec for WeldMail mail labels via the settings/labels UI.
 *
 * Gate: `isTestFixturesConfigured()` — requires TEST_API_URL,
 * TEST_FIXTURES_TOKEN, and TEST_WORKSPACE_ID in .env.test, AND the
 * test-fixtures router must expose /seed/mailAccount and /seed/mailLabel
 * endpoints. Until those are wired in app-api the beforeAll skip keeps CI
 * green.
 *
 * Shape follows e2e/specs/weldcrm/companies-crud.spec.ts exactly.
 *
 * Cleanup deletes only the label this test created (NOT the global
 * `api.reset()` marker-wipe): with `fullyParallel` on, every spec shares a
 * single test workspace, and a sibling's global reset would otherwise delete
 * another spec's in-flight rows and flake it. Labels are created via the UI,
 * so each test captures the new id from the `POST /mail-labels` response and
 * deletes it scoped in afterEach.
 */

import { type Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

/**
 * Submit the create-label dialog and return the new label's id, captured
 * from the `POST /mail-labels` response so cleanup can be scoped.
 */
async function submitCreateAndCaptureId(
  page: Page,
  dialog: ReturnType<Page['getByRole']>,
): Promise<string | null> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith('/mail-labels') &&
        r.request().method() === 'POST' &&
        r.ok(),
    ),
    dialog.getByRole('button', { name: /^create$/i }).click(),
  ]);
  return ((await res.json()) as { data?: { id?: string } }).data?.id ?? null;
}

test.describe('WeldMail · Labels CRUD', () => {
  let createdLabelId: string | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (createdLabelId) {
      await api.deleteEntity('mailLabel', createdLabelId);
      createdLabelId = null;
    }
  });

  test('create label via dialog → label appears in the list', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const labelName = `CrudLabel${stamp}`;

    await page.goto('/weldmail/settings/labels');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Open create dialog
    const createBtn = page
      .getByTestId('labels-create-btn')
      .or(page.getByRole('button', { name: /create label/i }));
    await createBtn.first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill the label name input — id="label-name" is stable
    await dialog.locator('#label-name').fill(labelName);

    // Submit, capturing the new label id for scoped cleanup.
    createdLabelId = await submitCreateAndCaptureId(page, dialog);

    // Dialog should close on success
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The new label should appear in the list
    await expect(page.getByText(labelName)).toBeVisible({ timeout: 10_000 });
  });

  test('rename label via quick-rename → updated name visible', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const originalName = `RenameLabel${stamp}`;
    const updatedName = `Renamed${stamp}`;

    await page.goto('/weldmail/settings/labels');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Create the label first
    const createBtn = page
      .getByTestId('labels-create-btn')
      .or(page.getByRole('button', { name: /create label/i }));
    await createBtn.first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator('#label-name').fill(originalName);
    // Rename never changes the id, so capturing it here covers cleanup of the
    // renamed row too.
    createdLabelId = await submitCreateAndCaptureId(page, dialog);
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText(originalName)).toBeVisible({ timeout: 10_000 });

    // Click the quick-rename (Edit2) button for this label
    const renameBtn = page.getByTestId(`label-rename-btn-${originalName}`);
    await expect(renameBtn).toBeVisible({ timeout: 5_000 });
    await renameBtn.click();

    // Inline input should appear with the original name pre-filled.
    const inlineInput = page.locator('input[value="' + originalName + '"], input').first();
    await expect(inlineInput).toBeVisible({ timeout: 5_000 });
    await inlineInput.selectText();
    await inlineInput.fill(updatedName);
    await inlineInput.press('Enter');

    // Updated name should be visible
    await expect(page.getByText(updatedName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(originalName)).toBeHidden({ timeout: 5_000 });
  });

  test('delete label via Trash button + confirm dialog → label removed', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const labelName = `DeleteLabel${stamp}`;

    await page.goto('/weldmail/settings/labels');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Create the label first
    const createBtn = page
      .getByTestId('labels-create-btn')
      .or(page.getByRole('button', { name: /create label/i }));
    await createBtn.first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator('#label-name').fill(labelName);
    createdLabelId = await submitCreateAndCaptureId(page, dialog);
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText(labelName)).toBeVisible({ timeout: 10_000 });

    // Click the delete (Trash2) button
    const deleteBtn = page.getByTestId(`label-delete-btn-${labelName}`);
    await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
    await deleteBtn.click();

    // Confirm dialog (ConfirmDialog shared component)
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog.getByRole('button', { name: /delete/i }).click();

    // Label should be gone from the list
    await expect(page.getByText(labelName)).toBeHidden({ timeout: 10_000 });

    // The UI already deleted it — don't double-delete in afterEach.
    createdLabelId = null;
  });
});

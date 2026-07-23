/**
 * CRUD spec for WeldConnect Variables.
 *
 * Gate: skipped unless test-fixtures env vars are configured.
 *
 * Covers:
 *  - Opening the VariableDialog via data-testid='page-header-action-create-variable'
 *  - Filling name (#name), value (#value), leaving scope as global
 *  - Submitting and asserting the new variable row appears in the table
 *  - Deleting the variable row (via per-row action)
 *
 * Cleanup deletes only the variable this test created (NOT the global
 * `api.reset()` marker-wipe): with `fullyParallel` on, every spec shares a
 * single test workspace, and a sibling's global reset would otherwise delete
 * another spec's in-flight rows and flake it. There is no `api.seedVariable()`,
 * so each test creates via the UI and captures the new id from the
 * `POST /workflow-variables` response, then deletes it scoped in afterEach.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

test.describe('WeldConnect · Variables CRUD', () => {
  let createdVariableId: string | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (createdVariableId) {
      await api.deleteEntity('variable', createdVariableId);
      createdVariableId = null;
    }
  });

  // -------------------------------------------------------------------------
  // Create via VariableDialog
  // -------------------------------------------------------------------------

  test('create variable via dialog → row appears in the variables table', async ({
    page,
  }) => {
    const stamp = Date.now().toString(36);
    const varName = `E2E_VAR_${stamp}`.toUpperCase();
    const varValue = `value-${stamp}`;

    await page.goto('/weldconnect/variables');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Open the create dialog via the stable testId
    const createBtn = page.getByTestId('page-header-action-create-variable');
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill the name (font-mono input #name) and value (#value)
    await dialog.locator('#name').fill(varName);
    await dialog.locator('#value').fill(varValue);

    // Scope defaults to global — no interaction needed

    // Submit, capturing the new variable's id from the create response so
    // afterEach can delete just this row instead of wiping the workspace.
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/workflow-variables') &&
          r.request().method() === 'POST' &&
          r.ok(),
      ),
      dialog.getByRole('button', { name: /create/i }).last().click(),
    ]);
    createdVariableId =
      ((await createRes.json()) as { data?: { id?: string } }).data?.id ?? null;

    // Dialog should close after successful creation
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The new variable row should appear in the page
    await expect(
      page.getByText(varName, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Delete variable row
  // -------------------------------------------------------------------------

  test('delete variable row removes it from the table', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const varName = `E2E_DEL_${stamp}`.toUpperCase();

    await page.goto('/weldconnect/variables');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Create a variable first
    await page.getByTestId('page-header-action-create-variable').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.locator('#name').fill(varName);
    await dialog.locator('#value').fill('to-be-deleted');
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/workflow-variables') &&
          r.request().method() === 'POST' &&
          r.ok(),
      ),
      dialog.getByRole('button', { name: /create/i }).last().click(),
    ]);
    createdVariableId =
      ((await createRes.json()) as { data?: { id?: string } }).data?.id ?? null;
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // Wait for the row to appear
    const row = page.getByText(varName, { exact: false }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open the row action menu and click Delete
    const rowContainer = page
      .locator('tr, [data-testid="entity-grid-row"]')
      .filter({ hasText: varName });
    await rowContainer
      .getByRole('button', { name: /more|actions|delete/i })
      .last()
      .click();

    // If a delete confirm dialog appears, confirm it
    const confirmDialog = page.getByRole('dialog');
    const confirmVisible = await confirmDialog
      .isVisible()
      .catch(() => false);
    if (confirmVisible) {
      await confirmDialog.getByRole('button', { name: /delete/i }).click();
      await expect(confirmDialog).toBeHidden({ timeout: 10_000 });
    }

    // Row should be gone
    await expect(
      page.getByText(varName, { exact: false }),
    ).toBeHidden({ timeout: 10_000 });

    // The UI already deleted it — don't double-delete in afterEach.
    createdVariableId = null;
  });
});

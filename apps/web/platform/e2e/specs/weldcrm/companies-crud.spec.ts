import { test, expect } from '../../fixtures';
import { EntityGridPage } from '../../pages/entity-grid.page';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

/**
 * Golden-path CRUD for WeldCRM Companies via the UI. Same pattern as
 * `people-crud.spec.ts` — see that file for the rationale.
 *
 * Cleanup deletes only the row this test created (NOT the global
 * `api.reset()` marker-wipe): with `fullyParallel` on, every spec shares a
 * single test workspace, and a sibling's global reset would otherwise delete
 * another spec's in-flight rows and flake it.
 */

test.describe('WeldCRM · Companies CRUD', () => {
  let createdCompanyId: string | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (createdCompanyId) {
      await api.deleteEntity('company', createdCompanyId);
      createdCompanyId = null;
    }
  });

  test('create company via quick-add → row appears in grid', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const name = `AcmeCrud${stamp}`;

    await page.goto('/weldcrm/companies');
    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    await grid.createButton().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.locator('#name').fill(name);
    await dialog.locator('#email').fill(`hello+${stamp}@${name.toLowerCase()}.test`);
    await dialog.getByRole('button', { name: /save|create/i }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });

    const matchingRow = grid.rows().filter({ hasText: name }).first();
    await expect(matchingRow).toBeVisible({ timeout: 10_000 });

    // Capture the new row's id so afterEach can delete just this company
    // instead of wiping the shared workspace.
    createdCompanyId = await matchingRow.getAttribute('data-entity-id');
  });
});

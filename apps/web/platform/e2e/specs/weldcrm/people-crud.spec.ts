import { test, expect } from '../../fixtures';
import { EntityGridPage } from '../../pages/entity-grid.page';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

/**
 * Golden-path CRUD for WeldCRM People via the UI.
 *
 * The test creates a person through the quick-add dialog (no pre-seed),
 * confirms the row appears, then uses the test-fixtures endpoint to
 * tear down. The teardown is API-based instead of UI-based because the
 * delete flow varies per entity and isn't the focus of this spec.
 *
 * Skips when test-fixtures isn't configured (the teardown can't run
 * cleanly without it).
 *
 * Cleanup deletes only the row this test created (NOT the global
 * `api.reset()` marker-wipe): with `fullyParallel` on, every spec shares a
 * single test workspace, and a sibling's global reset would otherwise delete
 * another spec's in-flight rows and flake it.
 */

test.describe('WeldCRM · People CRUD', () => {
  let createdPersonId: string | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (createdPersonId) {
      await api.deleteEntity('person', createdPersonId);
      createdPersonId = null;
    }
  });

  test('create person via quick-add → row appears in grid', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const firstName = `Jane${stamp}`;
    const lastName = 'CrudTest';

    await page.goto('/weldcrm/people');
    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    await grid.createButton().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Stable id-based selectors come from the quick-add-person form.
    await dialog.locator('#firstName').fill(firstName);
    await dialog.locator('#lastName').fill(lastName);
    await dialog.locator('#email').fill(`${firstName.toLowerCase()}@e2e.test`);
    await dialog.getByRole('button', { name: /save|create/i }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The new row must appear in the list. We match on displayName via
    // the row's text content; rowById would be tighter but the service
    // generates the id and we don't capture it from the UI flow.
    const matchingRow = grid
      .rows()
      .filter({ hasText: `${firstName} ${lastName}` })
      .first();
    await expect(matchingRow).toBeVisible({ timeout: 10_000 });

    // Capture the new row's id so afterEach can delete just this person
    // instead of wiping the shared workspace.
    createdPersonId = await matchingRow.getAttribute('data-entity-id');
  });
});

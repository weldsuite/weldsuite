/**
 * CRUD spec for WeldFlow Projects.
 *
 * Covers the two mutations absent from all existing specs:
 *   1. Create a project via the "New Project" button + dialog.
 *   2. Delete a project via the row dropdown "Delete" item.
 *
 * Selector strategy (no data-testids on CTAs yet):
 *   - "New Project" button: getByRole('button', { name: /new project/i })
 *   - Name input: locator('#project-name') — htmlFor="project-name" in Dialog
 *   - "Create Project" submit: getByRole('button', { name: /create project/i })
 *   - Row dropdown trigger: within the row, getByRole('button') that wraps
 *     EllipsisVertical — forced visible via the row hover; we use force:true.
 *   - "Delete" menu item: getByRole('menuitem', { name: /^delete$/i })
 *
 * Cross-cutting recommendation (not applied here): add
 *   data-testid="new-project-btn"       to the createButton prop in AllProjectsClient
 *   data-testid="create-project-submit"  to the Create Project DialogFooter Button
 *   data-testid="project-row-{id}"       to the row div in renderRow
 * so future specs can use stable selectors.
 *
 * Cleanup is scoped to the row each test seeded or created (NOT the global
 * `api.reset()` marker-wipe) to avoid deleting sibling specs' rows under
 * `fullyParallel` execution.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · Project CRUD', () => {
  let seeded: { type: SeedEntityType; id: string } | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('create project via dialog → row appears in list', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const name = `E2ECrud${stamp}`;

    await page.goto('/weldflow/projects');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Intercept the POST /api/projects response to capture the new project id
    // so afterEach can delete only this row.
    const createResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/projects') && resp.request().method() === 'POST',
      { timeout: 10_000 },
    );

    // Open the Add New Project dialog.
    await page.getByRole('button', { name: /new project/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill the project name input.
    await dialog.locator('#project-name').fill(name);

    // Submit.
    await dialog.getByRole('button', { name: /create project/i }).click();

    // Dialog should close on success.
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // Capture created project id from the API response.
    const createResp = await createResponsePromise;
    const createBody = await createResp.json().catch(() => null);
    const createdId: string | undefined = createBody?.data?.id;
    if (createdId) {
      seeded = { type: 'project', id: createdId };
    }

    // The new project row should appear in the list.
    await expect(
      page.getByText(name, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('delete seeded project via row dropdown → row disappears', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const project = await api.seedProject({ name: `E2EDelete${stamp}` });
    // Track for cleanup in case the UI delete fails mid-test.
    seeded = { type: 'project', id: project.id };

    await page.goto('/weldflow/projects');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Wait for the project row to render.
    const projectName = page.getByText(project.name, { exact: false }).first();
    await expect(projectName).toBeVisible({ timeout: 10_000 });

    // Hover the row to reveal the ellipsis button, then open its dropdown.
    await projectName.hover();
    // The dropdown trigger is an EllipsisVertical button inside the same row.
    // We scope to the row area by finding the nearest ancestor row container.
    const rowContainer = page
      .locator('div.group')
      .filter({ hasText: project.name })
      .first();
    await rowContainer.hover();
    const trigger = rowContainer.getByRole('button').last();
    await trigger.click({ force: true });

    // Click the "Delete" menu item.
    await page.getByRole('menuitem', { name: /^delete$/i }).click();

    // The row should disappear from the list.
    await expect(projectName).toBeHidden({ timeout: 10_000 });

    // Project was deleted via UI; no api cleanup needed.
    seeded = null;
  });
});

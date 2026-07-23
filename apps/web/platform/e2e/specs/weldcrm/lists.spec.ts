/**
 * Seeded spec for WeldCRM Lists (Companies list page).
 *
 * Cleanup deletes only the row this test seeded (NOT the global
 * `api.reset()` marker-wipe): with `fullyParallel` on, every spec shares a
 * single test workspace, and a sibling's global reset would otherwise delete
 * this test's list mid-run and flake the assertion.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

test.describe('WeldCRM · Lists', () => {
  let seededListId: string | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seededListId) {
      await api.deleteEntity('list', seededListId);
      seededListId = null;
    }
  });

  test('seeded company list appears on /weldcrm/companies/lists', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const list = await api.seedList({
      name: `Co list ${stamp}`,
      kind: 'company',
    });
    seededListId = list.id;

    await page.goto('/weldcrm/companies/lists');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(list.name, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

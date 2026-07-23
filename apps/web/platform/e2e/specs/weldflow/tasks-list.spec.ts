/**
 * Seeded spec for WeldFlow My-Tasks list. Cleanup is scoped to the task
 * each test seeded (NOT the global `api.reset()` marker-wipe) to avoid
 * deleting sibling specs' rows under `fullyParallel` execution.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · My Tasks', () => {
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

  test('seeded task appears on /weldflow/my-tasks', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const task = await api.seedTask({ title: `Ship E2E ${stamp}` });
    seeded = { type: 'task', id: task.id };

    await page.goto('/weldflow/my-tasks');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Tasks may render on a board or list — assert the title shows
    // up somewhere on the page.
    await expect(
      page.getByText(task.title, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

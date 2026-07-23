/**
 * Seeded spec for WeldFlow Projects list. Cleanup is scoped to the project
 * each test seeded (NOT the global `api.reset()` marker-wipe) to avoid
 * deleting sibling specs' rows under `fullyParallel` execution.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · Projects', () => {
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

  test('seeded project appears on /weldflow/projects', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const project = await api.seedProject({ name: `E2E Project ${stamp}` });
    seeded = { type: 'project', id: project.id };

    await page.goto('/weldflow/projects');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(project.name, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * Smoke coverage for all per-project dynamic routes.
 *
 * Seeds a single project via the test-fixtures API, then visits every
 * sub-view under /weldflow/project/:id/** and asserts the app shell and
 * URL are correct. This fills the largest gap in the module — all 28
 * project-level routes were previously untested.
 *
 * Notes:
 * - analytics/$id and whiteboard/$whiteboardId require a seeded nested
 *   entity; those are not covered here (too narrow to gate on).
 * - documents/$fileId and table/$fileId likewise require an uploaded
 *   file; omitted for the same reason.
 * - members/$memberId requires a member row with a known id; omitted.
 *
 * Cleanup is scoped to the project each test seeded (NOT the global
 * `api.reset()` marker-wipe) to avoid deleting sibling specs' rows under
 * `fullyParallel` execution.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · project sub-views (seeded)', () => {
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

  const subViews = [
    'tasks',
    'list',
    'pipeline',
    'gantt',
    'timeline',
    'calendar',
    'workload',
    'members',
    'messages',
    'goals',
    'documents',
    'files',
    'table',
    'whiteboard',
    'analytics',
    'analytics/builder',
    'timesheet',
    'settings',
  ];

  for (const sub of subViews) {
    test(`/weldflow/project/:id/${sub} loads`, async ({ page, api }) => {
      const stamp = Date.now().toString(36);
      const project = await api.seedProject({ name: `E2E Views ${stamp}` });
      seeded = { type: 'project', id: project.id };

      await page.goto(`/weldflow/project/${project.id}/${sub}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(
        new RegExp(`/weldflow/project/${project.id}/${sub.replace('/', '/')}`),
        { timeout: 10_000 },
      );
    });
  }
});

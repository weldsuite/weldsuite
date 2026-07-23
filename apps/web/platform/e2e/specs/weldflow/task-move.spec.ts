/**
 * WeldFlow · Move task to another project (end-to-end).
 *
 * Exercises the full, real path for the `weldflow-move-task` feature:
 *   seed project A + project B + a task in A  →  open the task row's ⋮ menu
 *   →  "Move to project"  →  pick project B  →  confirm  →  assert the task
 *   left A and now lives in B (re-navigation re-fetches from the backend, so
 *   this proves real persistence, not just optimistic UI).
 *
 * Flag gating — IMPORTANT
 *   The feature is gated by the `weldflow-move-task` Flagship flag in BOTH the
 *   UI (the menu item) and the server (`POST /api/tasks/:id/move` returns 403
 *   when the flag is off). Rather than depend on Flagship config, this spec
 *   forces the flag on via the test-only `X-Test-Flags` header seam in
 *   `featureFlagsMiddleware` (gated by the same env + `X-Test-Token` guard as
 *   the `_test-fixtures` routes). A `page.route` handler stamps that header
 *   onto every app-api call, so both the UI and the server gate see the flag
 *   ON — no Flagship dependency, no skip.
 *
 * Selector strategy (no data-testids on task rows yet — mirrors
 * project-crud.spec.ts): the row is a `div.group`; hover reveals the ⋮ button
 * (the last button in the row); the menu + dialog use Radix roles.
 *
 * Cleanup is scoped to the rows each test seeded (NOT the global
 * `api.reset()` marker-wipe) to avoid deleting sibling specs' rows under
 * `fullyParallel` execution.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · move task to project', () => {
  let seeded: { type: SeedEntityType; id: string }[] = [];

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    for (const s of seeded) {
      await api.deleteEntity(s.type, s.id);
    }
    seeded = [];
  });

  test('moves a task from one project to another via the row menu', async ({ page, api }) => {
    const stamp = Date.now().toString(36);

    // ── Force the weldflow-move-task flag ON for this run ─────────────────
    // Stamp the test-only `X-Test-Flags` + `X-Test-Token` headers onto every
    // app-api call (createClientApi prefixes `/api`, so `**/api/**` matches
    // the feature-flags read and the move POST). featureFlagsMiddleware honours
    // these only in non-production with the valid test token, turning the flag
    // on for both the UI menu and the server gate. The Authorization bearer is
    // preserved by spreading the original headers.
    const testToken = process.env.TEST_FIXTURES_TOKEN ?? '';
    await page.route('**/api/**', (route) =>
      route.continue({
        headers: {
          ...route.request().headers(),
          'x-test-token': testToken,
          'x-test-flags': 'weldflow-move-task',
        },
      }),
    );

    // ── Seed: two projects + a task placed in the source project ──────────
    const source = await api.seedProject({ name: `MoveSrc ${stamp}` });
    seeded.push({ type: 'project', id: source.id });
    const dest = await api.seedProject({ name: `MoveDst ${stamp}` });
    seeded.push({ type: 'project', id: dest.id });
    const task = await api.seedTask({ title: `MoveMe ${stamp}`, projectId: source.id });
    seeded.push({ type: 'task', id: task.id });

    // ── Navigate to the source project's task list ────────────────────────
    await page.goto(`/weldflow/project/${source.id}/tasks`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const taskText = page.getByText(task.title, { exact: false }).first();
    await expect(taskText).toBeVisible({ timeout: 10_000 });

    // ── Open the row's ⋮ menu ─────────────────────────────────────────────
    const row = page.locator('div.group').filter({ hasText: task.title }).first();
    await row.hover();
    await row.getByRole('button').last().click({ force: true });

    // ── The flag is forced on, so the menu item must be present ───────────
    const moveItem = page.getByRole('menuitem', { name: /move to project/i });
    await expect(moveItem).toBeVisible({ timeout: 5_000 });

    // ── Pick the destination project and confirm ──────────────────────────
    await moveItem.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.getByPlaceholder(/search projects/i).fill(dest.name);
    await dialog.getByText(dest.name, { exact: false }).first().click();

    await dialog.getByRole('button', { name: /^move task$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // ── Assert: gone from the source project ──────────────────────────────
    await page.goto(`/weldflow/project/${source.id}/tasks`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Wait for the list to actually render before asserting absence, so an
    // unrendered list can't masquerade as "task removed".
    await expect(
      page.getByRole('button', { name: /add task|new task/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(task.title, { exact: false })).toHaveCount(0);

    // ── Assert: now present in the destination project ────────────────────
    await page.goto(`/weldflow/project/${dest.id}/tasks`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(task.title, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

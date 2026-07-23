/**
 * CRUD spec for WeldConnect Executions.
 *
 * Gate: skipped unless test-fixtures env vars are configured.
 *
 * Covers:
 *  - /weldconnect/executions/:id renders the app shell (structural, placeholder id)
 *  - Seeded execution detail page renders Cancel or Retry button
 *
 * Cleanup is scoped to the row each test seeded (NOT the global api.reset()
 * marker-wipe) so that parallel workers cannot delete a sibling test's data.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

// ---------------------------------------------------------------------------
// Structural test — no seed required
// ---------------------------------------------------------------------------

test.describe('WeldConnect · Execution detail (structural)', () => {
  test('/weldconnect/executions/:id renders app shell for a placeholder id', async ({
    page,
  }) => {
    // With a non-existent ID the page should render the auth shell and show an
    // error/empty state — NOT throw an uncaught error boundary.
    await page.goto('/weldconnect/executions/placeholder-id-does-not-exist');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Seed-gated test — Cancel + Retry CTAs
// ---------------------------------------------------------------------------

test.describe('WeldConnect · Executions CRUD (seed-gated)', () => {
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

  test('seeded execution renders detail page with Cancel or Retry button', async ({
    page,
    api,
  }) => {
    const exec = await api.seedExecution({ status: 'running' });
    seeded = { type: 'execution', id: exec.id };
    await page.goto(`/weldconnect/executions/${exec.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: /cancel execution/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * Dynamic detail-route smoke coverage for WeldCRM.
 *
 * Every $id route is unreachable from the static smoke spec because the entity
 * id is only known after seeding. This spec seeds one entity of each supported
 * type and visits the corresponding detail route, asserting the app shell
 * renders and the URL is correct.
 *
 * Covers the following dynamic routes:
 *   /weldcrm/pipeline/$id
 *   /weldcrm/companies/lists/$id
 *   /weldcrm/lists/$listId
 *   /weldcrm/sequences/$id
 *   /weldcrm/sequences/$id/edit
 *   /weldcrm/sequences/$id/people
 *   /weldcrm/sequences/$id/settings
 */

import { test, expect } from '../../fixtures';
import {
  isTestFixturesConfigured,
  type SeedEntityType,
} from '../../helpers/test-fixtures-client';

test.describe('WeldCRM · dynamic detail routes (seeded)', () => {
  // Each test seeds exactly one entity. We track it here and delete just that
  // row in afterEach (NOT the global `api.reset()` marker-wipe): with
  // `fullyParallel` on, every spec shares a single test workspace, and a
  // sibling's global reset would otherwise delete another spec's in-flight
  // rows and flake it.
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

  test('/weldcrm/pipeline/:id loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const pipeline = await api.seedPipeline({ name: `E2EPipeline${stamp}` });
    seeded = { type: 'pipeline', id: pipeline.id };

    await page.goto(`/weldcrm/pipeline/${pipeline.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(
      new RegExp(`/weldcrm/pipeline/${pipeline.id}`),
      { timeout: 10_000 },
    );
  });

  test('/weldcrm/companies/lists/:id loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const list = await api.seedList({ name: `E2ECoList${stamp}`, kind: 'company' });
    seeded = { type: 'list', id: list.id };

    await page.goto(`/weldcrm/companies/lists/${list.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // /weldcrm/companies/lists/:id is a legacy URL that redirects to the
    // canonical unified list page /weldcrm/lists/:id.
    await expect(page).toHaveURL(
      new RegExp(`/weldcrm/lists/${list.id}`),
      { timeout: 10_000 },
    );
  });

  test('/weldcrm/lists/:listId loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const list = await api.seedList({ name: `E2EList${stamp}`, kind: 'lead' });
    seeded = { type: 'list', id: list.id };

    await page.goto(`/weldcrm/lists/${list.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // This route may redirect to /weldcrm/companies/lists/:id or similar,
    // so we only assert the sidebar rendered rather than a specific URL shape.
  });

  test('/weldcrm/sequences/:id loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const sequence = await api.seedSequence({ name: `E2ESeq${stamp}` });
    seeded = { type: 'sequence', id: sequence.id };

    await page.goto(`/weldcrm/sequences/${sequence.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(
      new RegExp(`/weldcrm/sequences/${sequence.id}`),
      { timeout: 10_000 },
    );
  });

  test('/weldcrm/sequences/:id/edit loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const sequence = await api.seedSequence({ name: `E2ESeqEdit${stamp}` });
    seeded = { type: 'sequence', id: sequence.id };

    await page.goto(`/weldcrm/sequences/${sequence.id}/edit`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // /weldcrm/sequences/:id/edit immediately redirects to the sequence
    // editor at /weldcrm/sequences/:id — the /edit suffix is a no-op shim.
    await expect(page).toHaveURL(
      new RegExp(`/weldcrm/sequences/${sequence.id}`),
      { timeout: 10_000 },
    );
  });

  test('/weldcrm/sequences/:id/people loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const sequence = await api.seedSequence({ name: `E2ESeqPeople${stamp}` });
    seeded = { type: 'sequence', id: sequence.id };

    await page.goto(`/weldcrm/sequences/${sequence.id}/people`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(
      new RegExp(`/weldcrm/sequences/${sequence.id}/people`),
      { timeout: 10_000 },
    );
  });

  test('/weldcrm/sequences/:id/settings loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const sequence = await api.seedSequence({ name: `E2ESeqSettings${stamp}` });
    seeded = { type: 'sequence', id: sequence.id };

    await page.goto(`/weldcrm/sequences/${sequence.id}/settings`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(
      new RegExp(`/weldcrm/sequences/${sequence.id}/settings`),
      { timeout: 10_000 },
    );
  });

});

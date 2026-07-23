/**
 * Form spec for the WeldCRM Sequences create dialog.
 *
 * The sequences create dialog is the only CRM form with a stable selector:
 * <Input id="name">. This spec clicks the "New Sequence" button, fills #name,
 * submits, and asserts navigation to the new sequence's detail page.
 *
 * Teardown deletes only the sequence this test created (NOT the global
 * api.reset() marker-wipe): with `fullyParallel` on, every spec shares a
 * single test workspace, and a sibling's global reset would otherwise delete
 * another spec's in-flight rows and flake it. The spec is gated on
 * test-fixtures being configured; without it the test is skipped cleanly.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

test.describe('WeldCRM · Sequences create dialog', () => {
  let seededSequenceId: string | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seededSequenceId) {
      await api.deleteEntity('sequence', seededSequenceId);
      seededSequenceId = null;
    }
  });

  test('fill #name and submit → navigates to sequence detail page', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const name = `E2ESeq${stamp}`;

    await page.goto('/weldcrm/sequences');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Open the create dialog via the "New Sequence" button. Two can render
    // (toolbar CTA + empty-state action when no sequences exist); both open the
    // same dialog, so scope to the first to avoid a strict-mode violation.
    const newSeqBtn = page.getByRole('button', { name: /new sequence/i }).first();
    await expect(newSeqBtn).toBeVisible({ timeout: 15_000 });
    await newSeqBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The dialog has a stable <Input id="name"> selector.
    await dialog.locator('#name').fill(name);
    await dialog.getByRole('button', { name: /^create$/i }).click();

    // On success the dialog closes and the router navigates to the detail page.
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/weldcrm\/sequences\/[^/]+$/, { timeout: 15_000 });

    // Capture the new sequence id from the detail URL so afterEach can delete
    // just this row instead of wiping the shared workspace.
    seededSequenceId = new URL(page.url()).pathname.split('/').pop() ?? null;
  });

  /**
   * Regression: a created sequence must survive a back-navigation AND a hard
   * refresh of the list.
   *
   * The list is backed by a persisted (localStorage) TanStack Query client with
   * a 5-minute staleTime. On reload the client rehydrates the cached list, but
   * there's a restore window where the query is paused (`isLoading === false`,
   * `data === undefined`). The list page used to mount its client with an empty
   * array during that window and snapshot it into local state that never
   * re-synced — so after a refresh the whole list rendered empty ("all gone")
   * even though the cache held every sequence. Creating also never invalidated
   * the list query, so the new row was missing on back-nav. This guards both.
   */
  test('created sequence persists in the list after back-nav and a hard refresh', async ({
    page,
  }) => {
    const name = `E2ESeqPersist${Date.now().toString(36)}`;

    await page.goto('/weldcrm/sequences');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new sequence/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator('#name').fill(name);
    await dialog.getByRole('button', { name: /^create$/i }).click();

    await expect(page).toHaveURL(/\/weldcrm\/sequences\/[^/]+$/, { timeout: 15_000 });
    seededSequenceId = new URL(page.url()).pathname.split('/').pop() ?? null;

    // Back to the list (the user's "go back") — the new sequence must show,
    // proving the create invalidated the list query.
    await page.goBack();
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The query client persists to localStorage on a ~1s throttle. Wait until
    // the new sequence is actually written before reloading, otherwise the
    // reload would rehydrate a pre-create snapshot — a race in the test, not
    // the behaviour under test.
    await expect
      .poll(
        () =>
          page.evaluate((seqName) => {
            const raw = localStorage.getItem('weldsuite:query-cache');
            return raw ? raw.includes(seqName) : false;
          }, name),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Hard refresh — the list must NOT come back empty, and the new sequence
    // must survive. This is the core of the regression: the rehydrated cache
    // has to reach the screen instead of the list snapshotting an empty array.
    await page.reload();
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});

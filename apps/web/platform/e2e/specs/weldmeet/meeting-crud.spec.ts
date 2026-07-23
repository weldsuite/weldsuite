/**
 * CRUD spec for WeldMeet Meetings.
 *
 * Lifecycle under test:
 *  1. Seed a scheduled Meeting via the test-fixtures API.
 *  2. /weldmeet/upcoming — verify the row renders.
 *  3. Open the kebab menu → Rename → submit new title.
 *  4. Open the kebab menu → Cancel meeting → confirm in AlertDialog.
 *  5. /weldmeet/history — find the cancelled meeting → Delete via row action.
 *
 * Selectors: role/text only — no data-testid attributes exist on these
 * controls. The row kebab button (EllipsisVertical icon) becomes visible
 * on hover; Playwright's hover() triggers the CSS group-hover state.
 *
 * Cleanup uses scoped per-entity deleteEntity() calls instead of global reset().
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

const MEETING_TITLE_PREFIX = 'E2E-Meeting-';

test.describe('WeldMeet · Meeting CRUD', () => {
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

  test('seeded scheduled meeting row is visible on /weldmeet/upcoming', async ({
    page,
    api,
  }) => {
    const stamp = Date.now().toString(36);
    const title = `${MEETING_TITLE_PREFIX}${stamp}`;

    const mtg = await api.seedMeeting({
      title,
      scheduledStart: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    seeded = { type: 'meeting', id: mtg.id };

    await page.goto('/weldmeet/upcoming');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
  });

  test('rename a scheduled meeting via the row kebab menu', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const originalTitle = `${MEETING_TITLE_PREFIX}${stamp}`;
    const renamedTitle = `${originalTitle}-renamed`;

    const mtg = await api.seedMeeting({
      title: originalTitle,
      scheduledStart: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    seeded = { type: 'meeting', id: mtg.id };

    await page.goto('/weldmeet/upcoming');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: originalTitle }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Hover the row to reveal the kebab button (group-hover CSS).
    await row.hover();
    const kebab = row.getByRole('button').last();
    await kebab.click();

    await page.getByRole('menuitem', { name: /rename/i }).click();

    // Rename Dialog — the Input has no id; it is the sole <input> in the dialog.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const input = dialog.getByRole('textbox');
    await input.clear();
    await input.fill(renamedTitle);
    await dialog.getByRole('button', { name: /save/i }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(
      page.locator('[class*="cursor-pointer"]').filter({ hasText: renamedTitle }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('cancel a scheduled meeting via the row kebab menu', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const title = `${MEETING_TITLE_PREFIX}${stamp}`;

    const mtg = await api.seedMeeting({
      title,
      scheduledStart: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    seeded = { type: 'meeting', id: mtg.id };

    await page.goto('/weldmeet/upcoming');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.hover();
    const kebab = row.getByRole('button').last();
    await kebab.click();

    await page.getByRole('menuitem', { name: /cancel meeting/i }).click();

    // CancelMeetingDialog renders as an AlertDialog.
    const alertDialog = page.getByRole('alertdialog');
    await expect(alertDialog).toBeVisible({ timeout: 5_000 });

    // Uncheck the notification checkbox before confirming.
    const checkbox = alertDialog.getByRole('checkbox');
    if (await checkbox.isChecked()) {
      await checkbox.uncheck();
    }

    await alertDialog.getByRole('button', { name: /^cancel meeting$/i }).click();
    await expect(alertDialog).toBeHidden({ timeout: 10_000 });
  });

  test('delete a cancelled meeting from /weldmeet/history', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const title = `${MEETING_TITLE_PREFIX}${stamp}`;

    // Seed as already-cancelled so it appears in history immediately.
    const mtg = await api.seedMeeting({
      title,
      status: 'cancelled',
      scheduledStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    seeded = { type: 'meeting', id: mtg.id };

    await page.goto('/weldmeet/history');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.hover();
    const kebab = row.getByRole('button').last();
    await kebab.click();

    await page.getByRole('menuitem', { name: /delete meeting/i }).click();

    // Row should disappear after deletion (optimistic removal via mutate).
    // The seeded row is already gone — clear the tracker so afterEach skips.
    seeded = null;
    await expect(row).toBeHidden({ timeout: 10_000 });
  });
});

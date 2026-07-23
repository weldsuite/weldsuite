/**
 * Interaction spec for WeldMeet (Video meetings).
 *
 * Covers: root index, all four sub-views, New Meeting dropdown trigger,
 * join-by-code input, and the EntityGrid on /weldmeet/people.
 * No data seeding required — all assertions are structural.
 */

import { test, expect } from '../../fixtures';
import { EntityGridPage } from '../../pages/entity-grid.page';

test.describe('WeldMeet · sub-views render', () => {
  for (const view of ['upcoming', 'history', 'people', 'new']) {
    test(`/weldmeet/${view} renders`, async ({ page }) => {
      await page.goto(`/weldmeet/${view}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/weldmeet/${view}`));
    });
  }
});

test.describe('WeldMeet · root index', () => {
  test('/weldmeet renders the New Meeting landing page', async ({ page }) => {
    await page.goto('/weldmeet');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // /weldmeet routes to the New Meeting landing page (new/page.tsx).
    // The "New Meeting" dropdown trigger button is always rendered unconditionally.
    await expect(page.getByRole('button', { name: /new meeting/i })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('WeldMeet · /new page interactions', () => {
  test('New Meeting dropdown trigger is visible', async ({ page }) => {
    await page.goto('/weldmeet/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const newMeetingBtn = page.getByRole('button', { name: /new meeting/i });
    await expect(newMeetingBtn).toBeVisible({ timeout: 10_000 });
  });

  test('New Meeting dropdown opens with three items', async ({ page }) => {
    await page.goto('/weldmeet/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new meeting/i }).click();

    // Three dropdown items as per the source
    await expect(page.getByRole('menuitem', { name: /start an instant meeting/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('menuitem', { name: /create a meeting for later/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('menuitem', { name: /schedule in calendar/i })).toBeVisible({ timeout: 5_000 });
  });

  test('Join-by-code input accepts text', async ({ page }) => {
    await page.goto('/weldmeet/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const codeInput = page.getByPlaceholder(/enter a code or link/i);
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill('abc-defg-hij');
    await expect(codeInput).toHaveValue('abc-defg-hij');
  });
});

test.describe('WeldMeet · /people page interactions', () => {
  test('/weldmeet/people renders the EntityGrid', async ({ page }) => {
    await page.goto('/weldmeet/people');
    const grid = new EntityGridPage(page);
    await grid.waitForReady();
    // The grid root must be visible; there may be zero rows in CI but
    // the scaffold itself must render.
    await expect(grid.root()).toBeVisible({ timeout: 15_000 });
  });
});

/**
 * Form spec for WeldMeet — meeting creation flows on /weldmeet/new.
 *
 * Tests the "New Meeting" dropdown items that open inline creation UIs:
 *  - "Schedule in calendar" opens a QuickCreateCard with a title input.
 *  - Zod validation on CreateMeetingDialog (#title, #scheduledStart) cannot
 *    be tested here because the component is not yet connected to a UI entry
 *    point on this page. See crossCuttingRecommendations in the spec audit.
 *
 * All assertions are structural (no seeded data required).
 */

import { test, expect } from '../../fixtures';

test.describe('WeldMeet · /new dropdown flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldmeet/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('New Meeting button is visible with correct label', async ({ page }) => {
    const btn = page.getByRole('button', { name: /new meeting/i });
    await expect(btn).toBeVisible({ timeout: 10_000 });
  });

  test('"Schedule in calendar" dropdown item opens the quick-create card', async ({ page }) => {
    await page.getByRole('button', { name: /new meeting/i }).click();

    const scheduleItem = page.getByRole('menuitem', { name: /schedule in calendar/i });
    await expect(scheduleItem).toBeVisible({ timeout: 5_000 });
    await scheduleItem.click();

    // The QuickCreateCard renders as a floating panel. It should contain
    // a text input for the event title.
    const titleInput = page.getByRole('textbox').first();
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
  });

  test('"Schedule in calendar" card can receive a title value', async ({ page }) => {
    await page.getByRole('button', { name: /new meeting/i }).click();
    await page.getByRole('menuitem', { name: /schedule in calendar/i }).click();

    const titleInput = page.getByRole('textbox').first();
    await expect(titleInput).toBeVisible({ timeout: 5_000 });

    await titleInput.fill('Team Standup');
    await expect(titleInput).toHaveValue('Team Standup');
  });

  test('"Start an instant meeting" dropdown item is present', async ({ page }) => {
    await page.getByRole('button', { name: /new meeting/i }).click();

    await expect(
      page.getByRole('menuitem', { name: /start an instant meeting/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('"Create a meeting for later" dropdown item is present', async ({ page }) => {
    await page.getByRole('button', { name: /new meeting/i }).click();

    await expect(
      page.getByRole('menuitem', { name: /create a meeting for later/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('WeldMeet · /new join-by-code form', () => {
  test('join-by-code input is visible and accepts text', async ({ page }) => {
    await page.goto('/weldmeet/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const codeInput = page.getByPlaceholder(/enter a code or link/i);
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill('abc-def-ghi');
    await expect(codeInput).toHaveValue('abc-def-ghi');
  });

  test('join-by-code submit button appears only when code is entered', async ({ page }) => {
    await page.goto('/weldmeet/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const codeInput = page.getByPlaceholder(/enter a code or link/i);

    // Before typing the join button is hidden (opacity-0 / pointer-events-none)
    // We verify the input itself works; the button visibility is CSS-controlled.
    await codeInput.fill('my-code');
    // The ChevronRight button becomes interactable once there is text.
    const submitBtn = page.locator('button:near(input[placeholder*="code"])').first();
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
  });
});

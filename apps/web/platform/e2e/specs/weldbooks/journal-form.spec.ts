/**
 * Form spec for /weldbooks/journal/add.
 *
 * This page uses plain React state (not react-hook-form). The submit
 * button is disabled while debits !== credits.
 *
 * Tests verify:
 *   1. The page renders the journal entry form.
 *   2. The Submit button is disabled while the lines are unbalanced.
 *   3. Entering matching debit and credit values enables the button.
 *   4. The Add Line button appends a new table row.
 *   5. Cancelling navigates back to the journal list.
 *
 * Selectors: The date input is `input[type="date"]`. Debit/credit inputs
 * are `input[type="number"]` inside the table rows — they're selected
 * by their position within the <tbody> rows.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldBooks · journal entry form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldbooks/journal/add');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Wait for the date input to confirm the journal form has rendered.
    // (The date input is the first direct form element and is always present
    // on this page regardless of i18n loading order.)
    await expect(page.locator('input[type="date"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders the date input and journal lines table', async ({ page }) => {
    await expect(page.locator('input[type="date"]').first()).toBeVisible();
    // The table header should have "Debit" and "Credit" columns.
    await expect(page.getByRole('columnheader', { name: /debit/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /credit/i })).toBeVisible();
  });

  test('submit button is disabled while lines are unbalanced', async ({ page }) => {
    const submitBtn = page.getByRole('button', { name: /create entry/i });
    await expect(submitBtn).toBeVisible({ timeout: 10_000 });

    // By default two empty lines exist — total debit 0, total credit 0.
    // The balanced check passes (0 === 0) so the button is enabled initially
    // but disabled once we add a debit without a matching credit.
    const rows = page.locator('tbody tr').filter({ has: page.locator('input[type="number"]') });
    const firstRowDebitInput = rows.first().locator('input[type="number"]').nth(0);
    await firstRowDebitInput.fill('100');

    // Now debit (100) !== credit (0) — button must be disabled.
    await expect(submitBtn).toBeDisabled({ timeout: 5_000 });
  });

  test('submit button is enabled when debit equals credit', async ({ page }) => {
    const submitBtn = page.getByRole('button', { name: /create entry/i });

    const rows = page.locator('tbody tr').filter({ has: page.locator('input[type="number"]') });

    // Fill row 1: debit = 100
    const row1 = rows.nth(0);
    await row1.locator('input[type="number"]').nth(0).fill('100');

    // Fill row 2: credit = 100
    const row2 = rows.nth(1);
    await row2.locator('input[type="number"]').nth(1).fill('100');

    // Now 100 === 100 — button must be enabled.
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
  });

  test('Add Line button appends a new table row', async ({ page }) => {
    const rows = page.locator('tbody tr').filter({ has: page.locator('input[type="number"]') });
    const initialCount = await rows.count();

    await page.getByRole('button', { name: /add line/i }).click();

    await expect(rows).toHaveCount(initialCount + 1, { timeout: 5_000 });
  });

  test('cancel button navigates back to the journal list', async ({ page }) => {
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page).toHaveURL(/\/weldbooks\/journal/, { timeout: 10_000 });
  });
});

/**
 * Form spec for /weldbooks/accounts/add.
 *
 * Inputs with stable `id` attributes: #code, #name, #description,
 * #type (SelectTrigger), #subtype (SelectTrigger), #normalSide
 * (SelectTrigger), #currency, #openingBalance.
 *
 * Tests verify:
 *   1. All fields render.
 *   2. Empty code + name produce inline validation errors on submit.
 *   3. Changing type to "asset"/"expense" auto-sets normalSide to "debit".
 *   4. Changing type to "liability"/"equity"/"revenue" auto-sets to "credit".
 *   5. cancel navigates back to /weldbooks/accounts.
 *
 * BLOCKED: AccountingLayoutClient short-circuits to EntityEmptyState when no
 * accounting entity (legal entity) exists for the workspace. These tests
 * require a pre-seeded entity, but the test-fixtures client has no
 * `seedAccountingEntity` method and the corresponding
 * `/test-fixtures/seed/accounting-entity` endpoint does not exist in app-api.
 * Add that seed endpoint + client method, then remove the fixme and add a
 * `beforeAll` that seeds the entity.
 */

import { test, expect } from '../../fixtures';

test.describe.fixme('WeldBooks · account add form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldbooks/accounts/add');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#code')).toBeVisible({ timeout: 10_000 });
  });

  test('renders all key input fields', async ({ page }) => {
    await expect(page.locator('#code')).toBeVisible();
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('#description')).toBeVisible();
    await expect(page.locator('#type')).toBeVisible();
    await expect(page.locator('#normalSide')).toBeVisible();
    await expect(page.locator('#currency')).toBeVisible();
    await expect(page.locator('#openingBalance')).toBeVisible();
  });

  test('type defaults to "asset" and normalSide defaults to "debit"', async ({ page }) => {
    await expect(page.locator('#type')).toContainText(/asset/i);
    await expect(page.locator('#normalSide')).toContainText(/debit/i);
  });

  test('currency defaults to EUR', async ({ page }) => {
    await expect(page.locator('#currency')).toHaveValue('EUR');
  });

  test('submitting with empty code shows a validation error', async ({ page }) => {
    await page.locator('#code').fill('');
    await page.locator('#name').fill('Test Account');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.getByText(/code is required/i)).toBeVisible({ timeout: 5_000 });
  });

  test('submitting with empty name shows a validation error', async ({ page }) => {
    await page.locator('#code').fill('1000');
    await page.locator('#name').fill('');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.getByText(/name is required/i)).toBeVisible({ timeout: 5_000 });
  });

  test('changing type to "liability" auto-sets normalSide to "credit"', async ({ page }) => {
    // Open the type select and choose "liability"
    await page.locator('#type').click();
    await page.getByRole('option', { name: /liability/i }).click();

    // normalSide should now show "credit"
    await expect(page.locator('#normalSide')).toContainText(/credit/i, { timeout: 5_000 });
  });

  test('changing type to "expense" auto-sets normalSide to "debit"', async ({ page }) => {
    // First switch to liability so we know the initial state is credit
    await page.locator('#type').click();
    await page.getByRole('option', { name: /liability/i }).click();
    await expect(page.locator('#normalSide')).toContainText(/credit/i, { timeout: 5_000 });

    // Now switch to expense — should flip back to debit
    await page.locator('#type').click();
    await page.getByRole('option', { name: /expense/i }).click();
    await expect(page.locator('#normalSide')).toContainText(/debit/i, { timeout: 5_000 });
  });

  test('changing type to "revenue" auto-sets normalSide to "credit"', async ({ page }) => {
    await page.locator('#type').click();
    await page.getByRole('option', { name: /revenue/i }).click();
    await expect(page.locator('#normalSide')).toContainText(/credit/i, { timeout: 5_000 });
  });

  test('cancel button navigates back to the accounts list', async ({ page }) => {
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page).toHaveURL(/\/weldbooks\/accounts/, { timeout: 10_000 });
  });
});

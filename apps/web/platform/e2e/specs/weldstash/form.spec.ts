/**
 * Form-validation spec for WeldStash dialog forms.
 *
 * These tests verify that submitting required fields empty surfaces the
 * correct inline error messages from react-hook-form + Zod. No pre-seeded
 * data is required — every assertion is purely structural.
 *
 * Selector strategy (no data-testid on dialog triggers):
 *   getByRole('button', { name: /…/i }) — matches the visible button text
 *   rendered by DialogTrigger asChild inside each page header.
 *
 * NOTE: Adding data-testid attributes to the DialogTrigger buttons and
 * form Submit buttons across all four WeldStash page components would make
 * these selectors unconditionally stable. See crossCuttingRecommendations
 * in the coverage report.
 */

import { test, expect } from '../../fixtures';

// ---------------------------------------------------------------------------
// Products — "New product" dialog validation
// ---------------------------------------------------------------------------

test.describe('WeldStash · products form validation', () => {
  test('submitting empty "New product" form shows name required error', async ({ page }) => {
    await page.goto('/weldstash/products');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new product/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Clear the name field to ensure it is empty, then submit.
    await dialog.locator('#name').clear();
    await dialog.getByRole('button', { name: /create/i }).click();

    // The Zod schema marks `name` as required — the error paragraph appears
    // below the input with class text-destructive.
    await expect(
      dialog.locator('p.text-destructive').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('"New product" dialog fields are present', async ({ page }) => {
    await page.goto('/weldstash/products');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new product/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await expect(dialog.locator('#name')).toBeVisible();
    await expect(dialog.locator('#sku')).toBeVisible();
    await expect(dialog.locator('#price')).toBeVisible();
    await expect(dialog.locator('#lowStockThreshold')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Suppliers — "New supplier" dialog validation
// ---------------------------------------------------------------------------

test.describe('WeldStash · suppliers form validation', () => {
  test('submitting empty "New supplier" form shows companyName required error', async ({ page }) => {
    await page.goto('/weldstash/suppliers');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new supplier/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.locator('#companyName').clear();
    await dialog.getByRole('button', { name: /create/i }).click();

    await expect(
      dialog.locator('p.text-destructive').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('"New supplier" dialog fields are present', async ({ page }) => {
    await page.goto('/weldstash/suppliers');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new supplier/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await expect(dialog.locator('#companyName')).toBeVisible();
    await expect(dialog.locator('#email')).toBeVisible();
    await expect(dialog.locator('#phone')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Warehouses — "New warehouse" dialog validation
// ---------------------------------------------------------------------------

test.describe('WeldStash · warehouses form validation', () => {
  test('submitting empty "New warehouse" form shows name required error', async ({ page }) => {
    await page.goto('/weldstash/warehouses');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new warehouse/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.locator('#name').clear();
    await dialog.getByRole('button', { name: /create/i }).click();

    await expect(
      dialog.locator('p.text-destructive').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('"New warehouse" dialog fields are present', async ({ page }) => {
    await page.goto('/weldstash/warehouses');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new warehouse/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await expect(dialog.locator('#name')).toBeVisible();
    await expect(dialog.locator('#code')).toBeVisible();
    await expect(dialog.locator('#addressLine1')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Stock — "Adjust stock" dialog field structure
// ---------------------------------------------------------------------------

test.describe('WeldStash · adjust stock form', () => {
  test('"Adjust stock" dialog shows product and warehouse Select placeholders', async ({ page }) => {
    await page.goto('/weldstash/stock');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /adjust stock/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The Select components render a placeholder button when nothing is chosen.
    await expect(
      dialog.getByRole('combobox', { name: /product/i }).or(
        dialog.getByText(/select product/i),
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole('combobox', { name: /warehouse/i }).or(
        dialog.getByText(/select warehouse/i),
      ),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('"Adjust stock" dialog shows delta and reason inputs', async ({ page }) => {
    await page.goto('/weldstash/stock');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /adjust stock/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await expect(dialog.locator('#delta')).toBeVisible();
    await expect(dialog.locator('#reason')).toBeVisible();
  });

  test('submitting "Adjust stock" with empty required fields shows inline errors', async ({ page }) => {
    await page.goto('/weldstash/stock');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /adjust stock/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Submit without selecting product, warehouse, or providing a reason.
    await dialog.getByRole('button', { name: /apply/i }).click();

    // At least one validation error paragraph should appear.
    await expect(
      dialog.locator('p.text-destructive').first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});

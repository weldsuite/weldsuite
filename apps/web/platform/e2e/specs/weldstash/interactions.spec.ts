/**
 * Interaction spec for WeldStash (WMS / Inventory).
 *
 * Covers:
 *  - All four sub-routes render with sidebar present.
 *  - Dashboard quick-action buttons navigate to the correct sub-pages.
 *  - Each creation dialog opens (by clicking its DialogTrigger button) and
 *    the expected DialogTitle is visible.
 *  - Each dialog can be dismissed via its Cancel button.
 *  - Empty-state table messages are present when no data is loaded.
 *
 * NOTE: No data-testid attributes exist on the dialog trigger buttons or
 * form submit buttons in the current WeldStash components. Selectors rely
 * on getByRole('button', { name: ... }) which is stable as long as the
 * button text does not change. Adding data-testid attributes to those
 * buttons is recommended (see crossCuttingRecommendations in the coverage
 * report) to make these selectors resilient to icon-only variants.
 */

import { test, expect } from '../../fixtures';

// ---------------------------------------------------------------------------
// Sub-route render checks
// ---------------------------------------------------------------------------

test.describe('WeldStash · views', () => {
  for (const view of ['products', 'stock', 'suppliers', 'warehouses']) {
    test(`/weldstash/${view} renders with sidebar`, async ({ page }) => {
      await page.goto(`/weldstash/${view}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/weldstash/${view}`));
    });
  }
});

// ---------------------------------------------------------------------------
// Dashboard quick-action navigation
// ---------------------------------------------------------------------------

test.describe('WeldStash · dashboard quick actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldstash');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('New product quick action navigates to /weldstash/products', async ({ page }) => {
    await page.getByRole('link', { name: /new product/i }).first().click();
    await expect(page).toHaveURL(/\/weldstash\/products/, { timeout: 10_000 });
  });

  test('New supplier quick action navigates to /weldstash/suppliers', async ({ page }) => {
    await page.getByRole('link', { name: /new supplier/i }).first().click();
    await expect(page).toHaveURL(/\/weldstash\/suppliers/, { timeout: 10_000 });
  });

  test('New warehouse quick action navigates to /weldstash/warehouses', async ({ page }) => {
    await page.getByRole('link', { name: /new warehouse/i }).first().click();
    await expect(page).toHaveURL(/\/weldstash\/warehouses/, { timeout: 10_000 });
  });

  test('Adjust stock quick action navigates to /weldstash/stock', async ({ page }) => {
    await page.getByRole('link', { name: /adjust stock/i }).first().click();
    await expect(page).toHaveURL(/\/weldstash\/stock/, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Products page — dialog and empty state
// ---------------------------------------------------------------------------

test.describe('WeldStash · products page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldstash/products');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('"New product" button opens the creation dialog', async ({ page }) => {
    await page.getByRole('button', { name: /new product/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /new product/i })).toBeVisible();
  });

  test('"New product" dialog Cancel button closes the dialog', async ({ page }) => {
    await page.getByRole('button', { name: /new product/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('empty-state row is visible when no products exist', async ({ page }) => {
    // Wait for loading to finish before asserting empty state.
    // The table shows "Loading…" first; once resolved the empty row appears.
    await expect(
      page.getByRole('cell', { name: /no products yet/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Suppliers page — dialog and empty state
// ---------------------------------------------------------------------------

test.describe('WeldStash · suppliers page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldstash/suppliers');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('"New supplier" button opens the creation dialog', async ({ page }) => {
    await page.getByRole('button', { name: /new supplier/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /new supplier/i })).toBeVisible();
  });

  test('"New supplier" dialog Cancel button closes the dialog', async ({ page }) => {
    await page.getByRole('button', { name: /new supplier/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('empty-state row is visible when no suppliers exist', async ({ page }) => {
    await expect(
      page.getByRole('cell', { name: /no suppliers yet/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Warehouses page — dialog and empty state
// ---------------------------------------------------------------------------

test.describe('WeldStash · warehouses page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldstash/warehouses');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('"New warehouse" button opens the creation dialog', async ({ page }) => {
    await page.getByRole('button', { name: /new warehouse/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /new warehouse/i })).toBeVisible();
  });

  test('"New warehouse" dialog Cancel button closes the dialog', async ({ page }) => {
    await page.getByRole('button', { name: /new warehouse/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('empty-state row is visible when no warehouses exist', async ({ page }) => {
    await expect(
      page.getByRole('cell', { name: /no warehouses yet/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Stock page — dialog and empty state
// ---------------------------------------------------------------------------

test.describe('WeldStash · stock page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldstash/stock');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
  });

  test('"Adjust stock" button opens the adjustment dialog', async ({ page }) => {
    await page.getByRole('button', { name: /adjust stock/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /adjust stock/i })).toBeVisible();
  });

  test('"Adjust stock" dialog Cancel button closes the dialog', async ({ page }) => {
    await page.getByRole('button', { name: /adjust stock/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('empty-state row is visible when no stock exists', async ({ page }) => {
    await expect(
      page.getByRole('cell', { name: /no stock yet/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

/**
 * CRUD spec for WeldStash entities (products, suppliers, warehouses).
 *
 * Shape mirrors e2e/specs/weldcrm/companies-crud.spec.ts exactly.
 * Cleanup uses scoped per-row deletion to avoid cross-worker interference.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

// ---------------------------------------------------------------------------
// Products CRUD
// ---------------------------------------------------------------------------

test.describe('WeldStash · products CRUD', () => {
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

  test('seeded product row appears in the products table', async ({ page, api }) => {
    const product = await api.seedWeldstashProduct({ name: `E2EProduct${Date.now().toString(36)}` });
    seeded = { type: 'weldstash-product', id: product.id };

    await page.goto('/weldstash/products');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The product name should appear in a table cell.
    await expect(page.getByRole('cell', { name: product.name })).toBeVisible({ timeout: 10_000 });
  });

  test('edit product via pencil button updates name in table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const product = await api.seedWeldstashProduct({ name: `E2EProd${stamp}` });
    seeded = { type: 'weldstash-product', id: product.id };
    const updatedName = `E2EProdUpd${stamp}`;

    await page.goto('/weldstash/products');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Wait for the row to appear, then find the edit button in the same row.
    const row = page.getByRole('row', { name: new RegExp(product.name) });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The edit button is a ghost icon-only button; click it by position within
    // the row. TODO: add data-testid="weldstash-product-edit-{id}" to make
    // this selector unconditional.
    await row.getByRole('button').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /edit product/i })).toBeVisible();

    await dialog.locator('#name').fill(updatedName);
    await dialog.getByRole('button', { name: /save changes/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(page.getByRole('cell', { name: updatedName })).toBeVisible({ timeout: 10_000 });
  });

  test('delete product removes its row from the table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const product = await api.seedWeldstashProduct({ name: `E2EProdDel${stamp}` });
    seeded = { type: 'weldstash-product', id: product.id };

    await page.goto('/weldstash/products');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole('row', { name: new RegExp(product.name) });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Intercept the native confirm() dialog and accept it automatically.
    page.on('dialog', (d) => d.accept());

    // The delete button is the second icon button in the actions cell.
    await row.getByRole('button').last().click();

    await expect(row).toBeHidden({ timeout: 10_000 });
    // Entity removed by UI — no API cleanup needed.
    seeded = null;
  });
});

// ---------------------------------------------------------------------------
// Suppliers CRUD
// ---------------------------------------------------------------------------

test.describe('WeldStash · suppliers CRUD', () => {
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

  test('seeded supplier row appears in the suppliers table', async ({ page, api }) => {
    const supplier = await api.seedWeldstashSupplier({ name: `E2ESupplier${Date.now().toString(36)}` });
    seeded = { type: 'weldstash-supplier', id: supplier.id };

    await page.goto('/weldstash/suppliers');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('cell', { name: supplier.name })).toBeVisible({ timeout: 10_000 });
  });

  test('edit supplier via pencil button updates name in table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const supplier = await api.seedWeldstashSupplier({ name: `E2ESupp${stamp}` });
    seeded = { type: 'weldstash-supplier', id: supplier.id };
    const updatedName = `E2ESuppUpd${stamp}`;

    await page.goto('/weldstash/suppliers');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole('row', { name: new RegExp(supplier.name) });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /edit supplier/i })).toBeVisible();

    await dialog.locator('#companyName').fill(updatedName);
    await dialog.getByRole('button', { name: /save changes/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(page.getByRole('cell', { name: updatedName })).toBeVisible({ timeout: 10_000 });
  });

  test('delete supplier removes its row from the table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const supplier = await api.seedWeldstashSupplier({ name: `E2ESuppDel${stamp}` });
    seeded = { type: 'weldstash-supplier', id: supplier.id };

    await page.goto('/weldstash/suppliers');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole('row', { name: new RegExp(supplier.name) });
    await expect(row).toBeVisible({ timeout: 10_000 });

    page.on('dialog', (d) => d.accept());
    await row.getByRole('button').last().click();

    await expect(row).toBeHidden({ timeout: 10_000 });
    // Entity removed by UI — no API cleanup needed.
    seeded = null;
  });
});

// ---------------------------------------------------------------------------
// Warehouses CRUD
// ---------------------------------------------------------------------------

test.describe('WeldStash · warehouses CRUD', () => {
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

  test('seeded warehouse row appears in the warehouses table', async ({ page, api }) => {
    const warehouse = await api.seedWeldstashWarehouse({ name: `E2EWarehouse${Date.now().toString(36)}` });
    seeded = { type: 'weldstash-warehouse', id: warehouse.id };

    await page.goto('/weldstash/warehouses');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('cell', { name: warehouse.name })).toBeVisible({ timeout: 10_000 });
  });

  test('edit warehouse via pencil button updates name in table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const warehouse = await api.seedWeldstashWarehouse({ name: `E2EWH${stamp}` });
    seeded = { type: 'weldstash-warehouse', id: warehouse.id };
    const updatedName = `E2EWHUpd${stamp}`;

    await page.goto('/weldstash/warehouses');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole('row', { name: new RegExp(warehouse.name) });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('heading', { name: /edit warehouse/i })).toBeVisible();

    await dialog.locator('#name').fill(updatedName);
    await dialog.getByRole('button', { name: /save changes/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(page.getByRole('cell', { name: updatedName })).toBeVisible({ timeout: 10_000 });
  });

  test('delete warehouse removes its row from the table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const warehouse = await api.seedWeldstashWarehouse({ name: `E2EWHDel${stamp}` });
    seeded = { type: 'weldstash-warehouse', id: warehouse.id };

    await page.goto('/weldstash/warehouses');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole('row', { name: new RegExp(warehouse.name) });
    await expect(row).toBeVisible({ timeout: 10_000 });

    page.on('dialog', (d) => d.accept());
    await row.getByRole('button').last().click();

    await expect(row).toBeHidden({ timeout: 10_000 });
    // Entity removed by UI — no API cleanup needed.
    seeded = null;
  });
});

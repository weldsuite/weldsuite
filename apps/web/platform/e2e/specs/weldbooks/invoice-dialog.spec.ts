/**
 * Spec for the InvoiceDialog opened from /weldbooks/invoices.
 *
 * The dialog is a complex multi-section form with line items, tax rates,
 * and a running total. It has no data-testid attributes, so selectors
 * rely on role/label.
 *
 * Tests here are structural — they do NOT submit the form (which would
 * require a seeded customer contact). The happy-path CRUD spec is
 * intentionally skipped here; it is blocked until a seedAccountingContact
 * method is added to test-fixtures-client.ts and the corresponding
 * /test-fixtures/seed/accounting-contact endpoint is implemented in app-api.
 *
 * These tests verify:
 *   1. Clicking the New Invoice CTA opens the dialog.
 *   2. The dialog contains the customer selector, issue/due date inputs,
 *      and the line-items section.
 *   3. The Create Invoice submit button is present inside the dialog.
 *   4. The Add Item button inside the dialog appends a second line-item row.
 *   5. Closing the dialog (Cancel) hides it again.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldBooks · InvoiceDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldbooks/invoices');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Open the dialog via the ListToolbar create button.
    const createBtn = page.getByRole('button', { name: /new invoice/i });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('dialog renders customer selector, date inputs, and line items section', async ({
    page,
  }) => {
    const dialog = page.getByRole('dialog');

    // Customer autocomplete placeholder
    await expect(
      dialog.getByRole('combobox').or(dialog.getByPlaceholder(/select customer/i)),
    ).toBeVisible({ timeout: 10_000 });

    // Date inputs
    await expect(dialog.locator('#issueDate')).toBeVisible();
    await expect(dialog.locator('#dueDate')).toBeVisible();

    // Line items label
    await expect(dialog.getByText(/line items/i)).toBeVisible();
  });

  test('Create Invoice submit button is visible in the dialog', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('button', { name: /create invoice/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Add Item button appends a second line-item block', async ({ page }) => {
    const dialog = page.getByRole('dialog');

    // Count the initial line-item rows (1 by default)
    const itemBlocks = dialog.locator('[class*="rounded-md border"]');
    const initialCount = await itemBlocks.count();

    await dialog.getByRole('button', { name: /add item/i }).click();

    await expect(itemBlocks).toHaveCount(initialCount + 1, { timeout: 5_000 });
  });

  test('Cancel button closes the dialog', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

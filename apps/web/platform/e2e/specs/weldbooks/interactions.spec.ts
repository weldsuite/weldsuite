/**
 * Interaction spec for WeldBooks. Verifies the primary CTAs on key pages
 * actually open their dialogs / trigger navigation — not just that the
 * sidebar is rendered.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldBooks · invoices CTA', () => {
  test('New Invoice button on /weldbooks/invoices opens the invoice dialog', async ({ page }) => {
    await page.goto('/weldbooks/invoices');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const createBtn = page.getByRole('button', { name: /new invoice/i });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('WeldBooks · banking CTA', () => {
  test('Add Bank Account button on /weldbooks/banking opens a dialog or sheet', async ({
    page,
  }) => {
    await page.goto('/weldbooks/banking');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const createBtn = page.getByRole('button', { name: /add bank account/i });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    // The BankAccountFormDialog is a Dialog — assert the dialog role appears.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('New Rule button on /weldbooks/banking/rules opens the rule form dialog', async ({
    page,
  }) => {
    await page.goto('/weldbooks/banking/rules');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const createBtn = page.getByRole('button', { name: /new rule/i });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('WeldBooks · VAT CTA', () => {
  test('Calculate New Return button on /weldbooks/vat opens the period-picker dialog', async ({
    page,
  }) => {
    await page.goto('/weldbooks/vat');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The ListToolbar create button label is "Calculate New Return"
    const createBtn = page.getByRole('button', { name: /calculate new return/i });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // Period start / end date inputs appear inside the dialog
    await expect(dialog.locator('input[type="date"]').first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('WeldBooks · add-form navigation', () => {
  const formRoutes = [
    { path: '/weldbooks/accounts/add', label: 'accounts add' },
    { path: '/weldbooks/bills/add', label: 'bills add' },
    { path: '/weldbooks/customers/add', label: 'customers add' },
    { path: '/weldbooks/invoices/add', label: 'invoices add' },
    { path: '/weldbooks/journal/add', label: 'journal add' },
    { path: '/weldbooks/recurring/add', label: 'recurring add' },
  ];

  for (const { path, label } of formRoutes) {
    test(`${label} page renders a form`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(path.replace(/\//g, '\\/')));
      // Every add form has at least one submit button
      await expect(page.getByRole('button', { name: /create|submit|save/i }).first()).toBeVisible({
        timeout: 10_000,
      });
    });
  }
});

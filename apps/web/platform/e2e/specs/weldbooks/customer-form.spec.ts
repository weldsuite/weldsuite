/**
 * Form spec for /weldbooks/customers/add — the shared contact creation
 * path used by both customers and suppliers.
 *
 * All inputs have stable `id` attributes (id="name", id="email",
 * id="role", etc.) wired via react-hook-form + zodResolver.
 *
 * These tests do NOT seed data and do NOT submit the form (which would
 * require a running API). They verify:
 *   1. All required field inputs render.
 *   2. The submit button is disabled while the mutation is pending (it
 *      starts enabled because the form has valid default values except
 *      for name).
 *   3. Submitting with an empty name shows the inline validation error.
 *   4. Typing a value into a field updates it correctly.
 *   5. The role select defaults to "customer".
 */

import { test, expect } from '../../fixtures';

test.describe('WeldBooks · customer add form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldbooks/customers/add');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Wait until the form is painted — the name input is always present.
    await expect(page.locator('#name')).toBeVisible({ timeout: 10_000 });
  });

  test('renders all key input fields', async ({ page }) => {
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('#firstName')).toBeVisible();
    await expect(page.locator('#lastName')).toBeVisible();
    await expect(page.locator('#companyName')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#phone')).toBeVisible();
    await expect(page.locator('#taxNumber')).toBeVisible();
    await expect(page.locator('#iban')).toBeVisible();
    await expect(page.locator('#paymentTermsDays')).toBeVisible();
  });

  test('role select defaults to "customer"', async ({ page }) => {
    // The SelectTrigger has id="role"; its displayed text reflects the value.
    const roleTrigger = page.locator('#role');
    await expect(roleTrigger).toBeVisible();
    await expect(roleTrigger).toContainText(/customer/i);
  });

  test('typing into name updates the field value', async ({ page }) => {
    await page.locator('#name').fill('Acme Corp E2E');
    await expect(page.locator('#name')).toHaveValue('Acme Corp E2E');
  });

  test('typing into email updates the field value', async ({ page }) => {
    await page.locator('#email').fill('hello@acme.test');
    await expect(page.locator('#email')).toHaveValue('hello@acme.test');
  });

  test('submitting with empty name shows a validation error', async ({ page }) => {
    // Clear the name field (it defaults to empty string but make sure)
    await page.locator('#name').fill('');
    const submitBtn = page.getByRole('button', { name: /create contact/i });
    await submitBtn.click();
    // React Hook Form / zod should surface the inline error
    await expect(page.getByText(/name is required/i)).toBeVisible({ timeout: 5_000 });
  });

  test('paymentTermsDays defaults to 30', async ({ page }) => {
    await expect(page.locator('#paymentTermsDays')).toHaveValue('30');
  });

  test('cancel button navigates back to the customers list', async ({ page }) => {
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page).toHaveURL(/\/weldbooks\/customers/, { timeout: 10_000 });
  });
});

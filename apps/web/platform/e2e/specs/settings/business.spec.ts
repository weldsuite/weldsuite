/**
 * Business settings spec — verifies the workspace's legal entity
 * details form renders its expected fields.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · business', () => {
  test('/settings/business renders the legal-entity fields', async ({ page }) => {
    await page.goto('/settings/business');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // React Hook Form binds inputs via `name=`. These are stable
    // because the form's Zod schema keys to the same names.
    await expect(page.locator('input[name="legalName"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('input[name="tradingName"]')).toBeVisible();
    await expect(page.locator('input[name="taxId"]')).toBeVisible();
    await expect(page.locator('input[name="registrationNumber"]')).toBeVisible();
  });

  test('contact fields are present', async ({ page }) => {
    await page.goto('/settings/business');
    await expect(page.locator('input[name="contactFirstName"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('input[name="contactLastName"]')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="phone"]')).toBeVisible();
  });

  test('address fields are present', async ({ page }) => {
    await page.goto('/settings/business');
    await expect(page.locator('input[name="addressLine1"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('input[name="postalCode"]')).toBeVisible();
    await expect(page.locator('input[name="city"]')).toBeVisible();
  });

  test('typing into legalName updates the field', async ({ page }) => {
    await page.goto('/settings/business');
    const legalName = page.locator('input[name="legalName"]');
    await expect(legalName).toBeVisible({ timeout: 10_000 });
    const original = (await legalName.inputValue()) || '';
    await legalName.fill('E2E Test Entity Ltd');
    await expect(legalName).toHaveValue('E2E Test Entity Ltd');
    // Restore to avoid polluting state for downstream tests.
    await legalName.fill(original);
  });
});

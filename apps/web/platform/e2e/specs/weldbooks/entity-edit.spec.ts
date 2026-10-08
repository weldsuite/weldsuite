/**
 * Spec for the entity edit page (/weldbooks/entities/$id/edit), reached from
 * the entities list. Structural only: it does not save, so no seeded data is
 * changed. Assumes the test workspace has at least one accounting entity
 * (every other WeldBooks spec needs one too).
 *
 * Verifies:
 *   1. The Edit action on the entities list opens the edit page.
 *   2. The page shows the address fields, tax identifiers and bank details.
 *   3. The lock dates card shows all five lock dates.
 *   4. The lock exceptions card is present.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldBooks · entity edit page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/weldbooks/entities');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    const editButton = page.getByRole('button', { name: /^edit$/i }).first();
    await expect(editButton).toBeVisible({ timeout: 10_000 });
    await editButton.click();
    await expect(page).toHaveURL(/\/weldbooks\/entities\/[^/]+\/edit/, { timeout: 10_000 });
  });

  test('renders the company details form', async ({ page }) => {
    await expect(page.locator('#entity-name')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#entity-legalName')).toBeVisible();
    await expect(page.locator('#entity-address-line1')).toBeVisible();
    await expect(page.locator('#entity-address-country')).toBeVisible();
    await expect(page.locator('#entity-taxId')).toBeVisible();
    await expect(page.locator('#entity-registrationNumber')).toBeVisible();
    await expect(page.locator('#entity-bankName')).toBeVisible();
  });

  test('shows the five lock dates and the lock exceptions card', async ({ page }) => {
    await expect(page.locator('#lock-salesLockDate')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#lock-purchaseLockDate')).toBeVisible();
    await expect(page.locator('#lock-taxLockDate')).toBeVisible();
    await expect(page.locator('#lock-periodLockDate')).toBeVisible();
    await expect(page.locator('#lock-hardLockDate')).toBeVisible();
    await expect(page.getByText(/lock exceptions/i)).toBeVisible();
  });
});

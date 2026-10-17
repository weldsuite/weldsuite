/**
 * Spec for the entity edit page (/settings/entities/$id/edit), reached from
 * the entities list. Structural only: it does not save, so no seeded data is
 * changed. Assumes the test workspace has at least one accounting entity
 * (every other WeldBooks spec needs one too).
 *
 * Verifies:
 *   1. Clicking an entity in the Settings → Entities list opens the edit page.
 *   2. The page shows the address fields, tax identifiers and bank details.
 *   3. The lock dates card shows all five lock dates.
 *   4. The lock exceptions card is present.
 *   5. The WeldBooks tab holds the WeldBooks settings of the entity.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · entity edit page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings/entities');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    const entityRow = page.getByRole('button', { name: /^view$/i }).first();
    await expect(entityRow).toBeVisible({ timeout: 10_000 });
    await entityRow.click();
    await expect(page).toHaveURL(/\/settings\/entities\/[^/]+\/edit/, { timeout: 10_000 });
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

  test('shows the WeldBooks settings on the WeldBooks tab', async ({ page }) => {
    await page.getByRole('tab', { name: /^weldbooks$/i }).click();
    await expect(page).toHaveURL(/\/settings\/entities\/[^/]+\/edit\?tab=weldbooks$/, { timeout: 10_000 });
    await expect(page.getByRole('link', { name: /manage templates/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/ledger catch-up/i)).toBeVisible();
    await expect(page.locator('#entity-name')).toBeHidden();
  });
});

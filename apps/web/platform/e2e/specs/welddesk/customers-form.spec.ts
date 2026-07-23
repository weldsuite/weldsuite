/**
 * WeldDesk new-contact form spec.
 *
 * NOTE: The correct URL is /welddesk/contacts/new — the route file lives at
 * src/routes/welddesk/contacts/new/index.tsx and renders
 * app/welddesk/customers/new/page.tsx. /welddesk/customers/new does not exist
 * as a route and would always produce a 404/redirect.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldDesk · new contact form', () => {
  test('renders firstName, lastName, email, phone, company', async ({ page }) => {
    await page.goto('/welddesk/contacts/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#firstName')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#lastName')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#phone')).toBeVisible();
    await expect(page.locator('#company')).toBeVisible();
  });

  test('typing into firstName updates the field value', async ({ page }) => {
    await page.goto('/welddesk/contacts/new');
    const first = page.locator('#firstName');
    await expect(first).toBeVisible({ timeout: 10_000 });
    await first.fill('Jane E2E');
    await expect(first).toHaveValue('Jane E2E');
  });
});

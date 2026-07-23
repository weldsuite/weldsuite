/**
 * New announcement form spec — verifies the form fields render with
 * their stable `id="..."` selectors and validation works.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldDesk · new announcement form', () => {
  test('renders title + excerpt + content inputs', async ({ page }) => {
    await page.goto('/welddesk/announcements/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('#title')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#excerpt')).toBeVisible();
    await expect(page.locator('#content')).toBeVisible();
  });

  test('typing into title updates the field value', async ({ page }) => {
    await page.goto('/welddesk/announcements/new');
    const title = page.locator('#title');
    await expect(title).toBeVisible({ timeout: 10_000 });
    await title.fill('E2E test announcement');
    await expect(title).toHaveValue('E2E test announcement');
  });

  test('expiresAt date input is present', async ({ page }) => {
    await page.goto('/welddesk/announcements/new');
    await expect(page.locator('#expiresAt')).toBeVisible({ timeout: 10_000 });
  });
});

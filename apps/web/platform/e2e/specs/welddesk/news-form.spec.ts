/**
 * New news article form spec.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldDesk · new news article form', () => {
  test('renders title + content fields', async ({ page }) => {
    await page.goto('/welddesk/news/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#title')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#content')).toBeVisible();
  });

  test('tags + coverImage fields are present', async ({ page }) => {
    await page.goto('/welddesk/news/new');
    await expect(page.locator('#tags')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#coverImage')).toBeVisible();
  });

  test('typing into title updates the field value', async ({ page }) => {
    await page.goto('/welddesk/news/new');
    const title = page.locator('#title');
    await expect(title).toBeVisible({ timeout: 10_000 });
    await title.fill('E2E test news');
    await expect(title).toHaveValue('E2E test news');
  });
});

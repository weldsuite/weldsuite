/**
 * Interaction spec for the WeldDesk knowledge base. Verifies the two
 * inline create flows:
 *
 *   1. "New Article" button → dialog with #articleTitle input.
 *   2. "New Folder" button (in actionButtons) → dialog with #folderName input.
 *
 * Both dialogs use stable `id=` selectors baked into KnowledgeClient.
 * No seed data is required — the dialogs open unconditionally.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldDesk · knowledge base — create flows', () => {
  test('"New Article" button opens the create-article dialog', async ({ page }) => {
    await page.goto('/welddesk/knowledge');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The EntityList createButton renders "New Article"
    const newArticleBtn = page.getByRole('button', { name: /new article/i });
    await expect(newArticleBtn).toBeVisible({ timeout: 10_000 });
    await newArticleBtn.click();

    // Dialog with the #articleTitle input must appear
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#articleTitle')).toBeVisible({ timeout: 5_000 });
  });

  test('typing into #articleTitle updates the field value', async ({ page }) => {
    await page.goto('/welddesk/knowledge');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new article/i }).click();
    const titleInput = page.locator('#articleTitle');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill('E2E article title');
    await expect(titleInput).toHaveValue('E2E article title');
  });

  test('"New Folder" button opens the create-folder dialog', async ({ page }) => {
    await page.goto('/welddesk/knowledge');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The "New Folder" button lives in EntityList actionButtons (outline variant)
    const newFolderBtn = page.getByRole('button', { name: /new folder/i });
    await expect(newFolderBtn).toBeVisible({ timeout: 10_000 });
    await newFolderBtn.click();

    // Dialog with the #folderName input must appear
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#folderName')).toBeVisible({ timeout: 5_000 });
  });

  test('typing into #folderName updates the field value', async ({ page }) => {
    await page.goto('/welddesk/knowledge');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new folder/i }).click();
    const folderInput = page.locator('#folderName');
    await expect(folderInput).toBeVisible({ timeout: 5_000 });
    await folderInput.fill('Getting Started');
    await expect(folderInput).toHaveValue('Getting Started');
  });
});

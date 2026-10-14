/**
 * Interaction spec for /settings/api-keys.
 *
 * The External API is available on every plan, so ApiKeysSection always
 * renders the keys manager and its "Generate Key" button opens the create
 * dialog.
 *
 * The "Generate Key" button has no data-testid; the recommendation to
 * add `data-testid="settings-api-keys-create-btn"` is filed in
 * crossCuttingRecommendations. Until then we locate by role + name.
 *
 * No seeded data is required — the manager renders without pre-existing
 * keys.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · API keys', () => {
  test('page renders the API Keys heading', async ({ page }) => {
    await page.goto('/settings/api-keys');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const heading = page.locator('h1').filter({ hasText: /api keys/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('"Generate Key" button opens the create dialog', async ({ page }) => {
    await page.goto('/settings/api-keys');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const generateKeyBtn = page.getByRole('button', { name: /generate key/i });
    await expect(generateKeyBtn).toBeVisible({ timeout: 20_000 });

    await generateKeyBtn.click();

    // The create dialog title is "Create API Key"
    await expect(
      page.getByRole('dialog').locator('h2, [data-slot="dialog-title"]').filter({ hasText: /create api key/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});

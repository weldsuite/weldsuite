/**
 * Interaction spec for /settings/api-keys.
 *
 * ApiKeysSection conditionally renders either an upgrade prompt (for
 * workspaces without API access) or the full keys manager. Both
 * branches are handled:
 *
 *  - Upgrade branch: the "Upgrade" button is visible.
 *  - Full branch: the "Generate Key" button opens the create dialog.
 *
 * The "Generate Key" button has no data-testid; the recommendation to
 * add `data-testid="settings-api-keys-create-btn"` is filed in
 * crossCuttingRecommendations. Until then we locate by role + name.
 *
 * No seeded data is required — either branch renders without pre-
 * existing keys.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · API keys', () => {
  test('page renders the API Keys heading', async ({ page }) => {
    await page.goto('/settings/api-keys');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const heading = page.locator('h1').filter({ hasText: /api keys/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('primary CTA is visible (Generate Key or Upgrade depending on plan)', async ({
    page,
  }) => {
    await page.goto('/settings/api-keys');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Wait for the subscription check to resolve before asserting.
    // ApiKeysSection has a null state while checking; give it extra time.
    const generateKeyBtn = page.getByRole('button', { name: /generate key/i });
    const upgradeBtn = page.getByRole('button', { name: /upgrade/i });

    // At least one of the two CTAs must be visible once the check resolves.
    // `.first()` keeps this out of strict mode: on the upgrade branch the page
    // CTA and the sidebar's feature-flagged Upgrade button both match.
    await expect(generateKeyBtn.or(upgradeBtn).first()).toBeVisible({ timeout: 20_000 });
  });

  test('"Generate Key" button opens the create dialog (when API access enabled)', async ({
    page,
  }) => {
    await page.goto('/settings/api-keys');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The page shows a loading placeholder until the billing check resolves,
    // then settles on either the keys manager (Generate Key) or the upgrade
    // prompt (Upgrade). Wait for that settled state before branching — the
    // component no longer flashes a Generate Key button during the unknown
    // window, so this no longer races the billing check.
    const generateKeyBtn = page.getByRole('button', { name: /generate key/i });
    const upgradeBtn = page.getByRole('button', { name: /upgrade/i });
    await expect(generateKeyBtn.or(upgradeBtn).first()).toBeVisible({ timeout: 20_000 });

    if (!(await generateKeyBtn.isVisible().catch(() => false))) {
      test.skip(true, 'Workspace is on free plan — API keys require an upgrade');
    }

    await generateKeyBtn.click();

    // The create dialog title is "Create API Key"
    await expect(
      page.getByRole('dialog').locator('h2, [data-slot="dialog-title"]').filter({ hasText: /create api key/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});

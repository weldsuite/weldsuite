/**
 * Smoke spec for the WeldHost add-external-domain wizard
 * (/weldhost/domains/external).
 *
 * Covers step 1 (enter domain) only — later steps require a real domain
 * reservation against Cloudflare, which is exercised at the API layer.
 * Also verifies both entry points into the wizard: the sidebar route and
 * the "Add External Domain" action button on the domains list.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldHost · add external domain wizard', () => {
  test('wizard step 1 renders at /weldhost/domains/external', async ({ page }) => {
    await page.goto('/weldhost/domains/external');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('heading', { name: 'Add External Domain' }),
    ).toBeVisible({ timeout: 10_000 });

    // Domain + registrar inputs are interactive.
    const domainInput = page.locator('#domain');
    await expect(domainInput).toBeVisible({ timeout: 10_000 });
    await domainInput.fill('example-external.com');
    await expect(domainInput).toHaveValue('example-external.com');

    await expect(page.locator('#registrar')).toBeVisible();
  });

  test('domains list exposes an Add External Domain button that opens the wizard', async ({ page }) => {
    await page.goto('/weldhost/domains');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const addExternalBtn = page.getByRole('button', { name: 'Add External Domain' });
    await expect(addExternalBtn).toBeVisible({ timeout: 10_000 });
    await addExternalBtn.click();

    await expect(page).toHaveURL(/\/weldhost\/domains\/external/, { timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: 'Add External Domain' }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

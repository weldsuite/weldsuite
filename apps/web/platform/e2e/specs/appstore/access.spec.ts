/**
 * App Store — access control. The App Store is an install/uninstall surface, so
 * only workspace owners/admins (can-manage = true) may use it. A member who
 * reaches `/appstore` (or a deep `/appstore/:code` link) by URL gets the
 * explicit "no access" screen instead of the catalog — see appstore-no-access.tsx.
 *
 * Network-mocked via helpers/appstore.ts with `canManage: false`.
 */

import { test, expect } from '../../fixtures';
import { mockAppStore, appCard } from '../../helpers/appstore';

test.describe('App Store · no access (member)', () => {
  test('the list page shows the no-access screen and no app cards', async ({ page }) => {
    await mockAppStore(page, { canManage: false });
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('heading', { name: 'No access to the App Store' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/you don't have permission to view the app store/i)).toBeVisible();

    // The catalog never renders for a member.
    await expect(appCard(page, 'weldcrm')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  });

  test('a deep detail link also shows the no-access screen', async ({ page }) => {
    await mockAppStore(page, { canManage: false });
    await page.goto('/appstore/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('heading', { name: 'No access to the App Store' }),
    ).toBeVisible({ timeout: 15_000 });

    // No install/uninstall controls leak onto the detail page for a member.
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toHaveCount(0);
  });
});

/**
 * App Store — app detail page (`/appstore/:code`) for an owner/admin.
 *
 * Network-mocked via helpers/appstore.ts. Covers: header + sidebar metadata
 * (category, built-by, resources), the Overview section, back navigation, the
 * install flow with the "assign to all members" option (asserting the POST
 * payload), the uninstall confirmation flow, and the unknown-app fallback.
 */

import { test, expect } from '../../fixtures';
import { mockAppStore } from '../../helpers/appstore';

test.describe('App Store · detail (owner)', () => {
  test('renders header, category, built-by, resources and overview', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Header: name + tagline.
    await expect(page.getByRole('heading', { name: 'WeldCRM', level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('Manage contacts, customers, leads and your sales pipeline.'),
    ).toBeVisible();

    // Sidebar metadata.
    await expect(page.getByText('Category', { exact: true })).toBeVisible();
    await expect(page.getByText('Sales', { exact: true })).toBeVisible();
    await expect(page.getByText('Built by', { exact: true })).toBeVisible();

    // Resource links (website/documentation render with their labels; the
    // contact link is shown as the bare email address).
    await expect(page.getByRole('link', { name: 'Website' })).toHaveAttribute(
      'href',
      'https://weldsuite.org/weldcrm',
    );
    await expect(page.getByRole('link', { name: 'Documentation' })).toHaveAttribute(
      'href',
      'https://docs.weldsuite.org/weldcrm',
    );
    await expect(page.getByRole('link', { name: 'support@weldsuite.org' })).toBeVisible();

    // Overview section uses the app's own overview text.
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(
      page.getByText('WeldCRM keeps every customer relationship in one place.'),
    ).toBeVisible();
  });

  test('falls back to the default overview when the app has none', async ({ page }) => {
    await mockAppStore(page);
    // weldflow has overview: null → the default copy is shown.
    await page.goto('/appstore/weldflow');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(
      page.getByText(/integrates seamlessly with your WeldSuite workspace/i),
    ).toBeVisible();
  });

  test('the Back button returns to the App Store list', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/appstore$/, { timeout: 10_000 });
  });

  test('an installed app shows an Uninstall action, a non-installed one shows Install', async ({ page }) => {
    await mockAppStore(page);

    await page.goto('/appstore/weldcrm'); // installed
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible();
    // The assign-to-all checkbox only appears for not-yet-installed apps.
    await expect(page.getByRole('checkbox')).toHaveCount(0);

    await page.goto('/appstore/weldmail'); // not installed
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('checkbox')).toBeVisible();
  });

  test('install sends assignToAllMembers=false by default', async ({ page }) => {
    const state = await mockAppStore(page);
    await page.goto('/appstore/weldmail');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const [req] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'POST' &&
          /\/settings\/apps\/weldmail\/install$/.test(new URL(r.url()).pathname),
      ),
      page.getByRole('button', { name: 'Install', exact: true }).click(),
    ]);
    expect(req).toBeTruthy();

    await expect(page.getByText(/has been installed successfully/i)).toBeVisible({
      timeout: 10_000,
    });
    expect(state.lastInstallBody).toMatchObject({ assignToAllMembers: false });
    // After success the action flips to Uninstall (optimistic).
    await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('checking "assign to all members" sends assignToAllMembers=true', async ({ page }) => {
    const state = await mockAppStore(page);
    await page.goto('/appstore/weldmail');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('checkbox').check();

    const [req] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'POST' &&
          /\/settings\/apps\/weldmail\/install$/.test(new URL(r.url()).pathname),
      ),
      page.getByRole('button', { name: 'Install', exact: true }).click(),
    ]);
    expect(req).toBeTruthy();

    // Wait for the success toast so the mock has captured the body before asserting.
    await expect(page.getByText(/has been installed successfully/i)).toBeVisible({
      timeout: 10_000,
    });
    expect(state.lastInstallBody).toMatchObject({ assignToAllMembers: true });
  });

  test('uninstall asks for confirmation then removes the app', async ({ page }) => {
    const state = await mockAppStore(page);
    await page.goto('/appstore/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Uninstall', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText('Uninstall WeldCRM?')).toBeVisible();

    const [req] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'DELETE' &&
          /\/settings\/apps\/weldcrm$/.test(new URL(r.url()).pathname),
      ),
      dialog.getByRole('button', { name: 'Uninstall', exact: true }).click(),
    ]);
    expect(req).toBeTruthy();

    await expect(page.getByText(/has been uninstalled successfully/i)).toBeVisible({
      timeout: 10_000,
    });
    expect(state.uninstalls).toContain('weldcrm');
    // The action flips back to Install after uninstall.
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('an unknown app code shows the "App not found" fallback', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore/does-not-exist');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText('App not found')).toBeVisible({ timeout: 15_000 });
  });
});

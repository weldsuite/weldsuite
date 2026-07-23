/**
 * App Store — list page (`/appstore`) for an owner/admin (can-manage = true).
 *
 * All `/settings/*` App Store calls are mocked at the network layer (see
 * helpers/appstore.ts) so the page is deterministic and never mutates the
 * shared test workspace. Covers: category grouping, app cards, the installed
 * badge, navigation into the detail page, and the hover install / uninstall
 * flows including the error-revert path.
 */

import { test, expect } from '../../fixtures';
import { mockAppStore, appCard, SAMPLE_APPS } from '../../helpers/appstore';

test.describe('App Store · list (owner)', () => {
  test('renders the App Store header and every consolidated category', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Breadcrumb title.
    await expect(page.getByText('App Store', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The five sample apps span all five consolidated categories. Each renders
    // a section heading (h2). Section headings appear once in content + once in
    // the sticky sidebar nav, so assert ≥1 of each.
    for (const label of ['Customers', 'Communication', 'Work', 'Storage', 'Finance']) {
      await expect(page.getByRole('heading', { name: label }).first()).toBeVisible();
    }
  });

  test('shows a card for every available app with its name and description', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    for (const app of SAMPLE_APPS) {
      const card = appCard(page, app.code);
      await expect(card).toBeVisible();
      await expect(card.getByText(app.name, { exact: true })).toBeVisible();
      await expect(card.getByText(app.description, { exact: false })).toBeVisible();
    }
  });

  test('groups WeldDrive under Storage via the app-code override', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // welddrive is stored as "Productivity" but must render under the Storage
    // section, not Work. The Storage section's container id is `category-storage`.
    const storageSection = page.locator('#category-storage');
    await expect(storageSection).toBeVisible();
    await expect(storageSection.locator('a[href$="/appstore/welddrive"]')).toBeVisible();
    // And it must NOT appear under Work.
    await expect(
      page.locator('#category-work a[href$="/appstore/welddrive"]'),
    ).toHaveCount(0);
  });

  test('installed apps show the "Installed" badge', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // weldcrm is seeded as installed → badge visible without hovering.
    const crmCard = appCard(page, 'weldcrm');
    await expect(crmCard.getByText('Installed', { exact: true })).toBeVisible();

    // weldmail is not installed → no badge.
    await expect(
      appCard(page, 'weldmail').getByText('Installed', { exact: true }),
    ).toHaveCount(0);
  });

  test('clicking a card navigates to the app detail page', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await appCard(page, 'weldmail').click();
    await expect(page).toHaveURL(/\/appstore\/weldmail$/, { timeout: 10_000 });
  });

  test('the category sidebar lists every category as a nav button', async ({ page }) => {
    await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The sticky left nav renders one <button> per category under the
    // "Categories" label. Scope to buttons so we don't match the section h2s.
    for (const label of ['Customers', 'Communication', 'Work', 'Storage', 'Finance']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('hovering a non-installed app reveals an Install button and installs it', async ({ page }) => {
    const state = await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const card = appCard(page, 'weldmail');
    await card.hover();

    const installBtn = card.getByRole('button', { name: 'Install', exact: true });
    await expect(installBtn).toBeVisible();

    const [installReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'POST' &&
          /\/settings\/apps\/weldmail\/install$/.test(new URL(r.url()).pathname),
      ),
      installBtn.click(),
    ]);
    expect(installReq).toBeTruthy();

    // Success toast fires and — because the card is still hovered — the action
    // flips in place from Install to Uninstall (the app is now installed).
    await expect(page.getByText(/has been installed successfully/i)).toBeVisible({
      timeout: 10_000,
    });
    expect(state.installs).toContain('weldmail');
    await expect(card.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('hovering an installed app reveals Uninstall and confirms before removing', async ({ page }) => {
    const state = await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const card = appCard(page, 'weldcrm');
    await card.hover();

    const uninstallBtn = card.getByRole('button', { name: 'Uninstall', exact: true });
    await expect(uninstallBtn).toBeVisible();
    await uninstallBtn.click();

    // Confirmation dialog with the app name in the title.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText('Uninstall WeldCRM?')).toBeVisible();

    const [deleteReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'DELETE' &&
          /\/settings\/apps\/weldcrm$/.test(new URL(r.url()).pathname),
      ),
      dialog.getByRole('button', { name: 'Uninstall', exact: true }).click(),
    ]);
    expect(deleteReq).toBeTruthy();

    await expect(page.getByText(/has been uninstalled successfully/i)).toBeVisible({
      timeout: 10_000,
    });
    expect(state.uninstalls).toContain('weldcrm');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });

  test('cancelling the uninstall dialog does not send a delete', async ({ page }) => {
    const state = await mockAppStore(page);
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const card = appCard(page, 'weldbooks');
    await card.hover();
    await card.getByRole('button', { name: 'Uninstall', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // No delete request was issued and the app stays installed.
    expect(state.uninstalls).not.toContain('weldbooks');
  });

  test('a failed install shows an error and reverts the card', async ({ page, consoleErrors }) => {
    await mockAppStore(page, { failInstall: true });
    await page.goto('/appstore');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const card = appCard(page, 'weldflow');
    await card.hover();
    const installBtn = card.getByRole('button', { name: 'Install', exact: true });
    await installBtn.click();

    // Error toast surfaces (the mock's 500 message), and the optimistic update
    // is rolled back — the action stays "Install" and never becomes "Uninstall".
    await expect(page.getByText(/install failed/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(card.getByRole('button', { name: 'Uninstall', exact: true })).toHaveCount(0);
    await expect(installBtn).toBeVisible();

    // The component logs `console.error('Failed to install app:', …)` on the
    // failure path — that's expected here, so clear it before the auto
    // console-error assertion in fixtures.ts runs at teardown.
    consoleErrors.errors.length = 0;
  });
});

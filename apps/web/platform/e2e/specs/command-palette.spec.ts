/**
 * Command palette spec — Cmd/Ctrl+K opens a centered dialog.
 * The trigger sits in the module header. The dialog is mounted on the shell,
 * so the shortcut works from any authenticated page. Chromium reserves a real
 * Ctrl+K, so the shortcut test dispatches the keydown the app listens for.
 */

import { test, expect } from '../fixtures';

// A module route that renders the global AppHeader (with the palette).
const ROUTE = '/weldcrm/companies';

test.describe('Command palette · cmdk', () => {
  test('trigger is present in the module header', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('cmdk-trigger')).toBeVisible({ timeout: 10_000 });
  });

  test('Cmd/Ctrl+K opens a centered dialog and focuses its input', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Chromium reserves real Ctrl+K (omnibox keyword search) so it never
    // reaches the page. Dispatch the keydown the app listens for.
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
      );
    });

    const dialog = page.getByTestId('command-palette');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('cmdk-input')).toBeFocused({ timeout: 5_000 });
  });

  test('typing filters commands instead of listing records', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.getByTestId('cmdk-trigger')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('cmdk-trigger').click();
    const input = page.getByTestId('cmdk-input');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('settings');
    await expect(page.getByRole('option', { name: /^Settings/ })).toBeVisible();
  });

  test('Escape closes the dialog', async ({ page }) => {
    await page.goto(ROUTE);
    await page.getByTestId('cmdk-trigger').click();
    await expect(page.getByTestId('command-palette')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();
  });
});

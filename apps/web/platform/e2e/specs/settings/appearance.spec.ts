/**
 * Appearance settings spec — verifies the theme picker is present
 * and exposes the three Light / Dark / System options.
 */

import { test, expect } from '../../fixtures';

test.describe('Settings · appearance', () => {
  test('/settings/appearance renders the three theme options', async ({ page }) => {
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Radix RadioGroup renders accessible radios with role="radio".
    const radios = page.getByRole('radio');
    await expect(radios.first()).toBeVisible({ timeout: 10_000 });
    expect(await radios.count()).toBeGreaterThanOrEqual(3);
  });

  test('selecting Dark theme updates aria-checked on the radio', async ({ page }) => {
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Locate the Dark radio by its underlying value attribute.
    const dark = page.locator('[role="radio"][value="dark"]');
    if (!(await dark.first().isVisible().catch(() => false))) {
      // The radios are off-screen sr-only — the label is clickable.
      // Find a label that contains "Dark" + click it; that triggers
      // the radio change.
      await page.getByText(/^Dark$/i).first().click();
    } else {
      await dark.first().click();
    }

    // Either the saved preference toast fires or the radio reports
    // checked — assert one of the two so we're tolerant of debounce.
    await expect
      .poll(async () => {
        const checked = await page
          .locator('[role="radio"][value="dark"][aria-checked="true"], [role="radio"][value="dark"][data-state="checked"]')
          .count();
        return checked > 0;
      }, { timeout: 10_000 })
      .toBe(true);
  });
});

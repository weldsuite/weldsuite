/**
 * Interaction spec for the WeldChat message-search page (/weldchat/search).
 *
 * All assertions target client-side state that holds regardless of workspace
 * content:
 *   - The search box and the three filter buttons always render.
 *   - The "type at least 2 characters" tip shows until the query reaches the
 *     2-char threshold (search/page.tsx: searchEnabled = query.length >= 2),
 *     then disappears — this is pure local state, independent of the search
 *     API result, so it stays deterministic without seeded messages.
 *
 * The "Date" filter button is deliberately never clicked: it opens a native
 * window.prompt() which would block the headless run.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldChat · search page', () => {
  test('renders the search input and stays on the search route', async ({ page }) => {
    await page.goto('/weldchat/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldchat\/search/);

    await expect(
      page.getByPlaceholder(/search messages/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows the filter buttons (Has file / Pinned / Date)', async ({ page }) => {
    await page.goto('/weldchat/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('button', { name: /has file/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^pinned$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^date$/i })).toBeVisible();
  });

  test('shows the search tip before the query reaches two characters', async ({ page }) => {
    await page.goto('/weldchat/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const tip = page.getByText(/type at least 2 characters to search/i);
    await expect(tip).toBeVisible({ timeout: 10_000 });

    // One character is below the threshold — the tip must still be visible.
    await page.getByPlaceholder(/search messages/i).fill('a');
    await expect(tip).toBeVisible();
  });

  test('hides the search tip once the query reaches two characters', async ({ page }) => {
    await page.goto('/weldchat/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const search = page.getByPlaceholder(/search messages/i);
    await expect(search).toBeVisible({ timeout: 10_000 });

    const tip = page.getByText(/type at least 2 characters to search/i);
    await expect(tip).toBeVisible();

    // Two characters crosses the searchEnabled threshold — the tip is replaced
    // by the searching / results / no-results state.
    await search.fill('ab');
    await expect(tip).toBeHidden({ timeout: 5_000 });
  });

  // The filter chips are pure client state (search/page.tsx filterChips):
  // toggling a filter button renders a removable chip <span> with that label,
  // and clicking the chip's X clears the filter. No seeded data required.
  test('toggling the Has file filter adds and removes a filter chip', async ({ page }) => {
    await page.goto('/weldchat/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const hasFileButton = page.getByRole('button', { name: /has file/i });
    await expect(hasFileButton).toBeVisible({ timeout: 10_000 });

    // Target the chip <span> specifically (the filter button shares the label).
    const chip = page.locator('span').filter({ hasText: /^Has file$/ });
    await expect(chip).toHaveCount(0);

    await hasFileButton.click();
    await expect(chip).toHaveCount(1);

    // The chip's only button is its remove (X) control.
    await chip.getByRole('button').click();
    await expect(chip).toHaveCount(0);
  });

  test('activating two filters renders two chips', async ({ page }) => {
    await page.goto('/weldchat/search');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /has file/i }).click();
    await page.getByRole('button', { name: /^pinned$/i }).click();

    const chips = page.locator('span').filter({ hasText: /^(Has file|Pinned)$/ });
    await expect(chips).toHaveCount(2);
  });
});

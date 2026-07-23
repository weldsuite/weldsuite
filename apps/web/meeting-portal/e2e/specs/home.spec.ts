/**
 * The portal root ("/") has no meeting code, so it renders a static
 * "Invalid meeting link" page. No mocks / network needed.
 */

import { test, expect } from '@playwright/test';

test.describe('Meeting portal · root', () => {
  test('shows the "invalid meeting link" page', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /invalid meeting link/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/check the meeting link you received/i)).toBeVisible();
  });
});

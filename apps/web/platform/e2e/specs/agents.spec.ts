/**
 * Agents page spec — the AI agent management surface.
 */

import { test, expect } from '../fixtures';

test.describe('Agents page', () => {
  test('/agents loads with the auth shell visible', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/agents/);
  });

  test('Agents page renders its content surface', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // The agents surface is an EntityList (no semantic h1/h2 — like the other
    // list pages, it uses the breadcrumb + toolbar). Assert its defining CTA
    // rendered, which proves the page mounted rather than an error boundary.
    await expect(
      page.getByRole('button', { name: /create agent/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

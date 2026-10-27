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
    // /agents is the overview of the workspace's agents (it no longer jumps into
    // the first one). Assert its defining CTA rendered ("New agent", or the
    // empty state's "Create your first agent"), which proves the page mounted
    // rather than an error boundary.
    await expect(
      page.getByRole('button', { name: /new agent|create your first agent/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/agents\/?$/);
  });
});

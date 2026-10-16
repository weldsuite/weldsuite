/**
 * Interaction spec for WeldFlow (Projects). Verifies the sub-views
 * (projects list, my-tasks, goals, files, etc.) all load.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldFlow · sub-views', () => {
  for (const sub of [
    'projects',
    'my-tasks',
    'goals',
    'files',
    'analytics',
    'whiteboard',
    'workload',
  ]) {
    test(`/weldflow/${sub} renders`, async ({ page }) => {
      await page.goto(`/weldflow/${sub}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/weldflow/${sub}`));
    });
  }
});

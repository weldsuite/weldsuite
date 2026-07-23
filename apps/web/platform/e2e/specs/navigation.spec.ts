/**
 * Navigation spec — every entry in the global app sidebar leads to
 * the right module. The sidebar is the canonical way users move
 * between top-level surfaces, so a regression here breaks everyone.
 */

import { test, expect } from '../fixtures';

interface NavCase {
  /** `data-testid` suffix on the link (e.g. `crm` → `app-nav-crm`). */
  testIdSlug: string;
  /** Regex the URL should match after the click. */
  expectedUrl: RegExp;
}

const cases: NavCase[] = [
  { testIdSlug: 'home', expectedUrl: /\/$/ },
  { testIdSlug: 'weldcrm', expectedUrl: /\/weldcrm/ },
  { testIdSlug: 'weldflow', expectedUrl: /\/weldflow/ },
  { testIdSlug: 'welddesk', expectedUrl: /\/welddesk/ },
  { testIdSlug: 'weldmail', expectedUrl: /\/weldmail/ },
  { testIdSlug: 'weldconnect', expectedUrl: /\/weldconnect/ },
  { testIdSlug: 'weldhost', expectedUrl: /\/weldhost/ },
  { testIdSlug: 'appstore', expectedUrl: /\/appstore/ },
];

test.describe('App sidebar · navigation', () => {
  for (const c of cases) {
    test(`app-nav-${c.testIdSlug} navigates to ${c.expectedUrl}`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

      const link = page.getByTestId(`app-nav-${c.testIdSlug}`);
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(c.expectedUrl, { timeout: 10_000 });
    });
  }

  test('the active nav entry highlights when the user is on its module', async ({ page }) => {
    await page.goto('/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The active rail icon gets a distinct background — `bg-gray-200/60` in
    // light mode, `dark:bg-accent/60` in dark (see app-sidebar-client.tsx).
    // Match on the substring rather than the full class list (Tailwind merges
    // + Lucide icons can shift surrounding classes).
    const crmLink = page.getByTestId('app-nav-weldcrm');
    const cls = (await crmLink.getAttribute('class')) ?? '';
    expect(cls).toMatch(/bg-(gray-200|accent|primary|white)/);
  });

  test('clicking the appstore "+" link opens the app store', async ({ page }) => {
    await page.goto('/weldcrm');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('app-nav-appstore').click();
    await expect(page).toHaveURL(/\/appstore/, { timeout: 10_000 });
  });
});

import { test, expect } from '../../fixtures';

/**
 * WeldCRM shell and first-load behaviour (QA tasks 1085, 1086, 676).
 *
 * No seeded data is needed: the list request is held back by the test, and the
 * header checks only look at layout.
 */

test.describe('WeldCRM · first load', () => {
  test('shows skeleton rows, never the empty state, while the companies request is pending', async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `/api/companies?limit=50…` (the list), not `/api/companies/:id`.
    await page.route(/\/api\/companies(\?|$)/, async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto('/weldcrm/companies');

    await expect(page.getByTestId('entity-grid-skeleton')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/No companies yet/i)).toHaveCount(0);

    release();
    await expect(page.getByTestId('entity-grid')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('entity-grid-skeleton')).toHaveCount(0);
  });
});

test.describe('WeldCRM · header at a narrow window', () => {
  test.use({ viewport: { width: 960, height: 800 } });

  test('keeps the breadcrumb on one line, clear of the search and the buttons', async ({ page }) => {
    await page.goto('/weldcrm/companies');

    const header = page.locator('[data-slot="app-header"]');
    await expect(header).toBeVisible({ timeout: 15_000 });
    const trail = header.getByRole('navigation', { name: 'breadcrumb' });
    await expect(trail).toContainText('Companies');
    const search = page.getByTestId('cmdk-trigger');
    const firstAction = header.getByRole('button', { name: 'Calendar' });

    const [trailBox, searchBox, actionBox] = await Promise.all([
      trail.boundingBox(),
      search.boundingBox(),
      firstAction.boundingBox(),
    ]);
    expect(trailBox).not.toBeNull();
    expect(searchBox).not.toBeNull();
    expect(actionBox).not.toBeNull();

    // One line: a wrapped trail would be taller than a single text row.
    expect(trailBox!.height).toBeLessThan(32);
    // Side by side, no overlap.
    expect(trailBox!.x + trailBox!.width).toBeLessThanOrEqual(searchBox!.x + 1);
    expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(actionBox!.x + 1);

    // The current page is not cut off ("Co…").
    const current = trail.locator('[data-slot="breadcrumb-page"]');
    const clipped = await current.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
  });
});

test.describe('WeldCRM · breadcrumb after in-app navigation', () => {
  test('shows the current section after moving from Sequences to People', async ({ page }) => {
    await page.goto('/weldcrm/sequences');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('app-sidebar').getByRole('link', { name: 'People', exact: true }).click();
    await expect(page).toHaveURL(/\/weldcrm\/people/, { timeout: 10_000 });

    const trail = page.locator('[data-slot="app-header"]').getByRole('navigation', { name: 'breadcrumb' });
    await expect(trail).toContainText('CRM');
    await expect(trail).toContainText('People');
  });
});

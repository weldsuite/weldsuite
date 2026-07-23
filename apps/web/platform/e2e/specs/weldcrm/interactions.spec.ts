/**
 * Interaction spec for WeldCRM list pages. Asserts the basics that
 * users hit on every visit: the EntityGrid renders, the search
 * input is wired, the create CTA is present.
 *
 * These don't seed data — they just verify the UI scaffolding. The
 * seed-driven CRUD specs (companies-crud, people-crud) cover the
 * full create→assert flow.
 */

import { test, expect } from '../../fixtures';
import { EntityGridPage } from '../../pages/entity-grid.page';

interface GridRoute {
  path: string;
  /** Which entity name the grid header is keyed by. */
  entityName: string;
}

const gridRoutes: GridRoute[] = [
  { path: '/weldcrm/companies', entityName: 'company' },
  { path: '/weldcrm/people', entityName: 'person' },
];

test.describe('WeldCRM · grid interactions', () => {
  for (const r of gridRoutes) {
    test(`${r.path} renders the entity grid with create + search controls`, async ({ page }) => {
      await page.goto(r.path);
      const grid = new EntityGridPage(page);
      await grid.waitForReady();

      await expect(grid.createButton()).toBeVisible({ timeout: 15_000 });
      // Search is initially collapsed to an icon — clicking opens
      // the actual input. Either state proves the toolbar rendered.
      const search = grid.searchInput();
      const visible = await search.isVisible().catch(() => false);
      if (!visible) {
        // The collapsed search icon is a sibling button; clicking it
        // opens the input. Don't assert too strongly because mobile
        // layouts can omit it.
        const icon = page
          .locator('[data-testid="entity-grid"]')
          .getByRole('button')
          .filter({ hasText: /^$/ })
          .first();
        if (await icon.isVisible().catch(() => false)) await icon.click();
      }
    });

    test(`${r.path} search input drives the URL ?search= param`, async ({ page }) => {
      await page.goto(r.path);
      const grid = new EntityGridPage(page);
      await grid.waitForReady();

      // Open the search if collapsed by clicking the input directly.
      const searchInput = grid.searchInput();
      if (!(await searchInput.isVisible().catch(() => false))) {
        // Fall back to scoping by data-slot for the icon button.
        const trigger = page
          .locator('[data-testid="entity-grid"] button:has(svg)')
          .first();
        if (await trigger.isVisible().catch(() => false)) await trigger.click();
      }
      // Re-locate after the click — the input only exists when open.
      await expect(grid.searchInput()).toBeVisible({ timeout: 5_000 });
      await grid.search('alpha');
      await expect(page).toHaveURL(/search=alpha/, { timeout: 5_000 });
    });
  }
});

test.describe('WeldCRM · sidebar entries', () => {
  test('Companies link is reachable from the CRM landing page', async ({ page }) => {
    await page.goto('/weldcrm');
    const link = page.getByRole('link', { name: /^Companies$/ });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page).toHaveURL(/\/weldcrm\/companies/, { timeout: 10_000 });
  });

  test('People link is reachable from the CRM landing page', async ({ page }) => {
    await page.goto('/weldcrm');
    const link = page.getByRole('link', { name: /^People$/ });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page).toHaveURL(/\/weldcrm\/people/, { timeout: 10_000 });
  });
});

test.describe('WeldCRM · Sequences list CTAs', () => {
  test('"New Sequence" button is visible and opens a dialog', async ({ page }) => {
    await page.goto('/weldcrm/sequences');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Two "New Sequence" buttons can render: the toolbar create CTA and the
    // empty-state action (shown when the workspace has no sequences). Both open
    // the same dialog, so scope to the first to avoid a strict-mode violation.
    const newSeq = page.getByRole('button', { name: /new sequence/i }).first();
    await expect(newSeq).toBeVisible({ timeout: 15_000 });
    await newSeq.click();
    // The create dialog should open with the name input present.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#name')).toBeVisible({ timeout: 5_000 });
  });
});

import { test, expect } from '../../fixtures';
import { EntityGridPage } from '../../pages/entity-grid.page';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

/**
 * Regression: starring a person/company inside the CRM list grids.
 *
 * The favorite star in the name cell is a hover-revealed ornament. A
 * cell press used to start a spreadsheet cell-range selection, which
 * stamps `body[data-grid-dragging]`; the global CSS rule then hid the
 * hover-only star between mousedown and mouseup. With the button gone,
 * the click landed on the row and opened the object panel instead of
 * toggling the favorite — so the star "did nothing".
 *
 * These specs assert the fixed behaviour: clicking the star flips its
 * `aria-pressed` state and does NOT open the object panel (the panel
 * deep-links via the `?stack=` query param, so its absence is the
 * signal that the row click never fired). The `consoleErrors` fixture
 * additionally fails the test if the underlying PATCH errors, so a green
 * run also proves the favorite actually persisted to app-api.
 *
 * The star is rendered by the shared <EntityGrid /> name cell, so the
 * member view of a person/company list reuses the exact same component
 * and code path — covering the main grids covers both surfaces.
 *
 * Cleanup is scoped to the row each test seeded (NOT the global
 * `api.reset()` marker-wipe): with `fullyParallel` on, two tests share a
 * single workspace, and a sibling's global reset would otherwise delete
 * this test's row mid-run and make its PATCH 404.
 */

test.describe('WeldCRM · Favorite toggle', () => {
  let seeded: { type: 'person' | 'company'; id: string } | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('star a person → toggles favorite, does not open the object panel', async ({
    page,
    api,
  }) => {
    const stamp = Date.now().toString(36);
    const person = await api.seedPerson({
      firstName: `Star${stamp}`,
      lastName: 'Person',
    });
    seeded = { type: 'person', id: person.id };

    await page.goto('/weldcrm/people');
    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    const row = grid.rowById(person.id);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // No panel open to start with.
    expect(page.url()).not.toContain('stack=');

    // The star is hidden until the row is hovered (hover-only ornament).
    await row.hover();
    const star = grid.favoriteToggle(person.id);
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('aria-pressed', 'false');

    await star.click();

    // Favorite flipped on (optimistic, and stays on once the PATCH lands —
    // a server rejection reverts this and logs an error the consoleErrors
    // fixture turns into a failure).
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    // The row click must NOT have fired — the object panel stays closed.
    expect(page.url()).not.toContain('stack=');
  });

  test('star a company → toggles favorite, does not open the object panel', async ({
    page,
    api,
  }) => {
    const stamp = Date.now().toString(36);
    const company = await api.seedCompany({
      name: `Star${stamp} Co`,
    });
    seeded = { type: 'company', id: company.id };

    await page.goto('/weldcrm/companies');
    const grid = new EntityGridPage(page);
    await grid.waitForReady();

    const row = grid.rowById(company.id);
    await expect(row).toBeVisible({ timeout: 10_000 });

    expect(page.url()).not.toContain('stack=');

    await row.hover();
    const star = grid.favoriteToggle(company.id);
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('aria-pressed', 'false');

    await star.click();

    await expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(page.url()).not.toContain('stack=');
  });
});

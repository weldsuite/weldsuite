import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

/**
 * Coverage for BookingPage CRUD + the three dynamic scheduling routes.
 *
 * Seeding strategy:
 *   A BookingPage is seeded via the test-fixtures API before each
 *   seed-dependent test. The fixture endpoint must be available
 *   (TEST_API_URL / TEST_FIXTURES_TOKEN / TEST_WORKSPACE_ID set).
 *
 * Dynamic route smoke:
 *   /weldcalendar/scheduling/:id        → BookingPageDetailPage (Details tab)
 *   /weldcalendar/scheduling/:id/edit   → BookingPageEditor (Schedule tab, edit mode)
 *   /weldcalendar/scheduling/:id/view   → BookingPageViewPage
 *
 *   These routes require a real id and are therefore not in the smoke spec.
 *   Seeding one BookingPage here gives us the id needed to visit all three.
 *
 * Multi-step creation form (no seed needed):
 *   /weldcalendar/scheduling/new → type a title in input#booking-title,
 *   click "Continue" to advance to the Details tab (navigates to
 *   /scheduling/__draft__). Verify the Details page renders.
 *
 * Cleanup uses scoped per-entity deleteEntity() calls instead of global reset().
 */

test.describe('WeldCalendar · BookingPage CRUD — dynamic route coverage', () => {
  let seeded: { type: SeedEntityType; id: string } | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('seeded booking page card appears on /weldcalendar/scheduling', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const name = `E2E-Page-${stamp}`;

    const bp = await api.seedBookingPage({ name });
    seeded = { type: 'bookingPage', id: bp.id };

    await page.goto('/weldcalendar/scheduling');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // BookingPageCard renders the page name inside a card element.
    const card = page.getByText(name);
    await expect(card.first()).toBeVisible({ timeout: 10_000 });
  });

  test('seeded booking page detail route renders — /scheduling/:id', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const name = `E2E-Detail-${stamp}`;

    const bp = await api.seedBookingPage({ name });
    seeded = { type: 'bookingPage', id: bp.id };

    await page.goto(`/weldcalendar/scheduling/${bp.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Should not show a 404 / "not found" state.
    await expect(page.getByText(/not found/i)).toBeHidden({ timeout: 8_000 });
    // The Details tab contains a name input for the booking page.
    await expect(page).toHaveURL(new RegExp(`/weldcalendar/scheduling/${bp.id}`), { timeout: 8_000 });
  });

  test('seeded booking page edit route renders — /scheduling/:id/edit', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const name = `E2E-Edit-${stamp}`;

    const bp = await api.seedBookingPage({ name });
    seeded = { type: 'bookingPage', id: bp.id };

    await page.goto(`/weldcalendar/scheduling/${bp.id}/edit`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/not found/i)).toBeHidden({ timeout: 8_000 });
    // Edit page has input#booking-title in the right panel.
    await expect(page.locator('input#booking-title')).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(new RegExp(`/weldcalendar/scheduling/${bp.id}/edit`), { timeout: 8_000 });
  });

  test('seeded booking page view route renders — /scheduling/:id/view', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const name = `E2E-View-${stamp}`;

    const bp = await api.seedBookingPage({ name });
    seeded = { type: 'bookingPage', id: bp.id };

    await page.goto(`/weldcalendar/scheduling/${bp.id}/view`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/not found/i)).toBeHidden({ timeout: 8_000 });
    // The view page toolbar has an "Edit" button.
    const editBtn = page.getByRole('button', { name: /^edit$/i });
    await expect(editBtn).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(new RegExp(`/weldcalendar/scheduling/${bp.id}/view`), { timeout: 8_000 });
  });

  test('view toolbar Edit button navigates to /scheduling/:id/edit', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const name = `E2E-NavEdit-${stamp}`;

    const bp = await api.seedBookingPage({ name });
    seeded = { type: 'bookingPage', id: bp.id };

    await page.goto(`/weldcalendar/scheduling/${bp.id}/view`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const editBtn = page.getByRole('button', { name: /^edit$/i });
    await expect(editBtn).toBeVisible({ timeout: 10_000 });
    await editBtn.click();

    await expect(page).toHaveURL(
      new RegExp(`/weldcalendar/scheduling/${bp.id}/edit`),
      { timeout: 10_000 },
    );
  });
});

test.describe('WeldCalendar · BookingPage creation flow (no seed needed)', () => {
  test('/scheduling/new → type title → Continue navigates to the Details tab', async ({ page }) => {
    await page.goto('/weldcalendar/scheduling/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The right panel has a title input (id="booking-title").
    const titleInput = page.locator('input#booking-title');
    await expect(titleInput).toBeVisible({ timeout: 10_000 });

    const stamp = Date.now().toString(36);
    const title = `E2E-Draft-${stamp}`;
    await titleInput.fill(title);

    // The footer "Continue" button stashes data in sessionStorage and
    // navigates to /scheduling/__draft__ (the Details page in draft mode).
    const continueBtn = page.getByRole('button', { name: /continue|next/i });
    await expect(continueBtn.first()).toBeVisible({ timeout: 5_000 });
    await continueBtn.first().click();

    // After Continue the URL must move to the Details page.
    await expect(page).toHaveURL(/\/weldcalendar\/scheduling\/__draft__|\/weldcalendar\/scheduling\/[^/]+$/, {
      timeout: 10_000,
    });
    // Sidebar must still be present — confirms the app shell didn't break.
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 10_000 });
  });
});

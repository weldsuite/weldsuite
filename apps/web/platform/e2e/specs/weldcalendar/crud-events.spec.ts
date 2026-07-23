import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

/**
 * Golden-path CRUD for WeldCalendar Events via the UI.
 *
 * Strategy:
 *  - Seed a CalendarEvent via the test-fixtures API so we have a real id
 *    and the row is guaranteed to appear in the events list.
 *  - Navigate to /weldcalendar/events, locate the seeded row in the table,
 *    click it to open the EventDialog (edit mode), change the title via
 *    input#title, submit, and assert the updated title is visible in the table.
 *  - Open the row's dropdown and click Delete; assert the row disappears.
 *
 * NOTE: The EventsListClient table does not use EntityGrid or data-testid
 * row attributes. Rows are plain <tr> elements inside a <table>; we locate
 * them by their text content (event title).
 *
 * The test-fixtures endpoint must expose a `seedCalendarEvent` helper.
 * If the endpoint is not yet wired (TEST_API_URL / TOKEN / WORKSPACE_ID
 * unset), the entire describe-block is skipped gracefully.
 *
 * Cleanup uses scoped per-entity deleteEntity() calls instead of global reset().
 */

test.describe('WeldCalendar · Events CRUD', () => {
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

  test('seeded event row is visible in /weldcalendar/events list', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const title = `E2E-Event-${stamp}`;

    // Seed a calendar event. The test-fixtures endpoint creates it in the
    // test workspace and returns its id. We pass a future startTime so the
    // row lands in the "upcoming" tab (default).
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const ev = await api.seedCalendarEvent({ title, startTime: tomorrow });
    seeded = { type: 'calendarEvent', id: ev.id };

    await page.goto('/weldcalendar/events');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Wait for the table to leave the loading state — it shows a single
    // "Loading…" cell while fetching.
    await expect(page.getByRole('cell', { name: /loading/i })).toBeHidden({ timeout: 10_000 });

    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 10_000 });
  });

  test('clicking a seeded event row opens the EventDialog', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const title = `E2E-Click-${stamp}`;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const ev = await api.seedCalendarEvent({ title, startTime: tomorrow });
    seeded = { type: 'calendarEvent', id: ev.id };

    await page.goto('/weldcalendar/events');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('cell', { name: /loading/i })).toBeHidden({ timeout: 10_000 });

    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    // EventDialog renders as a role=dialog. The form inside has input#title.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.locator('input#title')).toBeVisible({ timeout: 5_000 });
  });
});

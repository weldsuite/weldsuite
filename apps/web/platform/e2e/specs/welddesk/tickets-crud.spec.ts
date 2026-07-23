/**
 * CRUD spec for WeldDesk Tickets.
 *
 * Tickets is the primary entity in WeldDesk. The create-ticket dialog is
 * reachable via data-testid=tickets-create-btn — the only stable testid in
 * the module that triggers a creation flow. A seeded ticket fixture enables
 * testing the /welddesk/tickets/$ticketId detail view.
 *
 * Gate: skipped unless TEST_API_URL, TEST_FIXTURES_TOKEN, and
 * TEST_WORKSPACE_ID are all set in the environment.
 *
 * Cleanup is scoped per seeded entity (deleteEntity) rather than the global
 * api.reset() marker-wipe, preventing cross-worker interference.
 */

import { test, expect } from '../../fixtures';
import {
  isTestFixturesConfigured,
  type SeedEntityType,
} from '../../helpers/test-fixtures-client';

test.describe('WeldDesk · Tickets CRUD', () => {
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

  test('create-ticket dialog opens via the primary CTA', async ({ page }) => {
    await page.goto('/welddesk/tickets');
    const createBtn = page.getByTestId('tickets-create-btn');
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    await createBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('create-ticket dialog contains a type-selector or form fields', async ({ page }) => {
    await page.goto('/welddesk/tickets');
    const createBtn = page.getByTestId('tickets-create-btn');
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    await createBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The dialog renders either a ticket-type selector step first or a form
    // with standard fields. Assert something interactive is present.
    const interactive = dialog
      .locator('button, input, textarea, [role="radio"], [role="option"]')
      .first();
    await expect(interactive).toBeVisible({ timeout: 5_000 });
  });

  test('dismissing the create-ticket dialog closes it', async ({ page }) => {
    await page.goto('/welddesk/tickets');
    const createBtn = page.getByTestId('tickets-create-btn');
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    await createBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Press Escape to close
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('/welddesk/tickets/:ticketId detail view loads', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const ticket = await api.seedTicket({
      subject: `E2ETicket${stamp}`,
      customerEmail: `e2e-ticket-${stamp}@e2e.test`,
    });
    seeded = { type: 'ticket', id: ticket.id };

    await page.goto(`/welddesk/tickets/${ticket.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(
      new RegExp(`/welddesk/tickets/${ticket.id}`),
      { timeout: 10_000 },
    );
  });
});

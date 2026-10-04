/**
 * Interaction spec for WeldCall.
 *
 * Each test navigates to a sub-page and asserts that the primary CTAs
 * are present. WeldCall is available on every plan, so the content must
 * render for any test workspace.
 *
 * WeldCallGate behaviour
 * ─────────────────────
 * Every WeldCall content page wraps its content in <WeldCallGate>, which
 * shows a loading spinner while the phone-number / VoIP-config queries
 * resolve and then renders the content.
 *
 * Dynamic route /weldcall/$callId
 * ────────────────────────────────
 * Covered by the seed-gated describe block at the bottom of this file.
 * Requires TEST_API_URL, TEST_FIXTURES_TOKEN, and TEST_WORKSPACE_ID to
 * be configured in .env.test (guarded by isTestFixturesConfigured()).
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

// ─── /weldcall/new ───────────────────────────────────────────────────────────

test.describe('WeldCall · /new — dialer hero', () => {
  test('page renders the app sidebar and the dialer hero', async ({ page }) => {
    await page.goto('/weldcall/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldcall/);

    // The "New call" dropdown trigger must be visible.
    await expect(
      page.getByRole('button', { name: /new call/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('"New call" button opens the dropdown with "Open dialer" item', async ({ page }) => {
    await page.goto('/weldcall/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const newCallBtn = page.getByRole('button', { name: /new call/i });
    await expect(newCallBtn).toBeVisible({ timeout: 10_000 });
    await newCallBtn.click();

    // Dropdown must show "Open dialer" and "View call history".
    await expect(page.getByRole('menuitem', { name: /open dialer/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('menuitem', { name: /view call history/i })).toBeVisible();
  });

  test('"View call history" dropdown item navigates to /weldcall/history', async ({ page }) => {
    await page.goto('/weldcall/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new call/i }).click();
    await page.getByRole('menuitem', { name: /view call history/i }).click();
    await expect(page).toHaveURL(/\/weldcall\/history/, { timeout: 10_000 });
  });

  test('phone number input accepts text and reveals the chevron submit button', async ({ page }) => {
    await page.goto('/weldcall/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const input = page.getByPlaceholder(/enter a phone number/i);
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Before typing the submit button is hidden (opacity-0 pointer-events-none).
    // After typing it must become interactive (opacity-100).
    await input.fill('+1 555 012 3456');

    // The ChevronRight submit button sits next to the input; it has no
    // accessible label so we scope to the input's parent container and
    // find the icon button that became clickable.
    const submitBtn = page
      .locator('.group\\/input')
      .getByRole('button')
      .first();
    // After fill the button transitions to opacity-100 — wait for it to be
    // reachable (not pointer-events-none).
    await expect(submitBtn).not.toHaveClass(/pointer-events-none/, { timeout: 3_000 });
  });
});

// ─── /weldcall/history ───────────────────────────────────────────────────────

test.describe('WeldCall · /history — call list', () => {
  test('page renders the app sidebar and the call list toolbar', async ({ page }) => {
    await page.goto('/weldcall/history');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldcall\/history/);

    // EntityList toolbar with "Make Call" button must render.
    await expect(
      page.getByRole('button', { name: /make call/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('"Make Call" button is present in the EntityList toolbar', async ({ page }) => {
    await page.goto('/weldcall/history');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole('button', { name: /make call/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('"Phone Settings" link is present and points to /settings/apps/phone-numbers', async ({ page }) => {
    await page.goto('/weldcall/history');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const settingsLink = page.getByRole('link', { name: /phone settings/i });
    await expect(settingsLink).toBeVisible({ timeout: 10_000 });
    await expect(settingsLink).toHaveAttribute('href', /phone-numbers/);
  });
});

// ─── /weldcall/contacts ──────────────────────────────────────────────────────

test.describe('WeldCall · /contacts — EntityGrid', () => {
  test('page renders the EntityGrid with the create button', async ({ page }) => {
    await page.goto('/weldcall/contacts');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/weldcall\/contacts/);

    // EntityGrid renders with a data-testid="entity-grid".
    await expect(page.getByTestId('entity-grid')).toBeVisible({ timeout: 10_000 });
    // The create button is stamped with data-testid="entity-grid-create-btn".
    await expect(page.getByTestId('entity-grid-create-btn')).toBeVisible({ timeout: 10_000 });
  });

  test('EntityGrid displays the sample contacts (Name column header visible)', async ({ page }) => {
    await page.goto('/weldcall/contacts');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('entity-grid')).toBeVisible({ timeout: 10_000 });
    // The grid is seeded with hard-coded sample contacts — at least one row should render.
    await expect(page.getByTestId('entity-grid-row').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── /weldcall/$callId ───────────────────────────────────────────────────────

test.describe('WeldCall · /$callId — call detail', () => {
  let seeded: { type: 'voip-call'; id: string } | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('seeded call detail page renders the MeetingIntelligence panel with History breadcrumb', async ({ page, api }) => {
    const call = await api.seedVoipCall({
      direction: 'outbound',
      status: 'completed',
      fromNumber: '+12025550001',
      toNumber: '+12025550002',
    });
    seeded = { type: 'voip-call', id: call.id };

    await page.goto(`/weldcall/${call.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The MeetingIntelligence panel renders a breadcrumb "History" link
    // pointing back to /weldcall/history.
    const historyLink = page.getByRole('link', { name: /history/i });
    await expect(historyLink).toBeVisible({ timeout: 15_000 });
    await expect(historyLink).toHaveAttribute('href', /\/weldcall\/history/);
  });
});

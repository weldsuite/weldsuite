/**
 * Interaction spec for WeldCalendar (Calendar + scheduling).
 *
 * Covers:
 *  - New Event button on /weldcalendar is visible and opens the quick-create
 *    card overlay.
 *  - New Event button on /weldcalendar/events is visible and opens the
 *    NewEventDialog overlay.
 *  - View-switcher Select on /weldcalendar is visible (proves toolbar rendered).
 *  - New Booking Page button on /weldcalendar/scheduling is visible.
 *  - Continue footer button on /weldcalendar/scheduling/new is visible.
 *  - Cancel footer button on /weldcalendar/scheduling/new is visible.
 *
 * None of these CTAs carry data-testid attributes; selectors rely on
 * role+name, stable HTML id attributes, or aria-label text.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldCalendar · calendar view interactions', () => {
  test('/weldcalendar New Event button is visible', async ({ page }) => {
    await page.goto('/weldcalendar');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The toolbar "New Event" button sits in the CalendarView header.
    const btn = page.getByRole('button', { name: /new event/i });
    await expect(btn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('/weldcalendar New Event button opens the quick-create overlay', async ({ page }) => {
    await page.goto('/weldcalendar');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /new event/i });
    await btn.first().click();

    // QuickCreateCard renders inside a fixed-position popover / overlay.
    // The title input uses placeholder "Add a title" (no id attribute).
    const titleInput = page.getByPlaceholder(/add a title/i);
    await expect(titleInput.first()).toBeVisible({ timeout: 8_000 });
  });

  test('/weldcalendar view-switcher Select is visible', async ({ page }) => {
    await page.goto('/weldcalendar');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The view-switcher is a <Select> rendered in the toolbar on md+ viewports.
    // SelectTrigger renders as role=combobox with the current view label.
    const viewSelect = page.getByRole('combobox').filter({ hasText: /month|week|day|agenda/i });
    await expect(viewSelect.first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('WeldCalendar · events list interactions', () => {
  test('/weldcalendar/events New Event button is visible', async ({ page }) => {
    await page.goto('/weldcalendar/events');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /new event/i });
    await expect(btn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('/weldcalendar/events New Event button opens the NewEventDialog overlay', async ({ page }) => {
    await page.goto('/weldcalendar/events');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /new event/i });
    await btn.first().click();

    // NewEventDialog wraps QuickCreateCard inside a fixed-position overlay.
    // QuickCreateCard renders a title input with placeholder "Add a title".
    const titleInput = page.getByPlaceholder(/add a title/i);
    await expect(titleInput.first()).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('WeldCalendar · scheduling interactions', () => {
  test('/weldcalendar/scheduling New Booking Page button is visible', async ({ page }) => {
    await page.goto('/weldcalendar/scheduling');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Both the header button and the empty-state button share the same text.
    const btn = page.getByRole('button', { name: /new booking page/i });
    await expect(btn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('/weldcalendar/scheduling/new Continue footer button is visible', async ({ page }) => {
    await page.goto('/weldcalendar/scheduling/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // Footer contains "Continue" (create mode) or "Next" (edit mode).
    const btn = page.getByRole('button', { name: /continue|next/i });
    await expect(btn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('/weldcalendar/scheduling/new Cancel footer button is visible', async ({ page }) => {
    await page.goto('/weldcalendar/scheduling/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /^cancel$/i });
    await expect(btn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('/weldcalendar/scheduling/new booking-title input is visible', async ({ page }) => {
    await page.goto('/weldcalendar/scheduling/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The right-panel has a title input with id="booking-title".
    const titleInput = page.locator('input#booking-title');
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
  });
});

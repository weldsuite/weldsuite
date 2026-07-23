/**
 * Meeting-info load + terminal error screens (no join attempt needed).
 *
 * On mount the guest client fetches /api/meeting/info and, based on the result,
 * either shows the landing screen or a terminal error.
 */

import { test, expect } from '@playwright/test';
import {
  MEETING_PATH,
  meetingInfo,
  mockMeetingInfo,
  mockMeetingInfoError,
} from '../helpers/mock-meeting-api';

test.describe('Meeting portal · meeting info', () => {
  test('shows a loading state while meeting info is in flight', async ({ page }) => {
    // Delay the info response so the LoadingScreen is observable.
    await page.route('**/api/meeting/info**', async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: meetingInfo() }),
      });
    });

    await page.goto(MEETING_PATH);
    await expect(page.getByText('Loading meeting...')).toBeVisible();
    // ...and it resolves into the landing screen.
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({ timeout: 15_000 });
  });

  test('cancelled meeting shows the "cancelled" error screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ status: 'cancelled' }));
    await page.goto(MEETING_PATH);

    await expect(page.getByText('Unable to join')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/this meeting has been cancelled/i)).toBeVisible();
    // No join form on a terminal error.
    await expect(page.getByRole('button', { name: /join now/i })).toHaveCount(0);
  });

  test('completed meeting shows the "already ended" error screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ status: 'completed' }));
    await page.goto(MEETING_PATH);

    await expect(page.getByText('Unable to join')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/this meeting has already ended/i)).toBeVisible();
  });

  test('a failed info request shows an error screen', async ({ page }) => {
    await mockMeetingInfoError(page, 404, 'Meeting not found');
    await page.goto(MEETING_PATH);

    await expect(page.getByText('Unable to join')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/meeting not found/i)).toBeVisible();
  });
});

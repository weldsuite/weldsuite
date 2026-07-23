/**
 * Landing screen — meeting summary, pre-join media controls, and the
 * name/email join form (react-hook-form + zod, validated onChange).
 */

import { test, expect } from '@playwright/test';
import {
  MEETING_PATH,
  meetingInfo,
  mockMeetingInfo,
  fillGuestForm,
} from '../helpers/mock-meeting-api';

test.describe('Meeting portal · landing', () => {
  test.beforeEach(async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ title: 'Quarterly Review' }));
    await page.goto(MEETING_PATH);
  });

  test('renders the meeting title, organizer, and a sign-in link', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Quarterly Review' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Dana Host')).toBeVisible();
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
  });

  test('shows editable name + email fields', async ({ page }) => {
    const name = page.locator('#guest-name');
    const email = page.locator('#guest-email');
    await expect(name).toBeVisible({ timeout: 15_000 });
    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute('type', 'email');
    await name.fill('Casey');
    await expect(name).toHaveValue('Casey');
  });

  test('the Join button is disabled until the form is valid', async ({ page }) => {
    const join = page.getByRole('button', { name: /join now/i });
    await expect(join).toBeVisible({ timeout: 15_000 });

    // Empty form → disabled.
    await expect(join).toBeDisabled();

    // Name only → still disabled (email required).
    await page.locator('#guest-name').fill('Casey Guest');
    await expect(join).toBeDisabled();

    // Invalid email → still disabled.
    await page.locator('#guest-email').fill('not-an-email');
    await expect(join).toBeDisabled();

    // Valid name + email → enabled.
    await page.locator('#guest-email').fill('casey@example.com');
    await expect(join).toBeEnabled();
  });

  test('clearing a valid email re-disables the Join button', async ({ page }) => {
    const join = page.getByRole('button', { name: /join now/i });
    await fillGuestForm(page);
    await expect(join).toBeEnabled({ timeout: 15_000 });

    await page.locator('#guest-email').fill('');
    await expect(join).toBeDisabled();
  });
});

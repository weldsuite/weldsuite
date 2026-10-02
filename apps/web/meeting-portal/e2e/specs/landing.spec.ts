/**
 * Landing screen — meeting summary, pre-join media controls, and the
 * name/email join form (react-hook-form + zod, validated onChange).
 */

import { test, expect } from '@playwright/test';
import {
  MEETING_PATH,
  meetingInfo,
  joinResult,
  mockMeetingInfo,
  mockJoin,
  mockLeave,
  fillGuestForm,
} from '../helpers/mock-meeting-api';

const IDENTITY_KEY = 'weldmeet:guest-identity';

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

test.describe('Meeting portal · landing · remembered identity', () => {
  test('prefills name + email from a previous visit and "Not you?" clears them', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo());
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [IDENTITY_KEY, JSON.stringify({ name: 'Casey Guest', email: 'casey@example.com' })],
    );
    await page.goto(MEETING_PATH);

    await expect(page.locator('#guest-name')).toHaveValue('Casey Guest', { timeout: 15_000 });
    await expect(page.locator('#guest-email')).toHaveValue('casey@example.com');
    // The restored details are valid, so the guest can join straight away.
    await expect(page.getByRole('button', { name: /join now/i })).toBeEnabled();

    await page.getByRole('button', { name: /not you?/i }).click();

    await expect(page.locator('#guest-name')).toHaveValue('');
    await expect(page.locator('#guest-email')).toHaveValue('');
    await expect(page.getByRole('button', { name: /not you?/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /join now/i })).toBeDisabled();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), IDENTITY_KEY)).toBeNull();
  });

  test('a fresh visitor sees an empty form and no "Not you?" link', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo());
    await page.goto(MEETING_PATH);

    await expect(page.locator('#guest-name')).toHaveValue('', { timeout: 15_000 });
    await expect(page.getByRole('button', { name: /not you?/i })).toHaveCount(0);
  });

  test('ignores a malformed stored identity', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo());
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [IDENTITY_KEY, '{"name": 42'],
    );
    await page.goto(MEETING_PATH);

    await expect(page.locator('#guest-name')).toHaveValue('', { timeout: 15_000 });
    await expect(page.getByRole('button', { name: /not you?/i })).toHaveCount(0);
  });

  test('submitting the join form remembers the details for next time', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ hasActiveSession: false }));
    await mockJoin(page, joinResult({ status: 'waiting' }));
    await mockLeave(page);
    await page.goto(MEETING_PATH);

    await fillGuestForm(page, 'Casey Guest', 'casey@example.com');
    const join = page.getByRole('button', { name: /join now/i });
    await expect(join).toBeEnabled({ timeout: 15_000 });
    await join.click();
    await expect(page.getByText(/waiting for the host to start/i)).toBeVisible({ timeout: 15_000 });

    const stored = await page.evaluate((key) => window.localStorage.getItem(key), IDENTITY_KEY);
    expect(JSON.parse(stored ?? 'null')).toEqual({ name: 'Casey Guest', email: 'casey@example.com' });
  });
});

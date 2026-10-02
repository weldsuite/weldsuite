/**
 * Join flow — every branch of the guest state machine after submitting the
 * landing form. Drives /api/meeting/join (+ waitlist polling) via mocks so each
 * server-decided outcome is deterministic.
 *
 *   waiting               → "Waiting for the host to start..."
 *   waitlisted → admitted → re-join → connects
 *   waitlisted → denied   → "Entry denied"
 *   host_must_join_first  → waiting
 *   ended                 → "You left the meeting" (terminal)
 *   removed               → "You were removed from the meeting" (terminal, no Rejoin)
 *   joined                → leaves the form and attempts to connect
 */

import { test, expect } from '@playwright/test';
import {
  MEETING_PATH,
  SESSION_ID,
  meetingInfo,
  joinResult,
  mockMeetingInfo,
  mockJoin,
  mockWaitlistStatus,
  mockLeave,
  fillGuestForm,
} from '../helpers/mock-meeting-api';

async function landAndSubmit(page: import('@playwright/test').Page) {
  await page.goto(MEETING_PATH);
  await fillGuestForm(page);
  const join = page.getByRole('button', { name: /join now/i });
  await expect(join).toBeEnabled({ timeout: 15_000 });
  await join.click();
}

test.describe('Meeting portal · join flow', () => {
  test('status "waiting" shows the waiting-for-host screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ hasActiveSession: false }));
    await mockJoin(page, joinResult({ status: 'waiting' }));
    await mockLeave(page);

    await landAndSubmit(page);

    await expect(page.getByText(/waiting for the host to start/i)).toBeVisible({ timeout: 15_000 });
  });

  test('host_must_join_first also lands on the waiting screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ hasActiveSession: false }));
    await mockJoin(page, joinResult({ status: 'waiting', reason: 'host_must_join_first' }));
    await mockLeave(page);

    await landAndSubmit(page);

    await expect(page.getByText(/waiting for the host to start/i)).toBeVisible({ timeout: 15_000 });
  });

  test('waiting room: shows the lobby screen, then connects once admitted', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ waitingRoom: true }));
    // First join → waitlisted; the post-admit re-join → joined (with a token).
    await mockJoin(page, (call) =>
      call === 0
        ? joinResult({ status: 'waitlisted', waitlistId: 'mwl_1' })
        : joinResult({ status: 'joined', sessionId: SESSION_ID, authToken: 'fake-rtk-token' }),
    );
    await mockWaitlistStatus(page, ['pending', 'admitted']);
    await mockLeave(page);

    await landAndSubmit(page);

    // Lobby screen while pending.
    await expect(page.getByText(/waiting for the host to let you in/i)).toBeVisible({ timeout: 15_000 });

    // Once admitted, it re-joins and attempts the RTK connection — the lobby
    // text goes away and the connecting/connection-error UI takes over.
    await expect(page.getByText(/waiting for the host to let you in/i)).toBeHidden({ timeout: 15_000 });
  });

  test('waiting room: denied entry shows the "Entry denied" screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ waitingRoom: true }));
    await mockJoin(page, joinResult({ status: 'waitlisted', waitlistId: 'mwl_2' }));
    await mockWaitlistStatus(page, ['pending', 'denied']);
    await mockLeave(page);

    await landAndSubmit(page);

    await expect(page.getByText(/waiting for the host to let you in/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Entry denied')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/did not admit you/i)).toBeVisible();
  });

  test('status "ended" shows the "already ended" error screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo());
    await mockJoin(page, joinResult({ status: 'ended' }));
    await mockLeave(page);

    await landAndSubmit(page);

    await expect(page.getByText('Unable to join')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/this meeting has already ended/i)).toBeVisible();
  });

  test('status "removed" shows the removed screen with no Rejoin and stops polling', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo());
    const join = await mockJoin(page, joinResult({ status: 'removed' }));
    await mockLeave(page);

    await landAndSubmit(page);

    await expect(page.getByText('You were removed from the meeting')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/the host removed you from this call/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /rejoin/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /return to home screen/i })).toBeVisible();

    // Terminal: nothing keeps hitting /join (the waiting screen polls every few
    // seconds), so the count stays at the single submit.
    const callsAfterScreen = join.callCount();
    await page.waitForTimeout(3_000);
    expect(join.callCount()).toBe(callsAfterScreen);
    expect(callsAfterScreen).toBe(1);
  });

  test('a polled re-join that comes back "removed" stops polling on the removed screen', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo({ hasActiveSession: false }));
    // First attempt waits for the host; the host removes the guest before the
    // session starts being joinable, so the next poll is refused.
    const join = await mockJoin(page, (call) =>
      call === 0 ? joinResult({ status: 'waiting' }) : joinResult({ status: 'removed' }),
    );
    await mockLeave(page);

    await landAndSubmit(page);

    await expect(page.getByText(/waiting for the host to start/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('You were removed from the meeting')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /rejoin/i })).toHaveCount(0);

    const callsAfterScreen = join.callCount();
    await page.waitForTimeout(6_000);
    expect(join.callCount()).toBe(callsAfterScreen);
  });

  test('status "joined" leaves the form and attempts to connect', async ({ page }) => {
    await mockMeetingInfo(page, meetingInfo());
    await mockJoin(page, joinResult({ status: 'joined', sessionId: SESSION_ID, authToken: 'fake-rtk-token' }));
    await mockLeave(page);

    await landAndSubmit(page);

    // A real RTK connection can't be established in e2e (fake token), but the
    // client leaves the landing form and shows connecting → connection-error.
    // Either is proof the join was accepted and the in-call handoff began.
    await expect(page.getByText(/connecting\.\.\.|unable to join/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /join now/i })).toHaveCount(0);
  });
});

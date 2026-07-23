/**
 * Mocks for the meeting-portal's `/api/meeting/*` routes.
 *
 * These routes need a tenant DB + RealtimeKit, so e2e stubs them with
 * `page.route`. Helpers return fully-formed payloads that satisfy the Zod
 * schemas the client parses (lib/schemas.ts) — keep them in sync if the
 * schemas change.
 */

import type { Page, Route } from '@playwright/test';

export const ORG_ID = 'org_e2e';
export const JOIN_CODE = 'wm-abc-def-ghi';
export const MEETING_ID = 'meet_e2e123';
export const SESSION_ID = 'msess_e2e123';
/** Route the guest portal page lives at: /[orgId]/[joinCode]. */
export const MEETING_PATH = `/${ORG_ID}/${JOIN_CODE}`;

export interface MeetingInfo {
  id: string;
  title: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  meetingType: string;
  status: string;
  accessType: string;
  organizerName: string;
  hasActiveSession: boolean;
  attendees?: { name: string; avatar?: string; role: string }[];
  waitingRoom?: boolean;
}

export function meetingInfo(overrides: Partial<MeetingInfo> = {}): MeetingInfo {
  return {
    id: MEETING_ID,
    title: 'E2E Strategy Sync',
    scheduledStart: null,
    scheduledEnd: null,
    meetingType: 'video',
    status: 'in_progress',
    accessType: 'anyone_with_link',
    organizerName: 'Dana Host',
    hasActiveSession: true,
    attendees: [{ name: 'Dana Host', role: 'organizer' }],
    waitingRoom: false,
    ...overrides,
  };
}

export type JoinResult = {
  status: 'joined' | 'waiting' | 'waitlisted' | 'ended';
  sessionId?: string;
  authToken?: string;
  meetingId: string;
  meetingTitle: string;
  waitlistId?: string;
  reason?: string;
};

export function joinResult(overrides: Partial<JoinResult> = {}): JoinResult {
  return {
    status: 'waiting',
    meetingId: MEETING_ID,
    meetingTitle: 'E2E Strategy Sync',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Route mocks
// ---------------------------------------------------------------------------

/** GET /api/meeting/info → { data: MeetingInfo }. */
export async function mockMeetingInfo(page: Page, info: MeetingInfo = meetingInfo()) {
  await page.route('**/api/meeting/info**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: info }) }),
  );
}

/** GET /api/meeting/info → error (e.g. 404 / 500). */
export async function mockMeetingInfoError(page: Page, status = 404, message = 'Meeting not found') {
  await page.route('**/api/meeting/info**', (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { message } }) }),
  );
}

/**
 * POST /api/meeting/join → { data: JoinResult }.
 * Pass a single result, or a function of the call index for multi-step flows
 * (e.g. waitlisted on first call, joined on a later retry).
 */
export async function mockJoin(
  page: Page,
  resultOrFn: JoinResult | ((callIndex: number) => JoinResult),
) {
  let calls = 0;
  await page.route('**/api/meeting/join', (route: Route) => {
    const result = typeof resultOrFn === 'function' ? resultOrFn(calls) : resultOrFn;
    calls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: result }) });
  });
}

/**
 * GET /api/meeting/:id/waitlist-status → { data: { status } }.
 * `statuses` is consumed one-per-poll; the last value sticks.
 */
export async function mockWaitlistStatus(page: Page, statuses: Array<'pending' | 'admitted' | 'denied'>) {
  let i = 0;
  await page.route('**/api/meeting/*/waitlist-status**', (route: Route) => {
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 'pending';
    i += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { status } }) });
  });
}

/** POST /api/meeting/leave → 200 (best-effort, body ignored by the client). */
export async function mockLeave(page: Page) {
  await page.route('**/api/meeting/leave', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true } }) }),
  );
}

/** Convenience: wire info + join + leave (+ optional waitlist) in one call. */
export async function setupMeetingMocks(
  page: Page,
  opts: {
    info?: MeetingInfo;
    join?: JoinResult | ((callIndex: number) => JoinResult);
    waitlist?: Array<'pending' | 'admitted' | 'denied'>;
  } = {},
) {
  await mockMeetingInfo(page, opts.info ?? meetingInfo());
  if (opts.join) await mockJoin(page, opts.join);
  if (opts.waitlist) await mockWaitlistStatus(page, opts.waitlist);
  await mockLeave(page);
}

/** Fill the landing form's name + email. */
export async function fillGuestForm(page: Page, name = 'Casey Guest', email = 'casey@example.com') {
  await page.locator('#guest-name').fill(name);
  await page.locator('#guest-email').fill(email);
}

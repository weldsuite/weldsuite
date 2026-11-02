/**
 * /api/calendar-events: time-range + timezone validation, nullable updates,
 * external attendees, attendee diff mails, reschedule notifications, search.
 * Mail is observed on a `SEND_EMAIL` stub, which the conformance harness
 * compares with the Rust backend's sends.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarEventsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { readSent, type SentMail } from '../../test/sent-mail';

/** The `SEND_EMAIL` binding the routes send through. */
const mail = { stub: createSendEmailStub() };

const MEETING_URL = 'https://meet.weldsuite.org/acme/wm-dip-zfz-ubv';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => {
  mail.stub = createSendEmailStub();
});

/** Everything sent since the last reset, as the assertions read it. */
const sentMails = (): SentMail[] => readSent(mail.stub);

/** Start counting mail afresh. */
function resetMail(): void {
  mail.stub = createSendEmailStub();
}

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

async function seedCalendar(ownerId: string): Promise<string> {
  const id = generateId('cal');
  const now = new Date();
  await db.insert(schema.calendars).values({
    id,
    name: `${ownerId} calendar`,
    ownerId,
    isDefault: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function api(userId: string) {
  return createTestApp('/api/calendar-events', calendarEventsRoutes, {
    context: {
      permissions: permissions('events:read', 'events:create', 'events:update', 'events:delete'),
      userId,
      tenantDb: db,
    },
    env: { ENVIRONMENT: 'production', SEND_EMAIL: mail.stub as never },
  }).request;
}

async function send(userId: string, method: string, path: string, body?: unknown) {
  return api(userId)(`/api/calendar-events${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function eventRow(id: string) {
  const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
  return row!;
}

/** Create an event through the route and return its id. */
async function createEvent(userId: string, extra: Record<string, unknown> = {}) {
  const calendarId = await seedCalendar(userId);
  const res = await send(userId, 'POST', '', {
    calendarId,
    title: 'Planning',
    startTime: '2030-03-01T10:00:00.000Z',
    endTime: '2030-03-01T11:00:00.000Z',
    ...extra,
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  return { id, calendarId };
}

/** Let fire-and-forget mail settle, then return everything sent. */
async function settle(): Promise<SentMail[]> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return sentMails();
}

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

describe('time range validation', () => {
  it('POST rejects endTime before startTime (TASK-722 repro)', async () => {
    const userId = `user_range_${next()}`;
    const calendarId = await seedCalendar(userId);
    const res = await send(userId, 'POST', '', {
      calendarId,
      title: 'Backwards',
      startTime: '2026-10-01T21:00:00.000Z',
      endTime: '2026-09-30T22:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect((await errorCode(res)).code).toBe('BAD_REQUEST');
  });

  it('POST rejects endTime equal to startTime, but allows it for an all-day event', async () => {
    const userId = `user_range_eq_${next()}`;
    const calendarId = await seedCalendar(userId);
    const same = { startTime: '2030-05-01T00:00:00.000Z', endTime: '2030-05-01T00:00:00.000Z' };

    const timed = await send(userId, 'POST', '', { calendarId, title: 'Zero length', ...same });
    expect(timed.status).toBe(400);

    const allDay = await send(userId, 'POST', '', { calendarId, title: 'All day', allDay: true, ...same });
    expect(allDay.status).toBe(201);
  });

  it('POST rejects an unparseable startTime instead of failing at the DB', async () => {
    const userId = `user_range_bad_${next()}`;
    const calendarId = await seedCalendar(userId);
    const res = await send(userId, 'POST', '', { calendarId, title: 'x', startTime: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('PATCH with only startTime compares against the stored endTime', async () => {
    const userId = `user_range_p1_${next()}`;
    const { id } = await createEvent(userId);
    const res = await send(userId, 'PATCH', `/${id}`, { startTime: '2030-03-01T12:00:00.000Z' });
    expect(res.status).toBe(400);
    expect((await eventRow(id)).startTime.toISOString()).toBe('2030-03-01T10:00:00.000Z');
  });

  it('PATCH with only endTime compares against the stored startTime', async () => {
    const userId = `user_range_p2_${next()}`;
    const { id } = await createEvent(userId);
    expect((await send(userId, 'PATCH', `/${id}`, { endTime: '2030-03-01T09:00:00.000Z' })).status).toBe(400);
    expect((await send(userId, 'PATCH', `/${id}`, { endTime: '2030-03-01T12:00:00.000Z' })).status).toBe(200);
  });

  it('PATCH that touches neither time is not blocked by a legacy backwards event', async () => {
    const userId = `user_range_legacy_${next()}`;
    const calendarId = await seedCalendar(userId);
    const id = generateId('evt');
    await db.insert(schema.calendarEvents).values({
      id,
      calendarId,
      organizerId: userId,
      title: 'Legacy',
      type: 'meeting',
      startTime: new Date('2026-10-01T21:00:00Z'),
      endTime: new Date('2026-09-30T22:00:00Z'),
    });
    expect((await send(userId, 'PATCH', `/${id}`, { title: 'Renamed' })).status).toBe(200);
  });

  it('PATCH /:id/reschedule rejects end <= start, also against the stored end', async () => {
    const userId = `user_range_r_${next()}`;
    const { id } = await createEvent(userId);
    const bothWrong = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-03-02T10:00:00.000Z',
      endTime: '2030-03-02T10:00:00.000Z',
    });
    expect(bothWrong.status).toBe(400);
    const againstStored = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-03-05T10:00:00.000Z',
    });
    expect(againstStored.status).toBe(400);
    const ok = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-03-05T10:00:00.000Z',
      endTime: '2030-03-05T11:00:00.000Z',
    });
    expect(ok.status).toBe(200);
  });
});

describe('timezone', () => {
  it('POST and PATCH accept and store an IANA timezone', async () => {
    const userId = `user_tz_${next()}`;
    const { id } = await createEvent(userId, { timezone: 'Europe/Amsterdam' });
    expect((await eventRow(id)).timezone).toBe('Europe/Amsterdam');

    expect((await send(userId, 'PATCH', `/${id}`, { timezone: 'America/New_York' })).status).toBe(200);
    expect((await eventRow(id)).timezone).toBe('America/New_York');
  });

  it('rejects an invalid or over-long timezone', async () => {
    const userId = `user_tz_bad_${next()}`;
    const calendarId = await seedCalendar(userId);
    const body = { calendarId, title: 'x', startTime: '2030-03-01T10:00:00.000Z' };
    expect((await send(userId, 'POST', '', { ...body, timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await send(userId, 'POST', '', { ...body, timezone: 'Europe/' + 'a'.repeat(60) })).status).toBe(400);
    const { id } = await createEvent(userId);
    expect((await send(userId, 'PATCH', `/${id}`, { timezone: 'nope' })).status).toBe(400);
  });

  it('mails render in the event timezone', async () => {
    const userId = `user_tz_mail_${next()}`;
    await createEvent(userId, {
      timezone: 'Europe/Amsterdam',
      startTime: '2026-10-01T21:00:00.000Z',
      endTime: '2026-10-01T22:00:00.000Z',
      attendees: [{ email: 'guest@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].html).toContain('11:00 PM GMT+2');
  });

  it('falls back to the organizer\'s preferred timezone when the event has none', async () => {
    const userId = `user_tz_pref_${next()}`;
    await db.insert(schema.userPreferences).values({ id: generateId('upref'), userId, timezone: 'Asia/Tokyo' });
    await createEvent(userId, {
      startTime: '2026-10-01T21:00:00.000Z',
      endTime: '2026-10-01T22:00:00.000Z',
      attendees: [{ email: 'guest@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    // The zone is written once, at the end of the range.
    expect(sentMails()[0].html).toContain('6:00 AM – 7:00 AM GMT+9');
  });
});

describe('nullable update fields', () => {
  it('PATCH accepts null for tags, attendees, location, description, customerId, contactId, meetingUrl', async () => {
    const userId = `user_null_${next()}`;
    const { id } = await createEvent(userId, {
      tags: ['a'],
      attendees: [{ email: 'a@example.com' }],
      location: 'Office',
      description: 'desc',
      customerId: 'cust_1',
      contactId: 'cont_1',
      meetingUrl: MEETING_URL,
      isVirtual: true,
    });
    const res = await send(userId, 'PATCH', `/${id}`, {
      tags: null,
      attendees: null,
      location: null,
      description: null,
      customerId: null,
      contactId: null,
      meetingUrl: null,
    });
    expect(res.status).toBe(200);
    const row = await eventRow(id);
    expect(row.tags).toBeNull();
    expect(row.attendees).toBeNull();
    expect(row.location).toBeNull();
    expect(row.description).toBeNull();
    expect(row.customerId).toBeNull();
    expect(row.contactId).toBeNull();
    expect(row.meetingUrl).toBeNull();
    // Creation queued an invite for a@example.com; drain it so it can't land
    // in the next test's `sent` (fire-and-forget via waitUntil).
    await settle();
  });
});

describe('attendees', () => {
  it('accepts an external attendee with just { email, name? } and mails it the invite with the join link', async () => {
    const userId = `user_ext_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      isVirtual: true,
      attendees: [{ email: 'Guest@Example.com', name: 'Guest' }, { email: 'bare@example.com' }],
    });
    expect((await eventRow(id)).attendees).toEqual([
      { email: 'Guest@Example.com', name: 'Guest' },
      { email: 'bare@example.com' },
    ]);

    await vi.waitFor(() => expect(sentMails()).toHaveLength(2));
    for (const mail of sentMails()) {
      expect(mail.subject).toBe('Invitation: Planning');
      expect(mail.html).toContain(`href="${MEETING_URL}"`);
      // Not workspace members: nothing that leads to the authenticated app.
      expect(mail.html).not.toContain('/weldcalendar');
      expect(mail.attachments[0].content).toContain('METHOD:REQUEST');
    }
  });

  it('a workspace member gets the app link next to the join link', async () => {
    const userId = `user_member_org_${next()}`;
    const memberEmail = `member_${next()}@acme.com`;
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'),
      userId: `user_member_${next()}`,
      email: memberEmail,
      name: 'Member',
    });
    await createEvent(userId, {
      meetingUrl: MEETING_URL,
      attendees: [{ email: memberEmail.toUpperCase() }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].html).toContain(`href="${MEETING_URL}"`);
    expect(sentMails()[0].html).toContain('https://app.weldsuite.org/w/org_test_default/weldcalendar');
  });

  it('rejects an invalid attendee email and ignores unknown keys', async () => {
    const userId = `user_att_bad_${next()}`;
    const calendarId = await seedCalendar(userId);
    const base = { calendarId, title: 'x', startTime: '2030-03-01T10:00:00.000Z' };
    expect((await send(userId, 'POST', '', { ...base, attendees: [{ email: 'not-an-email' }] })).status).toBe(400);

    const res = await send(userId, 'POST', '', {
      ...base,
      attendees: [{ email: 'ok@example.com', type: 'external', id: 'email-ok@example.com', name: null }],
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    expect((await eventRow(id)).attendees).toEqual([{ email: 'ok@example.com' }]);
    // Creation queued an invite for ok@example.com; drain it so it can't land
    // in the next test's `sent` (fire-and-forget via waitUntil).
    await settle();
  });

  it('collapses duplicate attendee emails so nobody is invited twice', async () => {
    const userId = `user_att_dup_${next()}`;
    await createEvent(userId, { attendees: [{ email: 'dup@example.com' }, { email: 'DUP@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(await settle()).toHaveLength(1);
  });

  it('PATCH diff: added attendees are invited, removed ones are sent a cancellation, others untouched', async () => {
    const userId = `user_diff_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      attendees: [{ email: 'stay@example.com' }, { email: 'gone@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(2));
    resetMail();

    const res = await send(userId, 'PATCH', `/${id}?sendNotification=true`, {
      attendees: [{ email: 'stay@example.com' }, { email: 'new@example.com', name: 'New' }],
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(sentMails()).toHaveLength(2));
    const bySubject = Object.fromEntries(sentMails().map((m) => [m.subject, m]));
    expect(bySubject['Invitation: Planning'].to).toEqual(['new@example.com']);
    expect(bySubject['Invitation: Planning'].html).toContain(`href="${MEETING_URL}"`);
    // The guest who was taken off is told so; the event itself is not cancelled.
    expect(bySubject['Cancelled: Planning']).toBeUndefined();
    const removed = bySubject['You were removed from: Planning'];
    expect(removed.to).toEqual(['gone@example.com']);
    expect(removed.html).toContain('removed you from an event');
    expect(removed.html).not.toContain('has cancelled an event');
    expect(removed.html).not.toContain(MEETING_URL);
    expect(removed.attachments[0].content).toContain('METHOD:CANCEL');
    expect(await settle()).toHaveLength(2);
  });

  it('PATCH without sendNotification stores the attendees but mails nobody', async () => {
    const userId = `user_diff_quiet_${next()}`;
    const { id } = await createEvent(userId);
    const res = await send(userId, 'PATCH', `/${id}`, { attendees: [{ email: 'quiet@example.com' }] });
    expect(res.status).toBe(200);
    expect((await eventRow(id)).attendees).toEqual([{ email: 'quiet@example.com' }]);
    expect(await settle()).toHaveLength(0);
  });

  it('PATCH time change mails retained attendees a reschedule, added ones only the invite', async () => {
    const userId = `user_diff_move_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'stay@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    await send(userId, 'PATCH', `/${id}?sendNotification=true`, {
      startTime: '2030-03-02T10:00:00.000Z',
      endTime: '2030-03-02T11:00:00.000Z',
      attendees: [{ email: 'stay@example.com' }, { email: 'new@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(2));
    const bySubject = Object.fromEntries(sentMails().map((m) => [m.subject, m.to[0]]));
    expect(bySubject['Rescheduled: Planning']).toBe('stay@example.com');
    expect(bySubject['Invitation: Planning']).toBe('new@example.com');
  });

  it('PATCH re-saving the same times is not a reschedule', async () => {
    const userId = `user_diff_same_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'stay@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();
    await send(userId, 'PATCH', `/${id}?sendNotification=true`, {
      startTime: '2030-03-01T10:00:00.000Z',
      endTime: '2030-03-01T11:00:00.000Z',
      title: 'Planning (renamed)',
    });
    expect(await settle()).toHaveLength(0);
  });

  it('PATCH adding a join link tells the existing attendees (update mail with the link)', async () => {
    const userId = `user_diff_link_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'stay@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();
    await send(userId, 'PATCH', `/${id}?sendNotification=true`, { meetingUrl: MEETING_URL, isVirtual: true });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].subject).toBe('Updated: Planning');
    expect(sentMails()[0].html).toContain(`href="${MEETING_URL}"`);
  });
});

describe('reschedule notifications', () => {
  it('mails attendees with the join link and new time by default', async () => {
    const userId = `user_resched_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      timezone: 'Europe/Amsterdam',
      attendees: [{ email: 'guest@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    const res = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-03-02T10:00:00.000Z',
      endTime: '2030-03-02T11:00:00.000Z',
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].subject).toBe('Rescheduled: Planning');
    expect(sentMails()[0].html).toContain(`href="${MEETING_URL}"`);
    // The zone is written once, at the end of the range.
    expect(sentMails()[0].html).toContain('11:00 AM – 12:00 PM GMT+1');
    expect(sentMails()[0].attachments[0].content).toContain('DTSTART:20300302T100000Z');
  });

  it('notifyAttendees: false moves the event without mailing anyone', async () => {
    const userId = `user_resched_quiet_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'guest@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    const res = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-03-02T10:00:00.000Z',
      endTime: '2030-03-02T11:00:00.000Z',
      notifyAttendees: false,
    });
    expect(res.status).toBe(200);
    expect((await eventRow(id)).startTime.toISOString()).toBe('2030-03-02T10:00:00.000Z');
    expect(await settle()).toHaveLength(0);
  });
});

describe('cancel mail', () => {
  it('DELETE ?sendNotification=true sends a CANCEL without join link', async () => {
    const userId = `user_cancel_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      attendees: [{ email: 'guest@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    expect((await send(userId, 'DELETE', `/${id}?sendNotification=true`)).status).toBe(204);
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].subject).toBe('Cancelled: Planning');
    expect(sentMails()[0].html).not.toContain(MEETING_URL);
    expect(sentMails()[0].attachments[0].content).toContain('METHOD:CANCEL');
  });
});

// ── TASK-935: cancelling / un-cancelling through the status field ──────────

describe('status change mail', () => {
  it('PATCH ?sendNotification=true to cancelled sends the cancellation', async () => {
    const userId = `user_status_cancel_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      attendees: [{ email: 'guest@example.com' }],
    });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    const res = await send(userId, 'PATCH', `/${id}?sendNotification=true`, { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect((await eventRow(id)).status).toBe('cancelled');
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].to).toEqual(['guest@example.com']);
    expect(sentMails()[0].subject).toBe('Cancelled: Planning');
    expect(sentMails()[0].html).not.toContain(MEETING_URL);
    expect(sentMails()[0].attachments[0].content).toContain('METHOD:CANCEL');
  });

  it('PATCH to cancelled without sendNotification mails nobody', async () => {
    const userId = `user_status_quiet_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'guest@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    expect((await send(userId, 'PATCH', `/${id}`, { status: 'cancelled' })).status).toBe(200);
    expect((await eventRow(id)).status).toBe('cancelled');
    expect(await settle()).toHaveLength(0);
  });

  it('PATCH ?sendNotification=true off cancelled tells guests the event is on again', async () => {
    const userId = `user_status_restore_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      timezone: 'Europe/Amsterdam',
      attendees: [{ email: 'guest@example.com' }],
    });
    await send(userId, 'PATCH', `/${id}?sendNotification=true`, { status: 'cancelled' });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(2));
    const cancelSequence = Number(/SEQUENCE:(\d+)/.exec(sentMails()[1].attachments[0].content)?.[1]);
    resetMail();

    const res = await send(userId, 'PATCH', `/${id}?sendNotification=true`, { status: 'confirmed' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    expect(sentMails()[0].to).toEqual(['guest@example.com']);
    expect(sentMails()[0].subject).toBe('Back on: Planning');
    // The join link is back, and the .ics re-adds the event: a REQUEST that
    // supersedes the cancellation.
    expect(sentMails()[0].html).toContain(`href="${MEETING_URL}"`);
    expect(sentMails()[0].html).toContain('11:00 AM – 12:00 PM GMT+1');
    const ics = sentMails()[0].attachments[0].content;
    expect(ics).toContain('METHOD:REQUEST');
    expect(Number(/SEQUENCE:(\d+)/.exec(ics)?.[1])).toBeGreaterThanOrEqual(cancelSequence);
  });

  it('confirmed <-> tentative is not a cancellation and mails nobody', async () => {
    const userId = `user_status_tentative_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'guest@example.com' }] });
    await vi.waitFor(() => expect(sentMails()).toHaveLength(1));
    resetMail();

    await send(userId, 'PATCH', `/${id}?sendNotification=true`, { status: 'tentative' });
    await send(userId, 'PATCH', `/${id}?sendNotification=true`, { status: 'confirmed' });
    expect(await settle()).toHaveLength(0);
  });
});

describe('GET / search', () => {
  it('matches title, description and location case-insensitively, tenant-scoped, without a date range', async () => {
    const userId = `user_search_${next()}`;
    const other = `user_search_other_${next()}`;
    const needle = `zq${next()}`;
    const byTitle = await createEvent(userId, { title: `Standup ${needle.toUpperCase()}` });
    const byDescription = await createEvent(userId, { description: `talk about ${needle}` });
    const byLocation = await createEvent(userId, { location: `Room ${needle}` });
    await createEvent(userId, { title: 'Unrelated' });
    await createEvent(other, { title: `Someone else ${needle}` });

    const res = await send(userId, 'GET', `?search=${needle}`);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id).sort();
    expect(ids).toEqual([byTitle.id, byDescription.id, byLocation.id].sort());
  });

  it('treats % and _ in the search text literally', async () => {
    const userId = `user_search_wild_${next()}`;
    await createEvent(userId, { title: 'plain title' });
    const res = await send(userId, 'GET', '?search=%25');
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe('date-range overlap', () => {
  async function seed(userId: string, title: string, start: string, end: string | null) {
    const calendarId = await seedCalendar(userId);
    await db.insert(schema.calendarEvents).values({
      id: generateId('evt'),
      calendarId,
      organizerId: userId,
      title,
      type: 'meeting',
      startTime: new Date(start),
      endTime: end ? new Date(end) : null,
    });
  }

  it('GET / and GET /range include events that started before the window but overlap it', async () => {
    const userId = `user_overlap_${next()}`;
    const calendarId = await seedCalendar(userId);
    const add = (title: string, start: string, end: string | null) =>
      db.insert(schema.calendarEvents).values({
        id: generateId('evt'),
        calendarId,
        organizerId: userId,
        title,
        type: 'meeting',
        startTime: new Date(start),
        endTime: end ? new Date(end) : null,
      });
    await add('spans-in', '2031-06-01T00:00:00Z', '2031-06-10T00:00:00Z');
    await add('inside', '2031-06-04T09:00:00Z', '2031-06-04T10:00:00Z');
    await add('before', '2031-05-01T00:00:00Z', '2031-05-02T00:00:00Z');
    await add('after', '2031-07-01T00:00:00Z', '2031-07-02T00:00:00Z');
    await add('no-end-before', '2031-06-01T00:00:00Z', null);
    await add('no-end-inside', '2031-06-05T00:00:00Z', null);
    await add('ends-on-start', '2031-05-30T00:00:00Z', '2031-06-03T00:00:00Z');

    const qs = `startDate=${encodeURIComponent('2031-06-03T00:00:00Z')}&endDate=${encodeURIComponent('2031-06-06T23:59:59.999Z')}`;
    const expected = ['ends-on-start', 'inside', 'no-end-inside', 'spans-in'];

    const listRes = await send(userId, 'GET', `?${qs}`);
    const listed = ((await listRes.json()) as { data: { title: string }[] }).data.map((r) => r.title).sort();
    expect(listed).toEqual(expected);

    const rangeRes = await send(userId, 'GET', `/range?${qs}`);
    const ranged = ((await rangeRes.json()) as { data: { title: string }[] }).data.map((r) => r.title).sort();
    expect(ranged).toEqual(expected);
  });

  it('is still tenant-scoped', async () => {
    const userId = `user_overlap_a_${next()}`;
    const other = `user_overlap_b_${next()}`;
    await seed(other, 'foreign', '2032-06-01T00:00:00Z', '2032-06-10T00:00:00Z');
    const res = await send(userId, 'GET', '?startDate=2032-06-03T00:00:00Z&endDate=2032-06-04T00:00:00Z');
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe('field validation (TASK-894)', () => {
  it('rejects a non-http(s) meetingUrl on create and update, keeps http(s), clears on empty/null', async () => {
    const userId = `user_url_${next()}`;
    const calendarId = await seedCalendar(userId);
    const body = { calendarId, title: 'Link', startTime: '2030-03-01T10:00:00.000Z' };

    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/x', 'not a url']) {
      expect((await send(userId, 'POST', '', { ...body, meetingUrl: bad })).status, bad).toBe(400);
    }

    const ok = await send(userId, 'POST', '', { ...body, meetingUrl: MEETING_URL });
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { data: { id: string } }).data.id;

    expect((await send(userId, 'PATCH', `/${id}`, { meetingUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await eventRow(id)).meetingUrl).toBe(MEETING_URL);

    expect((await send(userId, 'PATCH', `/${id}`, { meetingUrl: 'http://example.com/room' })).status).toBe(200);
    expect((await eventRow(id)).meetingUrl).toBe('http://example.com/room');

    expect((await send(userId, 'PATCH', `/${id}`, { meetingUrl: '' })).status).toBe(200);
    expect((await eventRow(id)).meetingUrl).toBeNull();

    expect((await send(userId, 'PATCH', `/${id}`, { meetingUrl: MEETING_URL })).status).toBe(200);
    expect((await send(userId, 'PATCH', `/${id}`, { meetingUrl: null })).status).toBe(200);
    expect((await eventRow(id)).meetingUrl).toBeNull();
  });

  it('rejects a whitespace-only title on create and update and trims a padded one', async () => {
    const userId = `user_title_${next()}`;
    const calendarId = await seedCalendar(userId);
    const body = { calendarId, startTime: '2030-03-01T10:00:00.000Z' };

    expect((await send(userId, 'POST', '', { ...body, title: '   ' })).status).toBe(400);
    expect((await send(userId, 'POST', '', { ...body, title: '' })).status).toBe(400);

    const created = await send(userId, 'POST', '', { ...body, title: '  Standup  ' });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await eventRow(id)).title).toBe('Standup');

    expect((await send(userId, 'PATCH', `/${id}`, { title: '   ' })).status).toBe(400);
    expect((await eventRow(id)).title).toBe('Standup');
  });

  it('still accepts a recurrenceRule (WeldMail "add to calendar" and Google sync rely on it)', async () => {
    const userId = `user_rrule_${next()}`;
    const { id } = await createEvent(userId, { recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' });
    expect((await eventRow(id)).recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });
});

describe('moving an event to another calendar (TASK-888)', () => {
  async function share(calendarId: string, sharedWithId: string, permission: 'view' | 'edit' | 'manage') {
    await db.insert(schema.calendarShares).values({
      id: generateId('csh'),
      calendarId,
      sharedWithId,
      permission,
      sharedById: 'someone',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('moves the event between two calendars the caller owns', async () => {
    const userId = `user_mv_${next()}`;
    const { id } = await createEvent(userId);
    const target = await seedCalendar(userId);

    const res = await send(userId, 'PATCH', `/${id}`, { calendarId: target });
    expect(res.status).toBe(200);
    expect((await eventRow(id)).calendarId).toBe(target);
    // It shows up in the target calendar's list now.
    const list = await send(userId, 'GET', `?calendarIds=${target}`);
    expect(((await list.json()) as { data: { id: string }[] }).data.map((e) => e.id)).toContain(id);
  });

  it("a PATCH carrying the event's own calendarId stays a no-op", async () => {
    const userId = `user_mv_same_${next()}`;
    const { id, calendarId } = await createEvent(userId);
    expect((await send(userId, 'PATCH', `/${id}`, { calendarId, title: 'Renamed' })).status).toBe(200);
    expect((await eventRow(id)).calendarId).toBe(calendarId);
  });

  it('allows a target the caller can edit through a share', async () => {
    const userId = `user_mv_edit_${next()}`;
    const { id } = await createEvent(userId);
    const target = await seedCalendar(`user_mv_edit_owner_${next()}`);
    await share(target, userId, 'edit');
    expect((await send(userId, 'PATCH', `/${id}`, { calendarId: target })).status).toBe(200);
    expect((await eventRow(id)).calendarId).toBe(target);
  });

  it('403 when the target is shared view-only', async () => {
    const userId = `user_mv_view_${next()}`;
    const { id, calendarId } = await createEvent(userId);
    const target = await seedCalendar(`user_mv_view_owner_${next()}`);
    await share(target, userId, 'view');
    expect((await send(userId, 'PATCH', `/${id}`, { calendarId: target })).status).toBe(403);
    expect((await eventRow(id)).calendarId).toBe(calendarId);
  });

  it('403 when the target belongs to someone else and is not shared', async () => {
    const userId = `user_mv_foreign_${next()}`;
    const { id, calendarId } = await createEvent(userId);
    const target = await seedCalendar(`user_mv_foreign_owner_${next()}`);
    expect((await send(userId, 'PATCH', `/${id}`, { calendarId: target })).status).toBe(403);
    expect((await eventRow(id)).calendarId).toBe(calendarId);
  });

  it('403 for an unknown or deleted target calendar', async () => {
    const userId = `user_mv_unknown_${next()}`;
    const { id, calendarId } = await createEvent(userId);
    expect((await send(userId, 'PATCH', `/${id}`, { calendarId: 'cal_does_not_exist' })).status).toBe(403);

    const deleted = await seedCalendar(userId);
    await db
      .update(schema.calendars)
      .set({ deletedAt: new Date() })
      .where(eq(schema.calendars.id, deleted));
    expect((await send(userId, 'PATCH', `/${id}`, { calendarId: deleted })).status).toBe(403);
    expect((await eventRow(id)).calendarId).toBe(calendarId);
  });

  it("403 when the caller may only view the event's current calendar", async () => {
    const ownerId = `user_mv_src_owner_${next()}`;
    const viewerId = `user_mv_src_viewer_${next()}`;
    const { id, calendarId } = await createEvent(ownerId);
    await share(calendarId, viewerId, 'view');
    const viewerOwn = await seedCalendar(viewerId);
    expect((await send(viewerId, 'PATCH', `/${id}`, { calendarId: viewerOwn })).status).toBe(403);
    expect((await eventRow(id)).calendarId).toBe(calendarId);
  });
});

describe('reads: list filters, detail, range and upcoming', () => {
  it('filters the list by type, status and calendar, and pages by cursor', async () => {
    const userId = `user_list_${next()}`;
    const { calendarId } = await createEvent(userId, { title: 'One', type: 'call' });
    const second = await send(userId, 'POST', '', {
      calendarId,
      title: 'Two',
      type: 'call',
      status: 'tentative',
      startTime: '2030-03-02T10:00:00.000Z',
    });
    const twoId = ((await second.json()) as { data: { id: string } }).data.id;
    const read = (query: string) => api(userId)(`/api/calendar-events${query}`);

    const calls = (await (await read('?type=call')).json()) as { data: { title: string }[] };
    expect(calls.data.map((e) => e.title).sort()).toEqual(['One', 'Two']);
    const tentative = (await (await read('?status=tentative')).json()) as { data: { id: string }[] };
    expect(tentative.data.map((e) => e.id)).toEqual([twoId]);
    const scoped = (await (await read(`?calendarIds=${calendarId},cal_not_mine`)).json()) as { data: unknown[] };
    expect(scoped.data).toHaveLength(2);
    const none = (await (await read('?calendarIds=cal_not_mine')).json()) as { data: unknown[]; pagination: { totalCount: number } };
    expect(none).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });

    const page1 = (await (await read('?limit=1')).json()) as { data: { id: string }[]; pagination: { cursor: string; hasMore: boolean } };
    expect(page1.pagination.hasMore).toBe(true);
    const page2 = (await (await read(`?limit=1&cursor=${page1.pagination.cursor}`)).json()) as { data: { id: string }[] };
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].id).not.toBe(page1.data[0].id);

    expect((await read('?limit=0')).status).toBe(400);
    expect((await read('?limit=abc')).status).toBe(400);
    expect((await read('?startDate=not-a-date')).status).toBe(500);
    expect((await api(userId)(`/api/calendar-events/${twoId}`)).status).toBe(200);
  });

  it('range needs both dates; upcoming lists the next confirmed events', async () => {
    const userId = `user_upcoming_${next()}`;
    const calendarId = await seedCalendar(userId);
    const soon = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString();
    const later = new Date(Date.now() + 20 * 24 * 3_600_000).toISOString();
    for (const [title, startTime, status] of [
      ['Soon', soon, 'confirmed'],
      ['Later', later, 'confirmed'],
      ['Maybe', soon, 'tentative'],
    ] as const) {
      const res = await send(userId, 'POST', '', { calendarId, title, startTime, status });
      expect(res.status).toBe(201);
    }
    const upcoming = (await (await api(userId)('/api/calendar-events/upcoming')).json()) as { data: { title: string }[] };
    expect(upcoming.data.map((e) => e.title)).toEqual(['Soon']);
    const month = (await (await api(userId)('/api/calendar-events/upcoming?days=30&limit=5')).json()) as {
      data: { title: string }[];
    };
    expect(month.data.map((e) => e.title)).toEqual(['Soon', 'Later']);
    expect((await api(userId)('/api/calendar-events/upcoming?days=0')).status).toBe(400);
    expect((await api(userId)('/api/calendar-events/upcoming?limit=101')).status).toBe(400);
    expect((await api('user_upcoming_nobody')('/api/calendar-events/upcoming')).status).toBe(200);

    expect((await api(userId)('/api/calendar-events/range?startDate=2030-01-01')).status).toBe(400);
    expect((await api(userId)('/api/calendar-events/range?startDate=x&endDate=y')).status).toBe(500);
    expect((await api('user_range_nobody')('/api/calendar-events/range?startDate=x&endDate=y')).status).toBe(200);
  });

  it('needs events:read', async () => {
    const request = createTestApp('/api/calendar-events', calendarEventsRoutes, {
      context: { permissions: permissions(), userId: 'user_noperm', tenantDb: db },
    }).request;
    for (const path of ['', '/range?startDate=a&endDate=b', '/upcoming', '/evt_x']) {
      expect((await request(`/api/calendar-events${path}`)).status, path).toBe(403);
    }
  });
});

describe('unknown events and refusals', () => {
  it('answers 404 for an event the caller cannot reach and 403 for a calendar they cannot use', async () => {
    const userId = `user_refuse_${next()}`;
    for (const [method, path] of [
      ['PATCH', '/evt_missing'],
      ['DELETE', '/evt_missing'],
      ['PATCH', '/evt_missing/cancel'],
      ['POST', '/evt_missing/unpin'],
    ] as const) {
      expect((await send(userId, method, path, method === 'PATCH' ? {} : undefined)).status, path).toBe(404);
    }
    expect((await send(userId, 'PATCH', '/evt_missing/reschedule', { startTime: '2030-01-01T10:00:00.000Z' })).status).toBe(404);
    expect((await send(userId, 'PATCH', '/evt_missing/reschedule', {})).status).toBe(400);
    const res = await send(userId, 'POST', '', {
      calendarId: 'cal_not_mine',
      title: 'Nope',
      startTime: '2030-01-01T10:00:00.000Z',
    });
    expect(res.status).toBe(403);
  });
});

describe('auto-scheduling: manual reschedule pins, unpin releases', () => {
  async function seedSourced(userId: string, sourceType: 'task' | 'activity', dueDate: Date | null) {
    const calendarId = await seedCalendar(userId);
    const sourceId = `${sourceType}_${next()}`;
    if (sourceType === 'task') {
      await db.insert(schema.tasks).values({
        id: sourceId,
        title: 'Write report',
        dueDate,
        startDate: null,
      } as typeof schema.tasks.$inferInsert);
    } else {
      await db.insert(schema.crmActivities).values({
        id: sourceId,
        type: 'call',
        subject: 'Call back',
        assignedToId: userId,
        startTime: new Date('2030-01-01T09:00:00.000Z'),
        endTime: new Date('2030-01-01T09:30:00.000Z'),
      } as typeof schema.crmActivities.$inferInsert);
    }
    const id = generateId('evt');
    await db.insert(schema.calendarEvents).values({
      id,
      calendarId,
      organizerId: userId,
      title: 'Sourced',
      type: 'reminder',
      startTime: new Date('2030-01-01T09:00:00.000Z'),
      endTime: new Date('2030-01-01T09:30:00.000Z'),
      sourceType,
      sourceId,
      autoScheduled: true,
    });
    return { id, sourceId };
  }

  it('a manual reschedule writes the slot to the task and pins the event; unpin puts it back on the due date', async () => {
    const userId = `user_pin_task_${next()}`;
    const { id, sourceId } = await seedSourced(userId, 'task', new Date('2030-02-01T00:00:00.000Z'));
    const res = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-01-05T10:00:00.000Z',
      endTime: '2030-01-05T11:00:00.000Z',
      manual: true,
      notifyAttendees: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id, startTime: '2030-01-05T10:00:00.000Z', endTime: '2030-01-05T11:00:00.000Z', manual: true, notifyAttendees: false },
    });
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, sourceId));
    expect(task?.startDate?.toISOString()).toBe('2030-01-05T10:00:00.000Z');
    expect((await eventRow(id)).autoScheduled).toBe(false);

    const unpin = await send(userId, 'POST', `/${id}/unpin`);
    expect(unpin.status).toBe(200);
    expect(await unpin.json()).toEqual({ data: { id, autoScheduled: true } });
    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, sourceId));
    expect(after?.startDate).toBeNull();
    const row = await eventRow(id);
    expect(row.autoScheduled).toBe(true);
    expect(row.startTime.toISOString()).toBe('2030-02-01T00:00:00.000Z');
  });

  it('works for a task without a due date and for an activity', async () => {
    const userId = `user_pin_misc_${next()}`;
    const task = await seedSourced(userId, 'task', null);
    expect((await send(userId, 'POST', `/${task.id}/unpin`)).status).toBe(200);
    expect((await eventRow(task.id)).startTime.toISOString()).toBe('2030-01-01T09:00:00.000Z');

    const activity = await seedSourced(userId, 'activity', null);
    const res = await send(userId, 'PATCH', `/${activity.id}/reschedule`, {
      // No end: the event keeps its own, the activity gets 30 minutes.
      startTime: '2030-01-01T08:00:00.000Z',
      manual: true,
      notifyAttendees: false,
    });
    expect(res.status).toBe(200);
    const [moved] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, activity.sourceId));
    expect(moved?.startTime?.toISOString()).toBe('2030-01-01T08:00:00.000Z');
    expect(moved?.endTime?.toISOString()).toBe('2030-01-01T08:30:00.000Z');
    expect((await send(userId, 'POST', `/${activity.id}/unpin`)).status).toBe(200);
    const [cleared] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, activity.sourceId));
    expect(cleared?.startTime).toBeNull();
  });
});

describe('Google Calendar outbound sync', () => {
  const GOOGLE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Google answers by method and URL; everything else (the conformance
    // harness's own calls) goes to the real fetch.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), { status: 200 });
      }
      if (!url.startsWith(GOOGLE)) return realFetch(input, init);
      if (url.endsWith('/g_denied')) return new Response('read-only', { status: 403 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: url === GOOGLE ? 'g_created' : url.slice(GOOGLE.length + 1) }), {
        status: 200,
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedConnection(tokens: Record<string, unknown>) {
    const id = generateId('ic');
    await db.update(schema.integrationConnections).set({ status: 'inactive' });
    await db.insert(schema.integrationConnections).values({
      id,
      provider: 'google_calendar',
      status: 'active',
      oauthTokens: tokens as never,
    } as typeof schema.integrationConnections.$inferInsert);
    return id;
  }

  async function mapping(eventId: string) {
    const [row] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.internalEntityId, eventId));
    return row;
  }

  it('creates, updates and deletes the event on Google and keeps the mapping', async () => {
    await seedConnection({ accessToken: 'tok', expiresAt: '2099-01-01T00:00:00.000Z' });
    const userId = `user_google_${next()}`;
    const { id } = await createEvent(userId, {
      timezone: 'Europe/Amsterdam',
      attendees: [{ email: 'guest@example.com', name: 'Guest' }],
      recurrenceRule: 'RRULE:FREQ=WEEKLY',
    });
    await vi.waitFor(async () => expect((await mapping(id))?.externalEntityId).toBe('g_created'));

    expect((await send(userId, 'PATCH', `/${id}`, { title: 'Renamed', allDay: true })).status).toBe(200);
    expect((await send(userId, 'PATCH', `/${id}/cancel`)).status).toBe(200);
    expect((await send(userId, 'DELETE', `/${id}`)).status).toBe(204);
    expect((await mapping(id))?.externalEntityId).toBe('g_created');
  });

  it('refreshes an expired token first, and flags a connection Google refuses to write to', async () => {
    const connectionId = await seedConnection({
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const userId = `user_google_refresh_${next()}`;
    const request = createTestApp('/api/calendar-events', calendarEventsRoutes, {
      context: {
        permissions: permissions('events:read', 'events:create', 'events:update', 'events:delete'),
        userId,
        tenantDb: db,
      },
      env: { ENVIRONMENT: 'production', GOOGLE_CALENDAR_CLIENT_ID: 'cid', GOOGLE_CALENDAR_CLIENT_SECRET: 'secret' },
    }).request;
    const calendarId = await seedCalendar(userId);
    const res = await request('/api/calendar-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, title: 'Refresh', startTime: '2030-03-01T10:00:00.000Z' }),
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    await vi.waitFor(async () => expect((await mapping(id))?.externalEntityId).toBe('g_created'));

    // A mapped event Google refuses: the connection asks for a reconnect.
    await db
      .update(schema.integrationEntityMappings)
      .set({ externalEntityId: 'g_denied' })
      .where(eq(schema.integrationEntityMappings.internalEntityId, id));
    expect((await request(`/api/calendar-events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Refused' }),
    })).status).toBe(200);
    await vi.waitFor(async () => {
      const [connection] = await db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connectionId));
      expect(connection?.status).toBe('error');
    });
  });
});

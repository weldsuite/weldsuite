/**
 * /api/calendar-events: time-range + timezone validation, nullable updates,
 * external attendees, attendee diff mails, reschedule notifications, search.
 * Mail is observed by stubbing the Resend `fetch`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarEventsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const MEETING_URL = 'https://meet.weldsuite.org/acme/wm-dip-zfz-ubv';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

interface SentMail {
  to: string[];
  subject: string;
  html?: string;
  attachments: { content: string }[];
}

let sent: SentMail[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentMail);
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

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
    env: { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' },
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
  return sent;
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
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].html).toContain('11:00 PM GMT+2');
  });

  it('falls back to the organizer\'s preferred timezone when the event has none', async () => {
    const userId = `user_tz_pref_${next()}`;
    await db.insert(schema.userPreferences).values({ id: generateId('upref'), userId, timezone: 'Asia/Tokyo' });
    await createEvent(userId, {
      startTime: '2026-10-01T21:00:00.000Z',
      endTime: '2026-10-01T22:00:00.000Z',
      attendees: [{ email: 'guest@example.com' }],
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].html).toContain('6:00 AM GMT+9');
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

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    for (const mail of sent) {
      expect(mail.subject).toBe('Event invitation: Planning');
      expect(mail.html).toContain(`href="${MEETING_URL}"`);
      // Not workspace members: nothing that leads to the authenticated app.
      expect(mail.html).not.toContain('app.weldsuite.org');
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
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].html).toContain(`href="${MEETING_URL}"`);
    expect(sent[0].html).toContain('https://app.weldsuite.org/weldcalendar');
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
  });

  it('collapses duplicate attendee emails so nobody is invited twice', async () => {
    const userId = `user_att_dup_${next()}`;
    await createEvent(userId, { attendees: [{ email: 'dup@example.com' }, { email: 'DUP@example.com' }] });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(await settle()).toHaveLength(1);
  });

  it('PATCH diff: added attendees are invited, removed ones are sent a cancellation, others untouched', async () => {
    const userId = `user_diff_${next()}`;
    const { id } = await createEvent(userId, {
      meetingUrl: MEETING_URL,
      attendees: [{ email: 'stay@example.com' }, { email: 'gone@example.com' }],
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    sent.length = 0;

    const res = await send(userId, 'PATCH', `/${id}?sendNotification=true`, {
      attendees: [{ email: 'stay@example.com' }, { email: 'new@example.com', name: 'New' }],
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const bySubject = Object.fromEntries(sent.map((m) => [m.subject, m]));
    expect(bySubject['Event invitation: Planning'].to).toEqual(['new@example.com']);
    expect(bySubject['Event invitation: Planning'].html).toContain(`href="${MEETING_URL}"`);
    // The guest who was taken off is told so; the event itself is not cancelled.
    expect(bySubject['Event cancelled: Planning']).toBeUndefined();
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
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    await send(userId, 'PATCH', `/${id}?sendNotification=true`, {
      startTime: '2030-03-02T10:00:00.000Z',
      endTime: '2030-03-02T11:00:00.000Z',
      attendees: [{ email: 'stay@example.com' }, { email: 'new@example.com' }],
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const bySubject = Object.fromEntries(sent.map((m) => [m.subject, m.to[0]]));
    expect(bySubject['Event rescheduled: Planning']).toBe('stay@example.com');
    expect(bySubject['Event invitation: Planning']).toBe('new@example.com');
  });

  it('PATCH re-saving the same times is not a reschedule', async () => {
    const userId = `user_diff_same_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'stay@example.com' }] });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;
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
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;
    await send(userId, 'PATCH', `/${id}?sendNotification=true`, { meetingUrl: MEETING_URL, isVirtual: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Event updated: Planning');
    expect(sent[0].html).toContain(`href="${MEETING_URL}"`);
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
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    const res = await send(userId, 'PATCH', `/${id}/reschedule`, {
      startTime: '2030-03-02T10:00:00.000Z',
      endTime: '2030-03-02T11:00:00.000Z',
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Event rescheduled: Planning');
    expect(sent[0].html).toContain(`href="${MEETING_URL}"`);
    expect(sent[0].html).toContain('11:00 AM GMT+1');
    expect(sent[0].attachments[0].content).toContain('DTSTART:20300302T100000Z');
  });

  it('notifyAttendees: false moves the event without mailing anyone', async () => {
    const userId = `user_resched_quiet_${next()}`;
    const { id } = await createEvent(userId, { attendees: [{ email: 'guest@example.com' }] });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

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
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    expect((await send(userId, 'DELETE', `/${id}?sendNotification=true`)).status).toBe(204);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].subject).toBe('Event cancelled: Planning');
    expect(sent[0].html).not.toContain(MEETING_URL);
    expect(sent[0].attachments[0].content).toContain('METHOD:CANCEL');
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

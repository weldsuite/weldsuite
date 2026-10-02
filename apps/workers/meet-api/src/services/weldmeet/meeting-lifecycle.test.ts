import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const rtk = vi.hoisted(() => ({
  calls: [] as string[],
  kickShouldFail: false,
}));

vi.mock('@weldsuite/cloudflare-realtime', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/cloudflare-realtime')>(
    '@weldsuite/cloudflare-realtime',
  );
  return {
    ...actual,
    kickAllParticipants: vi.fn(async (_env: unknown, id: string) => {
      rtk.calls.push(`kick:${id}`);
      if (rtk.kickShouldFail) throw new Error('kick failed');
      return 0;
    }),
    endMeeting: vi.fn(async (_env: unknown, id: string) => {
      rtk.calls.push(`end:${id}`);
    }),
  };
});

import { endMeetingSession, isMeetingPast } from './meeting-lifecycle';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import { fakeKv } from '../../test/fakes';

const now = new Date('2026-10-02T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('isMeetingPast', () => {
  it('never treats an unscheduled meeting as past, so its link stays reusable', () => {
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: null }, now)).toBe(false);
    expect(isMeetingPast(undefined, now)).toBe(false);
  });

  it('uses the scheduled end when there is one', () => {
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: at('2026-10-02T11:59:00Z') }, now)).toBe(true);
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: at('2026-10-02T12:30:00Z') }, now)).toBe(false);
  });

  it('falls back to start + 1h without a scheduled end', () => {
    expect(isMeetingPast({ scheduledStart: at('2026-10-02T10:30:00Z'), scheduledEnd: null }, now)).toBe(true);
    expect(isMeetingPast({ scheduledStart: at('2026-10-02T11:30:00Z'), scheduledEnd: null }, now)).toBe(false);
  });
});

describe('endMeetingSession · pglite', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);

  beforeEach(() => {
    rtk.calls.length = 0;
    rtk.kickShouldFail = false;
  });

  const participant = (userId: string, extra: Record<string, unknown> = {}) => ({
    userId,
    userName: userId,
    joinedAt: '2026-10-02T10:00:00.000Z',
    cfSessionId: `cf_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  });

  async function seed(
    key: string,
    opts: { attendees?: MeetingAttendee[]; participants?: ReturnType<typeof participant>[] },
  ) {
    const meetingId = `mtg_end_${key}`;
    const sessionId = `msess_end_${key}`;
    await db.insert(schema.meetings).values({
      id: meetingId,
      title: `Weekly ${key}`,
      organizerId: 'user_end_org',
      status: 'in_progress',
      activeSessionId: sessionId,
      attendees: opts.attendees ?? [],
      calendarEventId: 'cev_end',
    });
    const startedAt = new Date(Date.now() - 45 * 60_000);
    await db.insert(schema.meetingSessions).values({
      id: sessionId,
      meetingId,
      status: 'active',
      cfAppId: `rtk_${key}`,
      startedBy: 'user_end_org',
      startedByName: 'Org',
      participants: opts.participants ?? [],
      startedAt,
    });
    return { meetingId, sessionId, startedAt };
  }

  const activitiesOf = (meetingTitle: string) =>
    db.select().from(schema.crmActivities).where(eq(schema.crmActivities.subject, meetingTitle));

  it('ends the session, releases the meeting, kicks before ending the RTK room and clears the KV mapping', async () => {
    const { meetingId, sessionId, startedAt } = await seed('basic', {
      participants: [participant('user_a'), participant('user_b', { leftAt: '2026-10-02T10:20:00.000Z' })],
    });
    const kv = fakeKv({ 'rtk-meeting:rtk_basic': { orgId: 'org' } });

    await endMeetingSession(db, { WORKSPACE_CACHE: kv }, 'org_end', sessionId, { startedAt, cfAppId: 'rtk_basic' }, meetingId);

    const [session] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(session?.status).toBe('ended');
    expect(session?.duration).toBeGreaterThanOrEqual(44 * 60);
    // Everyone still in the room is stamped as left; an earlier leave is kept.
    expect(session?.participants?.every((p) => p.leftAt)).toBe(true);
    expect(session?.participants?.find((p) => p.userId === 'user_b')?.leftAt).toBe('2026-10-02T10:20:00.000Z');

    const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId));
    expect(meeting?.activeSessionId).toBeNull();
    expect(meeting?.status).toBe('scheduled');

    expect(rtk.calls).toEqual(['kick:rtk_basic', 'end:rtk_basic']);
    expect(kv.store.has('rtk-meeting:rtk_basic')).toBe(false);
  });

  it('still ends the RTK room when the kick fails', async () => {
    rtk.kickShouldFail = true;
    const { meetingId, sessionId, startedAt } = await seed('kickfail', {});
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: 'rtk_kickfail' }, meetingId);
    expect(rtk.calls).toEqual(['kick:rtk_kickfail', 'end:rtk_kickfail']);
  });

  it('logs one completed meeting activity per linked person, assigned to the organizer', async () => {
    const { meetingId, sessionId, startedAt } = await seed('crm', {
      attendees: [
        { userId: 'user_end_org', email: 'org@example.com', name: 'Org', status: 'accepted', role: 'organizer' },
        { userId: '', email: 'inv@example.com', name: 'Invitee', status: 'pending', role: 'attendee', personId: 'per_invitee' },
        { userId: '', email: 'old@example.com', name: 'Legacy', status: 'pending', role: 'attendee', contactId: 'con_legacy' },
      ],
      participants: [
        participant('user_end_org'),
        participant('guest:inv@example.com', { personId: 'per_invitee' }),
        participant('guest:walk@example.com', { personId: 'per_walkin' }),
      ],
    });

    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId);

    const rows = await activitiesOf('Weekly crm');
    expect(rows.map((r) => r.personId ?? r.contactId).sort()).toEqual(['con_legacy', 'per_invitee', 'per_walkin']);
    for (const row of rows) {
      expect(row).toMatchObject({
        type: 'meeting',
        status: 'completed',
        isVirtual: true,
        assignedToId: 'user_end_org',
        calendarEventId: 'cev_end',
      });
      expect(row.startTime?.getTime()).toBe(startedAt.getTime());
      expect(row.endTime).toBeInstanceOf(Date);
      expect(row.duration).toBeGreaterThanOrEqual(44);
      expect(row.duration).toBeLessThanOrEqual(47);
    }
  });

  it('stores the person id in contact_id too, so the entry shows under a personId and a contactId filter', async () => {
    const { meetingId, sessionId, startedAt } = await seed('bothlinks', {
      attendees: [
        { userId: '', email: 'a@example.com', name: 'A', status: 'pending', role: 'attendee', personId: 'per_both_a' },
        { userId: '', email: 'b@example.com', name: 'B', status: 'pending', role: 'attendee', personId: 'per_both_b', contactId: 'con_both_b' },
      ],
    });
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId);
    const rows = await activitiesOf('Weekly bothlinks');
    const pairs = rows.map((r) => [r.personId, r.contactId]).sort();
    expect(pairs).toEqual([
      ['per_both_a', 'per_both_a'],
      ['per_both_b', 'con_both_b'],
    ]);
  });

  it('moves a recording that is still running to processing, from the claimed row', async () => {
    const { meetingId, sessionId, startedAt } = await seed('recording', { participants: [participant('user_a')] });
    await db
      .update(schema.meetingSessions)
      .set({ recordingStatus: 'recording', recordingEnabled: true })
      .where(eq(schema.meetingSessions.id, sessionId));
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId);
    const [row] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(row?.recordingStatus).toBe('processing');
    expect(row?.recordingEnabled).toBe(false);
  });

  it('keeps recording state untouched when nothing was recording, and leaves an ended row alone', async () => {
    const { meetingId, sessionId, startedAt } = await seed('norecording', { participants: [participant('user_a')] });
    await db
      .update(schema.meetingSessions)
      .set({ recordingStatus: 'ready' })
      .where(eq(schema.meetingSessions.id, sessionId));
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId);
    const [first] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(first?.recordingStatus).toBe('ready');

    // A second end (a late guest leave) must not rewrite participants of the ended row.
    await db
      .update(schema.meetingSessions)
      .set({ participants: [participant('user_a', { leftAt: '2026-10-02T10:30:00.000Z' })] })
      .where(eq(schema.meetingSessions.id, sessionId));
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId);
    const [second] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(second?.participants?.[0]?.leftAt).toBe('2026-10-02T10:30:00.000Z');
  });

  it('writes the activities once even when the session is ended twice', async () => {
    const { meetingId, sessionId, startedAt } = await seed('twice', {
      participants: [participant('guest:twice@example.com', { personId: 'per_twice' })],
    });
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: 'rtk_twice' }, meetingId);
    const [first] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: 'rtk_twice' }, meetingId);
    const [second] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));

    expect(await activitiesOf('Weekly twice')).toHaveLength(1);
    expect(second?.endedAt?.getTime()).toBe(first?.endedAt?.getTime());
    expect(rtk.calls).toEqual(['kick:rtk_twice', 'end:rtk_twice']);
  });

  it('logs nothing for a meeting with only workspace members', async () => {
    const { meetingId, sessionId, startedAt } = await seed('members', { participants: [participant('user_end_org')] });
    await endMeetingSession(db, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId);
    expect(await activitiesOf('Weekly members')).toHaveLength(0);
  });

  it('never fails the end when the CRM activity insert fails', async () => {
    const { meetingId, sessionId, startedAt } = await seed('crmfail', {
      participants: [participant('guest:x@example.com', { personId: 'per_x' })],
    });
    // A handle whose insert throws; every other call goes to the real database.
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return () => {
            throw new Error('insert exploded');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;

    await expect(
      endMeetingSession(failing, {}, 'org_end', sessionId, { startedAt, cfAppId: null }, meetingId),
    ).resolves.toBeUndefined();
    const [session] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
    expect(session?.status).toBe('ended');
  });
});

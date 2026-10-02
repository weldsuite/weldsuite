/**
 * DB-backed lifecycle tests for /api/meeting-sessions/:id/{leave,end}.
 *
 * TASK-719: the host's Leave used to end the RTK meeting without disconnecting
 * anyone, never stamped leftAt on the participants, and (once kicks work) every
 * kicked client's /leave would have re-run the end and overwritten endedAt.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import type { Env } from '../../types';
import { meetingSessionsRoutes } from './index';
import { endMeeting, kickAllParticipants, kickParticipants } from '@weldsuite/cloudflare-realtime';
import { isGuestRemovedFromSession } from '@weldsuite/db/schema/meeting-sessions';

vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  kickAllParticipants: vi.fn(),
  kickParticipants: vi.fn(),
  endMeeting: vi.fn(),
}));

const ORGANIZER = 'user_organizer';
const GUEST = 'user_guest';
const CF_APP_ID = 'rtk_meeting_1';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => {
  vi.mocked(kickAllParticipants).mockReset().mockResolvedValue(2);
  vi.mocked(kickParticipants).mockReset().mockResolvedValue(undefined);
  vi.mocked(endMeeting).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function participant(userId: string, extra: Partial<MeetingSessionParticipant> = {}): MeetingSessionParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: new Date(Date.now() - 60_000).toISOString(),
    cfSessionId: `cf_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  };
}

async function seed(
  participants: MeetingSessionParticipant[],
  opts: { status?: 'active' | 'ended'; metadata?: Record<string, unknown> } = {},
) {
  const meetingId = generateId('mtg');
  const sessionId = generateId('msess');
  const startedAt = new Date(Date.now() - 5 * 60_000);
  await db.insert(schema.meetings).values({
    id: meetingId,
    title: 'Lifecycle',
    organizerId: ORGANIZER,
    status: 'in_progress',
    activeSessionId: null,
  });
  await db.insert(schema.meetingSessions).values({
    id: sessionId,
    meetingId,
    status: opts.status ?? 'active',
    cfAppId: CF_APP_ID,
    startedBy: ORGANIZER,
    startedByName: 'Organizer',
    participants,
    startedAt,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
  await db
    .update(schema.meetings)
    .set({ activeSessionId: sessionId })
    .where(eq(schema.meetings.id, meetingId));
  return { meetingId, sessionId };
}

function appFor(userId: string, ...perms: string[]) {
  const env = {
    WORKSPACE_CACHE: { delete: async () => undefined } as unknown as KVNamespace,
    REALTIME: { fetch: async () => new Response('{}') } as unknown as Fetcher,
  } satisfies Partial<Env>;
  return createTestApp('/api/meeting-sessions', meetingSessionsRoutes, {
    context: { permissions: permissions(...perms), userId, tenantDb: db },
    env,
  });
}

const post = (request: ReturnType<typeof appFor>['request'], path: string) =>
  request(path, { method: 'POST' });

const postJson = (request: ReturnType<typeof appFor>['request'], path: string, body: unknown) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function loadSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(schema.meetingSessions)
    .where(eq(schema.meetingSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('session missing');
  return row;
}

async function loadMeeting(meetingId: string) {
  const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId)).limit(1);
  if (!row) throw new Error('meeting missing');
  return row;
}

describe('POST /api/meeting-sessions/:id/end', () => {
  it('ends for everyone: stamps leftAt, clears the active session, kicks then ends the RTK meeting', async () => {
    const alreadyLeft = new Date(Date.now() - 30_000).toISOString();
    const { meetingId, sessionId } = await seed([
      participant(ORGANIZER),
      participant(GUEST),
      participant('user_gone', { leftAt: alreadyLeft }),
    ]);
    const { request } = appFor(ORGANIZER, 'sessions:read', 'sessions:update');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });

    const session = await loadSession(sessionId);
    expect(session.status).toBe('ended');
    expect(session.endedAt).toBeInstanceOf(Date);
    expect(session.duration).toBeGreaterThan(0);
    expect(session.participants?.every((p) => !!p.leftAt)).toBe(true);
    // A participant who already left keeps their original timestamp.
    expect(session.participants?.find((p) => p.userId === 'user_gone')?.leftAt).toBe(alreadyLeft);

    const meeting = await loadMeeting(meetingId);
    expect(meeting.activeSessionId).toBeNull();
    expect(meeting.status).not.toBe('in_progress');

    expect(kickAllParticipants).toHaveBeenCalledTimes(1);
    expect(kickAllParticipants).toHaveBeenCalledWith(expect.anything(), CF_APP_ID);
    expect(endMeeting).toHaveBeenCalledTimes(1);
    expect(endMeeting).toHaveBeenCalledWith(expect.anything(), CF_APP_ID);
    expect(vi.mocked(kickAllParticipants).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(endMeeting).mock.invocationCallOrder[0]!,
    );
  });

  it('logs a failed kick, still ends the RTK meeting and still ends the session in the DB', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(kickAllParticipants).mockRejectedValue(new Error('Failed to kick all RTK participants: 404'));
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read', 'sessions:update');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(200);
    expect((await loadSession(sessionId)).status).toBe('ended');
    expect(endMeeting).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[MeetingLifecycle] RTK kick-all failed',
      expect.objectContaining({ sessionId, cfAppId: CF_APP_ID, err: expect.any(Error) }),
    );
  });

  it('logs a failed RTK end without failing the request', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(endMeeting).mockRejectedValue(new Error('boom'));
    const { sessionId } = await seed([participant(ORGANIZER)]);
    const { request } = appFor(ORGANIZER, 'sessions:read', 'sessions:update');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(200);
    expect((await loadSession(sessionId)).status).toBe('ended');
    expect(errorSpy).toHaveBeenCalledWith(
      '[MeetingLifecycle] RTK end meeting failed',
      expect.objectContaining({ sessionId, cfAppId: CF_APP_ID }),
    );
  });

  it('is idempotent: a second end keeps endedAt/duration and does not kick again', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read', 'sessions:update');

    await post(request, `/api/meeting-sessions/${sessionId}/end`);
    const first = await loadSession(sessionId);
    vi.mocked(kickAllParticipants).mockClear();
    vi.mocked(endMeeting).mockClear();

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const second = await loadSession(sessionId);
    expect(second.endedAt?.getTime()).toBe(first.endedAt?.getTime());
    expect(second.duration).toBe(first.duration);
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it('forbids a non-organizer without sessions:update', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(GUEST, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(403);
    expect((await loadSession(sessionId)).status).toBe('active');
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });

  it('lets the organizer end without sessions:update', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(200);
    expect((await loadSession(sessionId)).status).toBe('ended');
    expect(kickAllParticipants).toHaveBeenCalledTimes(1);
  });

  it('lets a non-organizer with sessions:update end the meeting', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(GUEST, 'sessions:read', 'sessions:update');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/end`);

    expect(res.status).toBe(200);
    expect((await loadSession(sessionId)).status).toBe('ended');
  });

  it('returns 404 for an unknown session', async () => {
    const { request } = appFor(ORGANIZER, 'sessions:read', 'sessions:update');
    const res = await post(request, '/api/meeting-sessions/msess_missing/end');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/meeting-sessions/:id/leave', () => {
  it('does not re-run the end for a client kicked after the session ended', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const host = appFor(ORGANIZER, 'sessions:read', 'sessions:update');
    await post(host.request, `/api/meeting-sessions/${sessionId}/end`);
    const ended = await loadSession(sessionId);
    vi.mocked(kickAllParticipants).mockClear();
    vi.mocked(endMeeting).mockClear();

    const guest = appFor(GUEST, 'sessions:read');
    const res = await post(guest.request, `/api/meeting-sessions/${sessionId}/leave`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const after = await loadSession(sessionId);
    expect(after.endedAt?.getTime()).toBe(ended.endedAt?.getTime());
    expect(after.duration).toBe(ended.duration);
    expect(after.updatedAt.getTime()).toBe(ended.updatedAt.getTime());
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it('keeps the session active when the organizer leaves while another participant remains', async () => {
    const { meetingId, sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/leave`);

    expect(res.status).toBe(200);
    const session = await loadSession(sessionId);
    expect(session.status).toBe('active');
    expect(session.participants?.find((p) => p.userId === ORGANIZER)?.leftAt).toBeTruthy();
    expect(session.participants?.find((p) => p.userId === GUEST)?.leftAt).toBeUndefined();
    expect((await loadMeeting(meetingId)).activeSessionId).toBe(sessionId);
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it('still auto-ends when the last participant leaves', async () => {
    const { meetingId, sessionId } = await seed([
      participant(ORGANIZER, { leftAt: new Date().toISOString() }),
      participant(GUEST),
    ]);
    const { request } = appFor(GUEST, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/leave`);

    expect(res.status).toBe(200);
    const session = await loadSession(sessionId);
    expect(session.status).toBe('ended');
    expect(session.participants?.every((p) => !!p.leftAt)).toBe(true);
    expect((await loadMeeting(meetingId)).activeSessionId).toBeNull();
    expect(endMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/meeting-sessions/:id/participants/remove', () => {
  const GUEST_EMAIL = 'jane@example.com';
  const GUEST_USER_ID = `guest:${GUEST_EMAIL}`;
  const removePath = (sessionId: string) => `/api/meeting-sessions/${sessionId}/participants/remove`;

  const guestParticipant = () =>
    participant(GUEST_USER_ID, { userName: 'Jane', cfSessionId: 'cf_guest_jane', personId: 'prs_jane' });

  it('lets the organizer remove a guest: kicks that one participant, stamps leftAt and records the block', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant(), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: true, blocked: true } });
    expect(kickParticipants).toHaveBeenCalledTimes(1);
    expect(kickParticipants).toHaveBeenCalledWith(expect.anything(), CF_APP_ID, {
      participantIds: ['cf_guest_jane'],
    });

    const session = await loadSession(sessionId);
    expect(session.status).toBe('active');
    expect(session.participants?.find((p) => p.userId === GUEST_USER_ID)?.leftAt).toBeTruthy();
    // Everyone else stays in the call.
    expect(session.participants?.find((p) => p.userId === ORGANIZER)?.leftAt).toBeUndefined();
    expect(session.participants?.find((p) => p.userId === GUEST)?.leftAt).toBeUndefined();
    expect(isGuestRemovedFromSession(session.metadata, GUEST_EMAIL)).toBe(true);
    expect(isGuestRemovedFromSession(session.metadata, 'JANE@Example.com')).toBe(true);
    expect(session.metadata?.removedGuests).toEqual({
      [GUEST_EMAIL]: { removedAt: expect.any(String), removedBy: ORGANIZER, name: 'Jane' },
    });
  });

  it('matches the participant by rtkUserId when peer.id is the per-connection peer id', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant()]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), {
      participantId: 'rtk_peer_unknown',
      rtkUserId: 'cf_guest_jane',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: true, blocked: true } });
    expect(kickParticipants).toHaveBeenCalledWith(expect.anything(), CF_APP_ID, {
      participantIds: ['cf_guest_jane'],
    });
  });

  it('merges into existing metadata instead of overwriting it', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant()], {
      metadata: {
        botId: 'bot_1',
        removedGuests: { 'other@example.com': { removedAt: '2026-10-02T09:00:00.000Z', removedBy: 'user_x' } },
      },
    });
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    const { metadata } = await loadSession(sessionId);
    expect(metadata?.botId).toBe('bot_1');
    expect(Object.keys(metadata?.removedGuests as Record<string, unknown>).sort()).toEqual([
      'jane@example.com',
      'other@example.com',
    ]);
  });

  it('allows a non-organizer with sessions:update', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant(), participant(GUEST)]);
    const { request } = appFor(GUEST, 'sessions:read', 'sessions:update');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    expect(kickParticipants).toHaveBeenCalledTimes(1);
  });

  it('forbids a non-organizer without sessions:update and changes nothing', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant(), participant(GUEST)]);
    const { request } = appFor(GUEST, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(403);
    expect(kickParticipants).not.toHaveBeenCalled();
    const session = await loadSession(sessionId);
    expect(session.metadata).toBeNull();
    expect(session.participants?.find((p) => p.userId === GUEST_USER_ID)?.leftAt).toBeUndefined();
  });

  it('is idempotent: a repeat keeps the original removal and does not kick again', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant()]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });
    const first = await loadSession(sessionId);
    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: false, blocked: true } });
    expect(kickParticipants).toHaveBeenCalledTimes(1);
    const second = await loadSession(sessionId);
    expect(second.metadata).toEqual(first.metadata);
    expect(second.participants).toEqual(first.participants);
  });

  it('blocks a guest who already left when the host removes them, without kicking', async () => {
    const { sessionId } = await seed([
      participant(ORGANIZER),
      { ...guestParticipant(), leftAt: new Date().toISOString() },
    ]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: false, blocked: true } });
    expect(kickParticipants).not.toHaveBeenCalled();
    expect(isGuestRemovedFromSession((await loadSession(sessionId)).metadata, GUEST_EMAIL)).toBe(true);
  });

  it('is a no-op on an ended session', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant()], { status: 'ended' });
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: false, blocked: false } });
    expect(kickParticipants).not.toHaveBeenCalled();
    expect((await loadSession(sessionId)).metadata).toBeNull();
  });

  it('refuses to remove the organizer', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(GUEST, 'sessions:read', 'sessions:update');

    const res = await postJson(request, removePath(sessionId), { participantId: `cf_${ORGANIZER}` });

    expect(res.status).toBe(400);
    expect(kickParticipants).not.toHaveBeenCalled();
    expect((await loadSession(sessionId)).participants?.every((p) => !p.leftAt)).toBe(true);
  });

  it('refuses to remove yourself', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(GUEST, 'sessions:read', 'sessions:update');

    const res = await postJson(request, removePath(sessionId), { participantId: `cf_${GUEST}` });

    expect(res.status).toBe(400);
    expect(kickParticipants).not.toHaveBeenCalled();
  });

  it('kicks a workspace member and stamps leftAt without recording a block', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: `cf_${GUEST}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: true, blocked: false } });
    expect(kickParticipants).toHaveBeenCalledWith(expect.anything(), CF_APP_ID, {
      participantIds: [`cf_${GUEST}`],
    });
    const session = await loadSession(sessionId);
    expect(session.participants?.find((p) => p.userId === GUEST)?.leftAt).toBeTruthy();
    expect(session.metadata).toBeNull();
  });

  it('falls back to customParticipantId matched against the stored userId', async () => {
    const { sessionId } = await seed([participant(ORGANIZER), participant(GUEST)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), {
      participantId: 'peer_not_stored',
      customParticipantId: GUEST,
    });

    expect(res.status).toBe(200);
    expect(kickParticipants).toHaveBeenCalledWith(expect.anything(), CF_APP_ID, {
      participantIds: [`cf_${GUEST}`],
    });
  });

  it('persists the removal and still succeeds when the RTK kick fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(kickParticipants).mockRejectedValue(new Error('Failed to kick RTK participants: 404'));
    const { sessionId } = await seed([participant(ORGANIZER), guestParticipant()]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), { participantId: 'cf_guest_jane' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, kicked: false, blocked: true } });
    const session = await loadSession(sessionId);
    expect(isGuestRemovedFromSession(session.metadata, GUEST_EMAIL)).toBe(true);
    expect(session.participants?.find((p) => p.userId === GUEST_USER_ID)?.leftAt).toBeTruthy();
    expect(errorSpy).toHaveBeenCalledWith(
      '[meeting-sessions] RTK kick participant failed',
      expect.objectContaining({ sessionId, cfAppId: CF_APP_ID, err: expect.any(Error) }),
    );
  });

  it('returns 404 for an unknown participant and an unknown session', async () => {
    const { sessionId } = await seed([participant(ORGANIZER)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    expect((await postJson(request, removePath(sessionId), { participantId: 'cf_nobody' })).status).toBe(404);
    expect((await postJson(request, removePath('msess_missing'), { participantId: 'cf_x' })).status).toBe(404);
  });

  it('rejects a body without participantId', async () => {
    const { sessionId } = await seed([participant(ORGANIZER)]);
    const { request } = appFor(ORGANIZER, 'sessions:read');

    const res = await postJson(request, removePath(sessionId), {});

    expect(res.status).toBe(400);
  });
});

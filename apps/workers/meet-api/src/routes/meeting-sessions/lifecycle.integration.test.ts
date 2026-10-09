/**
 * DB-backed lifecycle tests for /api/meeting-sessions/:id/{leave,end}.
 *
 * TASK-719: the host's Leave used to end the RTK meeting without disconnecting
 * anyone, never stamped leftAt on the participants, and (once kicks work) every
 * kicked client's /leave would have re-run the end and overwritten endedAt.
 *
 * Automatic ends (last leave, inactivity sweep, stale session on start) also
 * ask RealtimeKit whether the room is empty: our own participant list drifts,
 * and trusting it kicked everyone out of a live meeting.
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
import {
  addParticipant,
  createMeeting,
  endMeeting,
  getLiveParticipantCount,
  kickAllParticipants,
  kickParticipants,
  removeParticipant,
} from '@weldsuite/cloudflare-realtime';
import { isGuestRemovedFromSession } from '@weldsuite/db/schema/meeting-sessions';
import { fakeKv, fakeRealtime, seedActiveChatCall } from '../../test/fakes';

vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  kickAllParticipants: vi.fn(),
  kickParticipants: vi.fn(),
  endMeeting: vi.fn(),
  getLiveParticipantCount: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  createMeeting: vi.fn(),
  ensurePresets: vi.fn(async () => undefined),
}));

const ORGANIZER = 'user_organizer';
const GUEST = 'user_guest';
const CF_APP_ID = 'rtk_meeting_1';

let db: Database;
/** The REALTIME binding of the current test: records every publish. */
let realtime = fakeRealtime();
/** Background work the routes hand to `waitUntil` (evictions run after the response). */
const pending: Promise<unknown>[] = [];
const flush = async () => {
  await Promise.all(pending.splice(0));
};

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => {
  vi.mocked(kickAllParticipants).mockReset().mockResolvedValue(2);
  vi.mocked(kickParticipants).mockReset().mockResolvedValue(undefined);
  vi.mocked(endMeeting).mockReset().mockResolvedValue(undefined);
  // By default RealtimeKit reports an empty room.
  vi.mocked(getLiveParticipantCount).mockReset().mockResolvedValue(0);
  vi.mocked(addParticipant).mockReset().mockResolvedValue({ id: 'cf_new', token: 'tok_new' } as never);
  vi.mocked(removeParticipant).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(createMeeting).mockReset().mockResolvedValue({ id: 'rtk_created' } as never);
  realtime = fakeRealtime();
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
  opts: { status?: 'active' | 'ended'; metadata?: Record<string, unknown>; cfAppId?: string } = {},
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
    cfAppId: opts.cfAppId ?? CF_APP_ID,
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
    WORKSPACE_CACHE: fakeKv(),
    REALTIME: realtime.binding,
  } satisfies Partial<Env>;
  const app = createTestApp('/api/meeting-sessions', meetingSessionsRoutes, {
    context: { permissions: permissions(...perms), userId, tenantDb: db },
    env,
  });
  app.executionCtx.waitUntil = (promise: Promise<unknown>) => {
    pending.push(Promise.resolve(promise).catch(() => undefined));
  };
  return app;
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

  it('still auto-ends when the last participant leaves and RealtimeKit reports the room empty', async () => {
    const { meetingId, sessionId } = await seed([
      participant(ORGANIZER, { leftAt: new Date().toISOString() }),
      participant(GUEST),
    ]);
    const { request } = appFor(GUEST, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/leave`);

    expect(res.status).toBe(200);
    expect(getLiveParticipantCount).toHaveBeenCalledWith(expect.anything(), CF_APP_ID);
    const session = await loadSession(sessionId);
    expect(session.status).toBe('ended');
    expect(session.participants?.every((p) => !!p.leftAt)).toBe(true);
    expect((await loadMeeting(meetingId)).activeSessionId).toBeNull();
    expect(endMeeting).toHaveBeenCalledTimes(1);
  });

  it('does not end or kick when our list says everyone left but RealtimeKit still has people in the room', async () => {
    // The organizer is in the call, but a late leave webhook for their old
    // connection marked them as left. The guest now leaves.
    const { meetingId, sessionId } = await seed([
      participant(ORGANIZER, { leftAt: new Date().toISOString() }),
      participant(GUEST),
    ]);
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const { request } = appFor(GUEST, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/leave`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const session = await loadSession(sessionId);
    expect(session.status).toBe('active');
    expect(session.endedAt).toBeNull();
    expect(session.participants?.find((p) => p.userId === GUEST)?.leftAt).toBeTruthy();
    expect((await loadMeeting(meetingId)).activeSessionId).toBe(sessionId);
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it('keeps the session when RealtimeKit cannot be asked', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sessionId } = await seed([participant(GUEST)]);
    vi.mocked(getLiveParticipantCount).mockRejectedValue(new Error('Failed to get RTK active session: 500'));
    const { request } = appFor(GUEST, 'sessions:read');

    const res = await post(request, `/api/meeting-sessions/${sessionId}/leave`);

    expect(res.status).toBe(200);
    expect((await loadSession(sessionId)).status).toBe('active');
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[MeetingLifecycle] RTK live participant check failed, keeping the session',
      expect.objectContaining({ sessionId, cfAppId: CF_APP_ID }),
    );
  });
});

describe('stale-session cleanup', () => {
  const longAgo = () => new Date(Date.now() - 30 * 60_000);
  const left = () => ({ leftAt: longAgo().toISOString() });

  /** A session our list considers abandoned: nobody active, untouched for 30 minutes. */
  async function seedAbandoned() {
    const seeded = await seed([participant(ORGANIZER, left()), participant(GUEST, left())]);
    await db
      .update(schema.meetingSessions)
      .set({ createdAt: longAgo(), updatedAt: longAgo() })
      .where(eq(schema.meetingSessions.id, seeded.sessionId));
    return seeded;
  }

  it('GET /active ends an abandoned session once RealtimeKit confirms the room is empty', async () => {
    const { meetingId, sessionId } = await seedAbandoned();
    const { request } = appFor('user_late', 'sessions:read');

    const res = await request(`/api/meeting-sessions/active?meetingId=${meetingId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
    expect((await loadSession(sessionId)).status).toBe('ended');
  });

  it('GET /active returns the session instead of ending it while people are still in the room', async () => {
    const { meetingId, sessionId } = await seedAbandoned();
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { request } = appFor('user_late', 'sessions:read');

    const res = await request(`/api/meeting-sessions/active?meetingId=${meetingId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; status: string } | null };
    expect(body.data).toMatchObject({ id: sessionId, status: 'active' });
    expect((await loadSession(sessionId)).status).toBe('active');
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it('POST /start reports a conflict instead of ending a session people are still in', async () => {
    const { meetingId, sessionId } = await seedAbandoned();
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { request } = appFor('user_late', 'sessions:read', 'sessions:create');

    const res = await postJson(request, '/api/meeting-sessions/start', { meetingId });

    expect(res.status).toBe(409);
    expect((await loadSession(sessionId)).status).toBe('active');
    expect((await loadMeeting(meetingId)).activeSessionId).toBe(sessionId);
    expect(kickAllParticipants).not.toHaveBeenCalled();
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

// ============================================================================
// One LIVE call at a time: joining leaves every other session / chat call
// ============================================================================

// A fresh user per test: the sessions and calls of one test stay in the shared DB.
let JOINER = 'user_joiner';
let joinerSeq = 0;
beforeEach(() => {
  joinerSeq += 1;
  JOINER = `user_joiner_${joinerSeq}`;
});

const superseded = () => realtime.published.filter((e) => e.event === 'call_superseded');
const removedFrom = () => vi.mocked(removeParticipant).mock.calls.map((c) => [c[1], c[2]]);
const killedRooms = () => vi.mocked(kickAllParticipants).mock.calls.map((c) => c[1]);

async function loadChatCall(callId: string) {
  const [row] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, callId)).limit(1);
  if (!row) throw new Error('call missing');
  return row;
}

describe('POST /api/meeting-sessions/:id/join · one live call at a time', () => {
  const join = async (sessionId: string) => {
    const { request } = appFor(JOINER, 'sessions:read');
    const res = await post(request, `/api/meeting-sessions/${sessionId}/join`);
    await flush();
    return res;
  };

  it('leaves every other meeting session and chat call, never the session just joined', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1); // others stay connected
    const target = await seed([participant(ORGANIZER)], { cfAppId: 'rtk_target' });
    const other = await seed([participant(ORGANIZER), participant(JOINER, { cfSessionId: 'cf_joiner_other' })], {
      cfAppId: 'rtk_other',
    });
    const chat = await seedActiveChatCall(db, {
      userId: JOINER,
      otherUserId: GUEST,
      cfAppId: 'rtk_chat_1',
      cfSessionId: 'cf_joiner_chat',
    });

    const res = await join(target.sessionId);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { authToken: string } }).data.authToken).toBe('tok_new');

    // Dropped from the other session and from the chat call ...
    expect(removedFrom()).toContainEqual(['rtk_other', 'cf_joiner_other']);
    expect(removedFrom()).toContainEqual(['rtk_chat_1', 'cf_joiner_chat']);
    const otherAfter = await loadSession(other.sessionId);
    expect(otherAfter.participants?.find((p) => p.userId === JOINER)?.leftAt).toBeTruthy();
    expect(otherAfter.participants?.find((p) => p.userId === ORGANIZER)?.leftAt).toBeUndefined();
    expect(otherAfter.status).toBe('active');
    const chatAfter = await loadChatCall(chat.callId);
    expect(chatAfter.participants?.find((p) => p.userId === JOINER)?.leftAt).toBeTruthy();
    expect(chatAfter.participants?.find((p) => p.userId === GUEST)?.leftAt).toBeUndefined();
    expect(chatAfter.status).toBe('active');
    expect(killedRooms()).not.toContain('rtk_other');
    expect(killedRooms()).not.toContain('rtk_chat_1');

    // ... and told why, as the contract says.
    // (`_access` is how the hub keeps the event on the user's own sockets; it strips it.)
    expect(superseded().every((e) => (e.data._access as { userIds: string[] }).userIds[0] === JOINER)).toBe(true);
    expect(superseded().map(({ topic, data: { _access, ...data } }) => ({ topic, ...data }))).toEqual(
      expect.arrayContaining([
        {
          topic: `chat.user.${JOINER}`,
          kind: 'meet',
          id: other.sessionId,
          meetingId: other.meetingId,
          cfSessionId: 'cf_joiner_other',
        },
        { topic: `chat.user.${JOINER}`, kind: 'chat', id: chat.callId, cfSessionId: 'cf_joiner_chat' },
      ]),
    );

    // The session just joined is untouched and now holds the joiner.
    expect(removedFrom().map(([room]) => room)).not.toContain('rtk_target');
    const targetAfter = await loadSession(target.sessionId);
    const entry = targetAfter.participants?.find((p) => p.userId === JOINER);
    expect(entry).toMatchObject({ cfSessionId: 'cf_new' });
    expect(entry?.leftAt).toBeUndefined();
  });

  it('never ends a meeting the evicted organizer leaves while others are still in it', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const target = await seed([participant(ORGANIZER)], { cfAppId: 'rtk_target' });
    // The joiner organises the other meeting.
    const other = await seed([participant(JOINER, { cfSessionId: 'cf_joiner_org' }), participant(GUEST)], {
      cfAppId: 'rtk_other_org',
    });
    await db
      .update(schema.meetings)
      .set({ organizerId: JOINER })
      .where(eq(schema.meetings.id, other.meetingId));

    await join(target.sessionId);

    const after = await loadSession(other.sessionId);
    expect(after.status).toBe('active');
    expect(after.endedAt).toBeNull();
    expect(killedRooms()).not.toContain('rtk_other_org');
    expect(vi.mocked(endMeeting).mock.calls.map((c) => c[1])).not.toContain('rtk_other_org');
    expect((await loadMeeting(other.meetingId)).activeSessionId).toBe(other.sessionId);
  });

  it('ends the other session only once RealtimeKit confirms the room is empty', async () => {
    const target = await seed([participant(ORGANIZER)], { cfAppId: 'rtk_target' });

    // Still counting the connection that was just removed: stays.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const busy = await seed([participant(JOINER, { cfSessionId: 'cf_joiner_busy' })], { cfAppId: 'rtk_busy' });
    await join(target.sessionId);
    expect((await loadSession(busy.sessionId)).status).toBe('active');
    expect(killedRooms()).not.toContain('rtk_busy');

    // Empty: ended, as /leave would.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(0);
    const empty = await seed([participant(JOINER, { cfSessionId: 'cf_joiner_empty' })], { cfAppId: 'rtk_empty' });
    await join(target.sessionId);
    expect((await loadSession(empty.sessionId)).status).toBe('ended');
    expect(killedRooms()).toContain('rtk_empty');
  });

  it("drops the user's OLDER connection in the same session, never the one just created", async () => {
    // The joiner is already in the session from another tab (cf_joiner_old); this join gets cf_new.
    const target = await seed(
      [participant(ORGANIZER), participant(JOINER, { cfSessionId: 'cf_joiner_old' })],
      { cfAppId: 'rtk_target' },
    );

    const res = await join(target.sessionId);

    expect(res.status).toBe(200);
    expect(removedFrom()).toContainEqual(['rtk_target', 'cf_joiner_old']);
    expect(removedFrom()).not.toContainEqual(['rtk_target', 'cf_new']);
    expect(superseded().map((e) => e.data)).toContainEqual(
      expect.objectContaining({
        kind: 'meet',
        id: target.sessionId,
        meetingId: target.meetingId,
        cfSessionId: 'cf_joiner_old',
      }),
    );
    // One entry for the user, carrying the new connection, still in the session.
    const session = await loadSession(target.sessionId);
    const entries = session.participants?.filter((p) => p.userId === JOINER) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cfSessionId: 'cf_new' });
    expect(entries[0]?.leftAt).toBeUndefined();
    expect(session.status).toBe('active');
    expect(killedRooms()).not.toContain('rtk_target');
  });

  it('does not touch the connection when RealtimeKit hands back the id that is already stored', async () => {
    vi.mocked(addParticipant).mockResolvedValue({ id: 'cf_joiner_same', token: 'tok_same' } as never);
    const target = await seed(
      [participant(ORGANIZER), participant(JOINER, { cfSessionId: 'cf_joiner_same' })],
      { cfAppId: 'rtk_target' },
    );

    await join(target.sessionId);

    expect(removedFrom()).not.toContainEqual(['rtk_target', 'cf_joiner_same']);
    expect(superseded().filter((e) => e.data.id === target.sessionId)).toEqual([]);
  });

  it('has no older connection to drop when the previous entry already left', async () => {
    const target = await seed(
      [
        participant(ORGANIZER),
        participant(JOINER, { cfSessionId: 'cf_joiner_gone', leftAt: new Date(Date.now() - 5_000).toISOString() }),
      ],
      { cfAppId: 'rtk_target' },
    );

    await join(target.sessionId);

    expect(removedFrom()).not.toContainEqual(['rtk_target', 'cf_joiner_gone']);
    const entry = (await loadSession(target.sessionId)).participants?.find((p) => p.userId === JOINER);
    expect(entry).toMatchObject({ cfSessionId: 'cf_new', stints: 2 });
    expect(entry?.leftAt).toBeUndefined();
  });

  it('leaves the current call alone when the join does not happen', async () => {
    // The host has not arrived: the route answers "wait" without joining anyone.
    const target = await seed([participant(GUEST)], { cfAppId: 'rtk_target' });
    await db
      .update(schema.meetings)
      .set({ hostMustJoinFirst: true })
      .where(eq(schema.meetings.id, target.meetingId));
    const other = await seed([participant(JOINER, { cfSessionId: 'cf_joiner_keep' })], { cfAppId: 'rtk_keep' });

    const res = await join(target.sessionId);

    expect(((await res.json()) as { data: { reason?: string } }).data.reason).toBe('host_must_join_first');
    expect(addParticipant).not.toHaveBeenCalled();
    expect(removeParticipant).not.toHaveBeenCalled();
    expect((await loadSession(other.sessionId)).participants?.[0]?.leftAt).toBeUndefined();
  });

  it('leaves the current call alone when RealtimeKit refuses the join', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(addParticipant).mockRejectedValue(new Error('RTK 500'));
    const target = await seed([participant(ORGANIZER)], { cfAppId: 'rtk_target' });
    const other = await seed([participant(JOINER, { cfSessionId: 'cf_joiner_keep2' })], { cfAppId: 'rtk_keep2' });

    const res = await join(target.sessionId);

    expect(res.status).toBe(500);
    expect(removeParticipant).not.toHaveBeenCalled();
    expect((await loadSession(other.sessionId)).participants?.[0]?.leftAt).toBeUndefined();
  });
});

describe('POST /api/meeting-sessions/start?join=true · one live call at a time', () => {
  it('leaves every other meeting session and chat call, never the session it just started', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    vi.mocked(createMeeting).mockResolvedValue({ id: 'rtk_started' } as never);
    vi.mocked(addParticipant).mockResolvedValue({ id: 'cf_joiner_started', token: 'tok_started' } as never);
    const meetingId = generateId('mtg');
    await db.insert(schema.meetings).values({ id: meetingId, title: 'Fresh', organizerId: JOINER, status: 'scheduled' });
    const other = await seed([participant(ORGANIZER), participant(JOINER, { cfSessionId: 'cf_joiner_other2' })], {
      cfAppId: 'rtk_other2',
    });
    const chat = await seedActiveChatCall(db, {
      userId: JOINER,
      otherUserId: GUEST,
      cfAppId: 'rtk_chat_2',
      cfSessionId: 'cf_joiner_chat2',
    });
    const { request } = appFor(JOINER, 'sessions:read', 'sessions:create');

    const res = await postJson(request, '/api/meeting-sessions/start?join=true', { meetingId });
    await flush();

    expect(res.status).toBe(201);
    const { sessionId } = ((await res.json()) as { data: { sessionId: string } }).data;
    expect(removedFrom()).toContainEqual(['rtk_other2', 'cf_joiner_other2']);
    expect(removedFrom()).toContainEqual(['rtk_chat_2', 'cf_joiner_chat2']);
    expect(removedFrom().map(([room]) => room)).not.toContain('rtk_started');
    expect((await loadSession(other.sessionId)).participants?.find((p) => p.userId === JOINER)?.leftAt).toBeTruthy();
    expect((await loadChatCall(chat.callId)).participants?.find((p) => p.userId === JOINER)?.leftAt).toBeTruthy();
    const started = await loadSession(sessionId);
    expect(started.participants?.find((p) => p.userId === JOINER)?.leftAt).toBeUndefined();
    expect(superseded().map((e) => e.data.id)).toEqual(expect.arrayContaining([other.sessionId, chat.callId]));
  });

  it('does not leave anything when the session is started without joining', async () => {
    vi.mocked(createMeeting).mockResolvedValue({ id: 'rtk_started_nojoin' } as never);
    const meetingId = generateId('mtg');
    await db.insert(schema.meetings).values({ id: meetingId, title: 'Later', organizerId: JOINER, status: 'scheduled' });
    await seed([participant(JOINER, { cfSessionId: 'cf_joiner_still' })], { cfAppId: 'rtk_still' });
    const { request } = appFor(JOINER, 'sessions:read', 'sessions:create');

    const res = await postJson(request, '/api/meeting-sessions/start', { meetingId });
    await flush();

    expect(res.status).toBe(201);
    expect(addParticipant).not.toHaveBeenCalled();
    expect(removeParticipant).not.toHaveBeenCalled();
  });
});

/**
 * DB-backed lifecycle tests for /api/chat-calls: which requests end a call.
 *
 * Ending a call kicks everyone out of its RealtimeKit room, so every automatic
 * end (last leave, stale-call sweeps, the one-call-at-a-time eviction, a new
 * call replacing an abandoned one) asks RealtimeKit whether the room is empty
 * first. Our own participant list drifts, and trusting it ended live calls for
 * the people still talking. Only an explicit POST /:id/end is unconditional.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { leaveOtherMeetingSessions } from '@weldsuite/meet-domain/leave-other-sessions';
import {
  addParticipant,
  createMeeting,
  endMeeting,
  getLiveParticipantCount,
  kickAllParticipants,
  removeParticipant,
} from '@weldsuite/cloudflare-realtime';
import type { Env } from '../../types';
import { chatCallsRoutes } from './index';
import { leaveOtherActiveCalls } from '../../services/chat/call-participants';

vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  createMeeting: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  kickAllParticipants: vi.fn(),
  endMeeting: vi.fn(),
  getLiveParticipantCount: vi.fn(),
}));

vi.mock('@weldsuite/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/notifications')>()),
  sendMissedCallNotification: vi.fn(async () => undefined),
  sendIncomingCallNotification: vi.fn(async () => undefined),
}));

const ALICE = 'user_call_alice';
const BOB = 'user_call_bob';
// The "one live call at a time" tests use their own users, so the calls the
// other tests of this file leave behind never interfere with them.
const ERIN = 'user_call_erin';
const FRANK = 'user_call_frank';

let db: Database;

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

const env = () => ({ WORKSPACE_CACHE: fakeKv() }) as unknown as Env;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_call_alice', userId: ALICE, email: 'alice@example.com', name: 'Alice', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_call_bob', userId: BOB, email: 'bob@example.com', name: 'Bob', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_call_erin', userId: ERIN, email: 'erin@example.com', name: 'Erin', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_call_frank', userId: FRANK, email: 'frank@example.com', name: 'Frank', role: 'MEMBER', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  vi.mocked(createMeeting).mockReset().mockResolvedValue({ id: 'rtk_new' } as never);
  vi.mocked(addParticipant).mockReset().mockResolvedValue({ id: 'cf_new', token: 'tok_new' } as never);
  vi.mocked(removeParticipant).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(kickAllParticipants).mockReset().mockResolvedValue(0);
  vi.mocked(endMeeting).mockReset().mockResolvedValue(undefined);
  // By default RealtimeKit reports an empty room.
  vi.mocked(getLiveParticipantCount).mockReset().mockResolvedValue(0);
});

function participant(userId: string, extra: Partial<ChatCallParticipant> = {}): ChatCallParticipant {
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

const left = (userId: string) => participant(userId, { leftAt: new Date(Date.now() - 5_000).toISOString() });

/** A channel with Alice and Bob in it, plus one call. */
async function seed(
  participants: ChatCallParticipant[],
  opts: {
    type?: 'dm' | 'public';
    status?: 'ringing' | 'active';
    /** How long ago the call was created and last touched. */
    ageMs?: number;
    /** Channel members (default Alice and Bob); [] = nobody, e.g. a public channel joined without membership. */
    members?: string[];
  } = {},
) {
  const channelId = generateId('ch');
  const callId = generateId('call');
  const cfAppId = `rtk_${callId}`;
  const at = new Date(Date.now() - (opts.ageMs ?? 5 * 60_000));
  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: channelId,
    slug: channelId,
    type: opts.type ?? 'dm',
  } as typeof schema.chatChannels.$inferInsert);
  const members = opts.members ?? [ALICE, BOB];
  if (members.length > 0) await db.insert(schema.chatChannelMembers).values(
    members.map((userId) => ({ id: generateId('chm'), channelId, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
  );
  await db.insert(schema.chatCalls).values({
    id: callId,
    channelId,
    callType: 'voice',
    status: opts.status ?? 'active',
    cfAppId,
    initiatorId: ALICE,
    initiatorName: 'Alice',
    participants,
    maxParticipants: participants.length,
    startedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  return { channelId, callId, cfAppId };
}

function appFor(userId: string, envOverride?: Env) {
  return createTestApp('/api/chat-calls', chatCallsRoutes, {
    context: {
      userId,
      permissions: permissions('channels:read', 'channels:create', 'channels:update'),
      tenantDb: db,
    },
    env: envOverride ?? env(),
  });
}

const post = (userId: string, path: string, body?: unknown) =>
  appFor(userId).request(`/api/chat-calls${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

async function loadCall(callId: string) {
  const [row] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, callId)).limit(1);
  if (!row) throw new Error('call missing');
  return row;
}

describe('POST /:callId/leave', () => {
  it('ends the call when the last participant leaves and RealtimeKit reports the room empty', async () => {
    const { callId, cfAppId } = await seed([left(ALICE), participant(BOB)]);

    const res = await post(BOB, `/${callId}/leave`);

    expect(res.status).toBe(200);
    const call = await loadCall(callId);
    expect(call.status).toBe('ended');
    expect(call.endedAt).not.toBeNull();
    expect(getLiveParticipantCount).toHaveBeenCalledWith(expect.anything(), cfAppId);
    expect(kickAllParticipants).toHaveBeenCalledWith(expect.anything(), cfAppId);
  });

  it('keeps a call that RealtimeKit still has someone in, although our list shows nobody', async () => {
    // Alice was recorded as left (a late leave webhook for a connection she has
    // since replaced) but is still talking. Bob hanging up must not kick her.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const { callId } = await seed([left(ALICE), participant(BOB)]);

    const res = await post(BOB, `/${callId}/leave`);

    expect(res.status).toBe(200);
    const call = await loadCall(callId);
    expect(call.status).toBe('active');
    expect(call.endedAt).toBeNull();
    expect(call.participants?.find((p) => p.userId === BOB)?.leftAt).toBeTruthy();
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it('keeps the call when RealtimeKit cannot be asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getLiveParticipantCount).mockRejectedValue(new Error('RTK 503'));
    const { callId } = await seed([left(ALICE), participant(BOB)]);

    const res = await post(BOB, `/${callId}/leave`);

    expect(res.status).toBe(200);
    expect((await loadCall(callId)).status).toBe('active');
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });

  it('does not ask RealtimeKit while our list still has someone in the call', async () => {
    const { callId } = await seed([participant(ALICE), participant(BOB)]);

    await post(BOB, `/${callId}/leave`);

    expect((await loadCall(callId)).status).toBe('active');
    expect(getLiveParticipantCount).not.toHaveBeenCalled();
  });

  it("ends an unanswered call as missed even while RealtimeKit still counts the caller's own connection", async () => {
    // The caller cancels the ring; their client reports the leave a moment
    // before RealtimeKit has dropped the connection. Nobody else ever joined.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const { callId } = await seed([participant(ALICE)]);

    await post(ALICE, `/${callId}/leave`);

    expect((await loadCall(callId)).status).toBe('missed');
  });

  it('keeps an unanswered-looking call that has two connections: the callee is in it', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { callId } = await seed([participant(ALICE)]);

    await post(ALICE, `/${callId}/leave`);

    expect((await loadCall(callId)).status).toBe('active');
  });
});

describe('POST /:callId/end', () => {
  it('ends the call for everyone without asking RealtimeKit', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { callId, cfAppId } = await seed([participant(ALICE), participant(BOB)]);

    const res = await post(ALICE, `/${callId}/end`);

    expect(res.status).toBe(200);
    expect((await loadCall(callId)).status).toBe('ended');
    expect(getLiveParticipantCount).not.toHaveBeenCalled();
    expect(kickAllParticipants).toHaveBeenCalledWith(expect.anything(), cfAppId);
  });
});

describe('GET /active/:channelId · stale-call sweep', () => {
  const get = (channelId: string) => appFor(ALICE).request(`/api/chat-calls/active/${channelId}`);

  it('ends a call that has been empty for five minutes once RealtimeKit agrees', async () => {
    const { channelId, callId } = await seed([left(ALICE), left(BOB)], { ageMs: 6 * 60_000 });

    const res = await get(channelId);

    expect(((await res.json()) as { data: unknown }).data).toBeNull();
    expect((await loadCall(callId)).status).toBe('ended');
  });

  it('returns the call instead of ending it when people are still in the room', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { channelId, callId } = await seed([left(ALICE), left(BOB)], { ageMs: 6 * 60_000 });

    const res = await get(channelId);

    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(callId);
    expect((await loadCall(callId)).status).toBe('active');
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });

  it('ends a call that rang for a minute without anyone connecting (no RealtimeKit session)', async () => {
    const { channelId, callId } = await seed([], { status: 'ringing', ageMs: 2 * 60_000 });

    const res = await get(channelId);

    expect(((await res.json()) as { data: unknown }).data).toBeNull();
    expect((await loadCall(callId)).status).toBe('missed');
  });
});

describe('POST /start-and-join · an abandoned call in the channel', () => {
  const start = (userId: string, channelId: string) =>
    post(userId, '/start-and-join', { channelId, callType: 'voice' });

  it("replaces the caller's own leftover DM call so the new one rings", async () => {
    // Only Alice's stale connection is left in the old room.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const { channelId, callId } = await seed([participant(ALICE), left(BOB)]);

    const res = await start(ALICE, channelId);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { callId: string } };
    expect(body.data.callId).not.toBe(callId);
    expect((await loadCall(callId)).status).toBe('ended');
    expect(createMeeting).toHaveBeenCalledTimes(1);
  });

  it('joins the call instead when RealtimeKit shows both people are still in it', async () => {
    // Bob is recorded as left but never stopped talking: the "leftover" call is live.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { channelId, callId, cfAppId } = await seed([participant(ALICE), left(BOB)]);

    const res = await start(ALICE, channelId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { callId: string } };
    expect(body.data.callId).toBe(callId);
    expect((await loadCall(callId)).status).toBe('active');
    expect(createMeeting).not.toHaveBeenCalled();
    expect(kickAllParticipants).not.toHaveBeenCalled();
    expect(addParticipant).toHaveBeenCalledWith(expect.anything(), cfAppId, expect.anything());
  });

  it('neither replaces nor joins the call when RealtimeKit cannot be asked', async () => {
    // Joining a call that may be dead would leave the caller alone in it
    // without ringing anyone; the client gets a conflict and can retry.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getLiveParticipantCount).mockRejectedValue(new Error('RTK 503'));
    const { channelId, callId } = await seed([participant(ALICE), left(BOB)]);

    const res = await start(ALICE, channelId);

    expect(res.status).toBe(409);
    expect((await loadCall(callId)).status).toBe('active');
    expect(createMeeting).not.toHaveBeenCalled();
    expect(addParticipant).not.toHaveBeenCalled();
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });

  it('still joins a live call that does not look abandoned without asking RealtimeKit', async () => {
    const { channelId, callId } = await seed([participant(ALICE), participant(BOB)]);

    const res = await start(ALICE, channelId);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { callId: string } }).data.callId).toBe(callId);
    expect(getLiveParticipantCount).not.toHaveBeenCalled();
  });

  it('in a channel, joins the existing call when even one connection is left in it', async () => {
    // A channel (not a DM): any connection means the call is in use.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const { channelId, callId } = await seed([left(ALICE), left(BOB)], { type: 'public', ageMs: 2 * 60_000 });

    const res = await start(ALICE, channelId);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { callId: string } }).data.callId).toBe(callId);
    expect((await loadCall(callId)).status).toBe('active');
  });
});

describe('POST / · an abandoned call in the channel', () => {
  it('reports a conflict instead of ending a call RealtimeKit still has people in', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const { channelId, callId } = await seed([participant(ALICE), left(BOB)]);

    const res = await post(ALICE, '', { channelId, callType: 'voice' });

    expect(res.status).toBe(409);
    expect((await loadCall(callId)).status).toBe('active');
    expect(createMeeting).not.toHaveBeenCalled();
  });
});

describe('leaveOtherActiveCalls · one call at a time', () => {
  it('evicts the user from their other call and ends it once RealtimeKit reports it empty', async () => {
    const { callId, cfAppId } = await seed([left(ALICE), participant(BOB)]);

    await leaveOtherActiveCalls(db, env(), 'org_test', BOB, 'call_elsewhere');

    expect(removeParticipant).toHaveBeenCalledWith(expect.anything(), cfAppId, `cf_${BOB}`);
    expect((await loadCall(callId)).status).toBe('ended');
  });

  it('marks the user as left but keeps the call while RealtimeKit still has someone in it', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const { callId } = await seed([left(ALICE), participant(BOB)]);

    await leaveOtherActiveCalls(db, env(), 'org_test', BOB, 'call_elsewhere');

    const call = await loadCall(callId);
    expect(call.status).toBe('active');
    expect(call.participants?.find((p) => p.userId === BOB)?.leftAt).toBeTruthy();
    expect(kickAllParticipants).not.toHaveBeenCalled();
  });
});

// ============================================================================
// One LIVE call at a time, across WeldChat calls and WeldMeet sessions
// ============================================================================

const ORG = 'org_test';

/** Env with a REALTIME binding that records every publish (`call_superseded` included). */
function realtimeEnv() {
  const published: Array<{ workspaceId: string; topic: string; event: string; data: Record<string, unknown> }> = [];
  const REALTIME = {
    fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
      published.push(JSON.parse(String(init?.body)));
      return new Response('{}');
    }),
  } as unknown as Fetcher;
  return { env: { WORKSPACE_CACHE: fakeKv(), REALTIME } as unknown as Env, published, realtime: REALTIME };
}

const superseded = (published: ReturnType<typeof realtimeEnv>['published']) =>
  published.filter((e) => e.event === 'call_superseded');

/** POST and wait for the `waitUntil` work (the eviction runs after the response). */
async function postAndFlush(userId: string, path: string, envOverride: Env) {
  const app = appFor(userId, envOverride);
  const pending: Promise<unknown>[] = [];
  app.executionCtx.waitUntil = (promise: Promise<unknown>) => {
    pending.push(promise);
  };
  const res = await app.request(`/api/chat-calls${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  await Promise.all(pending);
  return res;
}

function sessionParticipant(
  userId: string,
  extra: Partial<MeetingSessionParticipant> = {},
): MeetingSessionParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: new Date(Date.now() - 60_000).toISOString(),
    cfSessionId: `cfm_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  };
}

/** A meeting with one session, 'active' by default. */
async function seedMeetingSession(
  participants: MeetingSessionParticipant[],
  opts: { status?: 'waiting' | 'active' } = {},
) {
  const meetingId = generateId('mtg');
  const sessionId = generateId('msess');
  const cfAppId = `rtk_${sessionId}`;
  await db.insert(schema.meetings).values({
    id: meetingId,
    title: 'Standup',
    organizerId: ERIN,
    status: 'in_progress',
    activeSessionId: null,
  });
  await db.insert(schema.meetingSessions).values({
    id: sessionId,
    meetingId,
    status: opts.status ?? 'active',
    cfAppId,
    startedBy: ERIN,
    startedByName: 'Erin',
    participants,
    startedAt: new Date(Date.now() - 5 * 60_000),
  });
  await db.update(schema.meetings).set({ activeSessionId: sessionId }).where(eq(schema.meetings.id, meetingId));
  return { meetingId, sessionId, cfAppId };
}

async function loadSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(schema.meetingSessions)
    .where(eq(schema.meetingSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('session missing');
  return row;
}

const killedRoomsOf = () => vi.mocked(kickAllParticipants).mock.calls.map((c) => c[1]);
const removedFrom = () => vi.mocked(removeParticipant).mock.calls.map((c) => c[1]);

describe('POST /:callId/join · one live call at a time', () => {
  it('also leaves the meeting session the user is in, telling their clients first', async () => {
    const { env: rtEnv, published, realtime } = realtimeEnv();
    // Erin is still in the meeting: Frank's departure must not end it.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const meeting = await seedMeetingSession([sessionParticipant(ERIN), sessionParticipant(FRANK)]);
    const { callId } = await seed([participant(ERIN)], { members: [ERIN, FRANK] });

    const res = await postAndFlush(FRANK, `/${callId}/join`, rtEnv);

    expect(res.status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(expect.anything(), meeting.cfAppId, `cfm_${FRANK}`);
    const session = await loadSession(meeting.sessionId);
    expect(session.participants?.find((p) => p.userId === FRANK)?.leftAt).toBeTruthy();
    expect(session.participants?.find((p) => p.userId === ERIN)?.leftAt).toBeUndefined();
    expect(session.status).toBe('active');
    expect(killedRoomsOf()).not.toContain(meeting.cfAppId);

    // The contract the platform subscribes to, sent before the RTK removal.
    const events = superseded(published);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: 'org_test_default', // the test harness's default org
      topic: `chat.user.${FRANK}`,
      event: 'call_superseded',
      data: { kind: 'meet', id: meeting.sessionId, meetingId: meeting.meetingId, cfSessionId: `cfm_${FRANK}` },
    });
    const removal = vi.mocked(removeParticipant).mock.calls.findIndex((c) => c[1] === meeting.cfAppId);
    const announce = vi
      .mocked(realtime.fetch)
      .mock.calls.findIndex((c) => String((c[1] as RequestInit).body).includes('call_superseded'));
    expect(vi.mocked(realtime.fetch).mock.invocationCallOrder[announce]).toBeLessThan(
      vi.mocked(removeParticipant).mock.invocationCallOrder[removal]!,
    );
  });

  it('does not end the meeting while RealtimeKit still reports a connection, ends it once the room is empty', async () => {
    // Frank is alone in his meeting, but RealtimeKit still counts the connection that was just removed.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);
    const occupied = await seedMeetingSession([sessionParticipant(FRANK, { cfSessionId: 'cfm_frank_a' })]);
    const { callId } = await seed([participant(ERIN)], { members: [ERIN, FRANK] });

    await postAndFlush(FRANK, `/${callId}/join`, realtimeEnv().env);

    const afterOccupied = await loadSession(occupied.sessionId);
    expect(afterOccupied.status).toBe('active');
    expect(afterOccupied.participants?.[0]?.leftAt).toBeTruthy();
    expect(killedRoomsOf()).not.toContain(occupied.cfAppId);

    // The same, once RealtimeKit reports the room empty.
    vi.mocked(getLiveParticipantCount).mockResolvedValue(0);
    const empty = await seedMeetingSession([sessionParticipant(FRANK, { cfSessionId: 'cfm_frank_b' })]);
    const second = await seed([participant(ERIN)], { members: [ERIN, FRANK] });

    await postAndFlush(FRANK, `/${second.callId}/join`, realtimeEnv().env);

    expect((await loadSession(empty.sessionId)).status).toBe('ended');
    expect(killedRoomsOf()).toContain(empty.cfAppId);
  });

  it('never ends a meeting for everyone because its organizer is evicted while others are still in', async () => {
    vi.mocked(getLiveParticipantCount).mockResolvedValue(2);
    const meeting = await seedMeetingSession([sessionParticipant(FRANK), sessionParticipant(ERIN)]);
    await db.update(schema.meetings).set({ organizerId: FRANK }).where(eq(schema.meetings.id, meeting.meetingId));
    const { callId } = await seed([participant(ERIN)], { members: [ERIN, FRANK] });

    await postAndFlush(FRANK, `/${callId}/join`, realtimeEnv().env);

    const session = await loadSession(meeting.sessionId);
    expect(session.status).toBe('active');
    expect(session.endedAt).toBeNull();
    expect(killedRoomsOf()).not.toContain(meeting.cfAppId);
    expect(vi.mocked(endMeeting).mock.calls.map((c) => c[1])).not.toContain(meeting.cfAppId);
  });

  it('leaves portal guests and entries that already left alone', async () => {
    const guests = await seedMeetingSession([
      sessionParticipant(`guest:${FRANK}@example.com`),
      sessionParticipant(FRANK, { leftAt: new Date(Date.now() - 5_000).toISOString() }),
    ]);
    const { callId } = await seed([participant(ERIN)], { members: [ERIN, FRANK] });

    await postAndFlush(FRANK, `/${callId}/join`, realtimeEnv().env);

    expect(removedFrom()).not.toContain(guests.cfAppId);
    const session = await loadSession(guests.sessionId);
    expect(session.participants?.find((p) => p.userId.startsWith('guest:'))?.leftAt).toBeUndefined();
  });

  it('joining the same call again tells the older tab why it is dropped, never the new connection', async () => {
    const { env: rtEnv, published } = realtimeEnv();
    // Frank is already in this call from another tab; the new join gets cf_new.
    const { callId, cfAppId } = await seed(
      [participant(ERIN), participant(FRANK, { cfSessionId: 'cf_frank_old' })],
      { members: [ERIN, FRANK] },
    );

    const res = await postAndFlush(FRANK, `/${callId}/join`, rtEnv);

    expect(res.status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(expect.anything(), cfAppId, 'cf_frank_old');
    expect(removeParticipant).not.toHaveBeenCalledWith(expect.anything(), cfAppId, 'cf_new');
    expect(superseded(published).map((e) => e.data)).toContainEqual(
      expect.objectContaining({ kind: 'chat', id: callId, cfSessionId: 'cf_frank_old' }),
    );
  });
});

describe('leaveOtherActiveCalls · who counts as being in another call', () => {
  it('finds a call in a public channel the user joined without being a member', async () => {
    const { callId, cfAppId } = await seed(
      [participant(ERIN), participant(FRANK, { cfSessionId: 'cf_frank_public' })],
      { type: 'public', members: [] },
    );
    vi.mocked(getLiveParticipantCount).mockResolvedValue(1);

    await leaveOtherActiveCalls(db, env(), ORG, FRANK, 'call_elsewhere');

    expect(removeParticipant).toHaveBeenCalledWith(expect.anything(), cfAppId, 'cf_frank_public');
    const call = await loadCall(callId);
    expect(call.participants?.find((p) => p.userId === FRANK)?.leftAt).toBeTruthy();
    expect(call.participants?.find((p) => p.userId === ERIN)?.leftAt).toBeUndefined();
    expect(call.status).toBe('active');
  });

  it('never leaves the call it was told to spare, and skips a join that is newer than the request', async () => {
    const spared = await seed([participant(FRANK, { cfSessionId: 'cf_frank_spared' })], { members: [ERIN, FRANK] });
    const newer = await seed(
      [participant(FRANK, { cfSessionId: 'cf_frank_newer', joinedAt: new Date(Date.now() + 5_000).toISOString() })],
      { members: [ERIN, FRANK] },
    );

    await leaveOtherActiveCalls(db, env(), ORG, FRANK, spared.callId);

    const removed = vi.mocked(removeParticipant).mock.calls.map((c) => c[2]);
    expect(removed).not.toContain('cf_frank_spared');
    expect(removed).not.toContain('cf_frank_newer');
    expect((await loadCall(spared.callId)).participants?.[0]?.leftAt).toBeUndefined();
    expect((await loadCall(newer.callId)).participants?.[0]?.leftAt).toBeUndefined();
  });
});

describe('leaveOtherMeetingSessions · from the chat side', () => {
  it('skips a meeting participation that began after the triggering join', async () => {
    const meeting = await seedMeetingSession([
      sessionParticipant(FRANK, { joinedAt: new Date(Date.now() + 5_000).toISOString(), cfSessionId: 'cfm_frank_newer' }),
    ]);

    await leaveOtherMeetingSessions(db, env(), ORG, FRANK, null);

    expect(vi.mocked(removeParticipant).mock.calls.map((c) => c[2])).not.toContain('cfm_frank_newer');
    expect((await loadSession(meeting.sessionId)).participants?.[0]?.leftAt).toBeUndefined();
  });
});

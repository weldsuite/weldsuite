/**
 * "One live call at a time" across WeldMeet and WeldChat: joining a meeting
 * session also leaves the user's WeldChat calls.
 *
 * TypeScript only, outside the Rust conformance suite: the Kubernetes
 * editions have no WeldChat calls (`chat-calls` is unavailable there), so the
 * Rust backend never has a ringing or active call to leave. The rest of the
 * lifecycle runs on both backends in ./lifecycle.integration.test.ts.
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
});

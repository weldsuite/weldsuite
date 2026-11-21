/**
 * /api/chat-calls end to end, on both backends (the `chat: calls`
 * conformance suite): starting, joining, preparing, leaving, ending and
 * declining calls, the active-call reads and the call history.
 *
 * RealtimeKit is stubbed at the HTTP level (../../test/rtk-fake.ts), never
 * with `vi.mock`, so the Rust server reaches the same stub through its
 * outbound bridge. The ring timeout is mocked: it waits 25 s inside
 * `waitUntil`, and the Rust server runs it as a delayed job that conformance
 * builds don't start. lifecycle.integration.test.ts and the other files
 * here cover the finer lifecycle rules on the worker.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Env } from '../../types';
import { RTK_ENV, RTK_PRESETS_SEEDED, fakeKv, fakeRtkApi } from '../../test/rtk-fake';
import { chatCallsRoutes } from './index';

vi.mock('@weldsuite/chat-domain/call-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/chat-domain/call-lifecycle')>()),
  scheduleRingTimeout: vi.fn(),
}));

const ALICE = 'user_calls_alice';
const BOB = 'user_calls_bob';
const CAROL = 'user_calls_carol';
const DAVE = 'user_calls_dave';

const rtk = fakeRtkApi();
let db: Database;
let kv = fakeKv(RTK_PRESETS_SEEDED);
const pending: Promise<unknown>[] = [];

/**
 * Background work publishes concurrently on both backends (the DM ring
 * beside the caller's join), so its realtime publishes are compared as a set.
 */
function publishOrder(effects: { realtime: Array<{ path: string; body: unknown }> }) {
  const key = (publish: { path: string; body: unknown }) => {
    const body = (publish.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    return [publish.path, body.topic, body.event, data.type, data.action, data.userId].map(String).join('|');
  };
  return { ...effects, realtime: [...effects.realtime].sort((a, b) => key(a).localeCompare(key(b))) };
}

beforeAll(async () => {
  vi.stubGlobal('fetch', rtk.fetch);
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values(
    [
      [ALICE, 'Alice'],
      [BOB, 'Bob'],
      [CAROL, 'Carol'],
      [DAVE, 'Dave'],
    ].map(([userId, name]) => ({
      id: `wm_${userId}`,
      userId,
      email: `${name!.toLowerCase()}@example.com`,
      name,
      role: 'MEMBER',
      createdAt: now,
      updatedAt: now,
    })) as (typeof schema.workspaceMembers.$inferInsert)[],
  );
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  rtk.reset();
  kv = fakeKv(RTK_PRESETS_SEEDED);
  await Promise.allSettled(pending.splice(0));
});

function appFor(userId: string) {
  const app = createTestApp('/api/chat-calls', chatCallsRoutes, {
    context: {
      userId,
      permissions: permissions('channels:read', 'channels:create', 'channels:update'),
      tenantDb: db,
    },
    env: { ...RTK_ENV, WORKSPACE_CACHE: kv } as unknown as Env,
    normalizeEffects: publishOrder as never,
  });
  // Keep the harness's own waitUntil: conformance waits for this work
  // before comparing the side effects.
  const harnessWaitUntil = app.executionCtx.waitUntil.bind(app.executionCtx);
  app.executionCtx.waitUntil = (promise: Promise<unknown>) => {
    pending.push(Promise.resolve(promise).catch(() => undefined));
    harnessWaitUntil(promise);
  };
  return app;
}

const post = (userId: string, path: string, body?: unknown) =>
  appFor(userId).request(`/api/chat-calls${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const get = (userId: string, path: string) => appFor(userId).request(`/api/chat-calls${path}`);

/** A JSON answer, typed loosely for the assertions. */
interface Answer {
  data: Record<string, unknown> & {
    callId: string;
    id: string;
    callType: string;
    participants: ChatCallParticipant[];
  } & Array<Record<string, unknown>>;
  error: { message: string };
  pagination: { hasMore: boolean; cursor: string | null };
}

const read = async (res: Response) => (await res.json()) as Answer;

const flush = async () => {
  await Promise.allSettled(pending.splice(0));
};

async function channel(
  type: 'dm' | 'public' | 'private',
  members: string[],
  extra: Partial<typeof schema.chatChannels.$inferInsert> = {},
) {
  const id = generateId('ch');
  await db.insert(schema.chatChannels).values({ id, name: id, slug: id, type, ...extra } as typeof schema.chatChannels.$inferInsert);
  if (members.length > 0) {
    await db.insert(schema.chatChannelMembers).values(
      members.map((userId) => ({ id: generateId('chm'), channelId: id, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
    );
  }
  return id;
}

function participant(userId: string, extra: Partial<ChatCallParticipant> = {}): ChatCallParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: new Date(Date.now() - 30_000).toISOString(),
    cfSessionId: `cf_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  };
}

async function seedCall(
  channelId: string,
  participants: ChatCallParticipant[],
  opts: { status?: string; ageMs?: number; initiatorId?: string } = {},
) {
  const id = generateId('call');
  const at = new Date(Date.now() - (opts.ageMs ?? 30_000));
  await db.insert(schema.chatCalls).values({
    id,
    channelId,
    callType: 'voice',
    status: opts.status ?? 'active',
    cfAppId: `rtk_${id}`,
    initiatorId: opts.initiatorId ?? ALICE,
    initiatorName: 'Alice',
    participants,
    maxParticipants: participants.length,
    startedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  return { id, room: `rtk_${id}` };
}

async function loadCall(id: string) {
  const [row] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, id)).limit(1);
  return row!;
}

async function notices(channelId: string) {
  return db
    .select({ content: schema.chatMessages.content, metadata: schema.chatMessages.metadata })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.channelId, channelId));
}

describe('POST /start-and-join', () => {
  it('starts a call in a channel and puts the caller in it', async () => {
    const channelId = await channel('public', [ALICE, BOB]);

    const res = await post(ALICE, '/start-and-join', { channelId, callType: 'video' });
    expect(res.status).toBe(201);
    const { data } = await read(res);
    expect(data).toMatchObject({ authToken: 'tok_new', callType: 'video' });
    expect(data.participants).toEqual([expect.objectContaining({ userId: ALICE, userName: 'Alice', cfSessionId: 'cf_new' })]);
    await flush();

    const call = await loadCall(data.callId);
    expect(call).toMatchObject({ status: 'active', cfAppId: 'rtk_created', initiatorId: ALICE, callType: 'video' });
    expect(call.participants).toEqual([expect.objectContaining({ userId: ALICE, cfSessionId: 'cf_new' })]);
    expect(call.startMessageId).toBeTruthy();
    expect((await notices(channelId)).map((m) => m.content)).toEqual(['Alice started a video call']);
  });

  it('joins the call already live in the channel instead', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    const { id } = await seedCall(channelId, [participant(ALICE)]);

    const res = await post(BOB, '/start-and-join', { channelId, callType: 'video' });
    expect(res.status).toBe(200);
    const { data } = await read(res);
    // The call's own type, not the one asked for.
    expect(data).toMatchObject({ callId: id, callType: 'voice', authToken: 'tok_new' });
    expect(data.participants.map((p: ChatCallParticipant) => p.userId)).toEqual([ALICE, BOB]);
    await flush();
    expect((await loadCall(id)).maxParticipants).toBe(2);
  });

  it('starts a DM call and rings the other member', async () => {
    const channelId = await channel('dm', [ALICE, BOB]);

    const res = await post(ALICE, '/start-and-join', { channelId });
    expect(res.status).toBe(201);
    const { data } = await read(res);
    expect(data.callType).toBe('voice');
    await flush();

    // The DM keeps the room for its next calls.
    const roomKey = [...kv.store.keys()].find((k) => k.startsWith('chat-dm-room:') && k.endsWith(`:${channelId}`));
    expect(roomKey && kv.store.get(roomKey)).toBe('rtk_created');
    const [incoming] = await db
      .select({ type: schema.notifications.notificationType, userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.entityId, data.callId));
    expect(incoming).toEqual({ type: 'chat_incoming_call', userId: BOB });
  });

  it('refuses a channel the caller is not in, and a call type the channel switched off', async () => {
    const theirs = await channel('public', [BOB]);
    expect((await post(ALICE, '/start-and-join', { channelId: theirs })).status).toBe(403);

    const noVideo = await channel('public', [ALICE], { videoCallsEnabled: false });
    const res = await post(ALICE, '/start-and-join', { channelId: noVideo, callType: 'video' });
    expect(res.status).toBe(403);
    expect((await read(res)).error.message).toBe('Video calls are disabled in this channel');
  });

  it('validates the body', async () => {
    expect((await post(ALICE, '/start-and-join', { channelId: '' })).status).toBe(400);
    expect((await post(ALICE, '/start-and-join', { channelId: 'ch_x', callType: 'phone' })).status).toBe(400);
  });
});

describe('POST /', () => {
  it('starts a ringing call', async () => {
    const channelId = await channel('public', [ALICE, BOB]);

    const res = await post(ALICE, '', { channelId });
    expect(res.status).toBe(201);
    const { data } = await read(res);
    expect(data).toMatchObject({ status: 'ringing', meetingId: 'rtk_created' });
    expect((await loadCall(data.callId)).status).toBe('ringing');
  });

  it('refuses a second call while one is live', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    await seedCall(channelId, [participant(ALICE), participant(BOB)]);

    const res = await post(ALICE, '', { channelId });
    expect(res.status).toBe(409);
  });
});

describe('POST /:callId/prepare and /:callId/join', () => {
  it('hands the callee a token while it rings, and the join reuses it', async () => {
    const channelId = await channel('dm', [ALICE, BOB]);
    const { id, room } = await seedCall(channelId, [participant(ALICE)], { ageMs: 2_000 });

    const prepared = await post(BOB, `/${id}/prepare`);
    expect(prepared.status).toBe(200);
    expect((await read(prepared)).data).toEqual({ callId: id, channelId, callType: 'voice', authToken: 'tok_new' });
    // Preparing is not answering.
    expect((await loadCall(id)).participants).toHaveLength(1);

    const joined = await post(BOB, `/${id}/join`);
    expect(joined.status).toBe(200);
    const { data } = await read(joined);
    expect(data).toMatchObject({ callId: id, channelId, callType: 'voice', authToken: 'tok_new' });
    expect(data.participants.map((p: ChatCallParticipant) => p.userId)).toEqual([ALICE, BOB]);
    await flush();
    expect((await loadCall(id)).participants).toHaveLength(2);
    expect(rtk.seen('add', room)).toBe(true);
  });

  it('turns a ringing call active on the first join', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    const { id } = await seedCall(channelId, [], { status: 'ringing' });

    expect((await post(BOB, `/${id}/join`)).status).toBe(200);
    await flush();
    const call = await loadCall(id);
    expect(call.status).toBe('active');
    expect(call.startedAt).not.toBeNull();
  });

  it('refuses an unknown call, a channel the user cannot read, and an ended call', async () => {
    expect((await post(BOB, '/call_missing/join')).status).toBe(404);

    const secret = await channel('private', [ALICE]);
    const { id: hidden } = await seedCall(secret, [participant(ALICE)]);
    expect((await post(BOB, `/${hidden}/join`)).status).toBe(403);

    const open = await channel('public', [ALICE, BOB]);
    const { id: over } = await seedCall(open, [], { status: 'ended' });
    const res = await post(BOB, `/${over}/prepare`);
    expect(res.status).toBe(400);
    expect((await read(res)).error.message).toBe('Call is not joinable');
  });
});

describe('POST /:callId/leave, /end and /decline', () => {
  it('ends the call when the last person leaves and the room is empty', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    const { id } = await seedCall(channelId, [participant(ALICE), participant(BOB, { leftAt: new Date().toISOString() })]);

    const res = await post(ALICE, `/${id}/leave`);
    expect(res.status).toBe(200);
    expect((await read(res)).data).toEqual({ ok: true });
    const call = await loadCall(id);
    expect(call.status).toBe('ended');
    expect(call.endMessageId).toBeTruthy();
  });

  it('keeps the call while the provider still has people in the room', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    const { id, room } = await seedCall(channelId, [participant(ALICE), participant(BOB, { leftAt: new Date().toISOString() })]);
    rtk.state.live.set(room, 1);

    expect((await post(ALICE, `/${id}/leave`)).status).toBe(200);
    const call = await loadCall(id);
    expect(call.status).toBe('active');
    expect(call.participants?.every((p) => p.leftAt)).toBe(true);
  });

  it('ends a call for everyone', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    const { id, room } = await seedCall(channelId, [participant(ALICE), participant(BOB)]);
    rtk.state.live.set(room, 2);

    expect((await post(BOB, `/${id}/end`)).status).toBe(200);
    const call = await loadCall(id);
    expect(call.status).toBe('ended');
    expect(rtk.seen('kick-all', room)).toBe(true);
    expect((await notices(channelId)).map((m) => m.content)).toContain('Call ended — 30s');
  });

  it('declines a ringing DM call', async () => {
    const channelId = await channel('dm', [ALICE, BOB]);
    const { id } = await seedCall(channelId, [participant(ALICE)], { ageMs: 3_000 });

    expect((await post(BOB, `/${id}/decline`)).status).toBe(200);
    const call = await loadCall(id);
    expect(call.status).toBe('declined');
    expect(call.metadata).toEqual({ declinedBy: BOB });
    const [missed] = (await notices(channelId)).filter((m) => m.content === 'Missed call');
    expect(missed?.metadata).toEqual({ call: { callId: id, callType: 'voice', event: 'ended', outcome: 'declined', duration: 0 } });

    // Answered calls no longer ring.
    const answered = await seedCall(await channel('dm', [ALICE, BOB]), [participant(ALICE), participant(BOB)]);
    const res = await post(BOB, `/${answered.id}/decline`);
    expect(res.status).toBe(400);
    expect((await read(res)).error.message).toBe('Call is not ringing');
  });
});

describe('the reads', () => {
  it('lists the live calls of the caller\'s channels', async () => {
    const mine = await channel('public', [CAROL, ALICE]);
    const { id } = await seedCall(mine, [participant(ALICE), participant(CAROL, { leftAt: new Date().toISOString() })]);
    await seedCall(await channel('public', [ALICE]), [participant(ALICE)]);

    const res = await get(CAROL, '/active');
    expect(res.status).toBe(200);
    const { data } = await read(res);
    expect(data).toEqual([
      expect.objectContaining({ channelId: mine, callId: id, status: 'active', participantCount: 1, channelType: 'public' }),
    ]);
  });

  it('reads a channel\'s live call and a call by id', async () => {
    const channelId = await channel('public', [ALICE, BOB]);
    const { id } = await seedCall(channelId, [participant(ALICE), participant(ALICE, { cfSessionId: 'cf_dupe' })]);

    const active = await get(BOB, `/active/${channelId}`);
    expect(active.status).toBe(200);
    const { data } = await read(active);
    expect(data.id).toBe(id);
    // A user is listed once.
    expect(data.participants).toHaveLength(1);

    const byId = await get(BOB, `/${id}`);
    expect(byId.status).toBe(200);
    expect((await read(byId)).data.id).toBe(id);

    expect((await read(await get(BOB, `/active/${await channel('public', [])}`))).data).toBeNull();
    expect((await get(BOB, '/call_missing')).status).toBe(404);
  });

  it('lists the caller\'s call history, newest first', async () => {
    // Dave is in no other test's calls.
    const dm = await channel('dm', [ALICE, DAVE]);
    const older = await seedCall(dm, [participant(ALICE)], { status: 'missed', ageMs: 120_000 });
    const newer = await seedCall(dm, [participant(ALICE), participant(DAVE)], { status: 'ended', ageMs: 60_000 });

    const res = await get(DAVE, '/history?limit=1');
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.data).toEqual([
      expect.objectContaining({ id: newer.id, direction: 'incoming', outcome: 'answered', channelType: 'dm' }),
    ]);
    expect(body.data[0].counterpart).toEqual({ userId: ALICE, name: 'Alice', avatar: null });
    expect(body.pagination.hasMore).toBe(true);

    const next = await get(DAVE, `/history?limit=1&cursor=${body.pagination.cursor}`);
    expect((await read(next)).data).toEqual([expect.objectContaining({ id: older.id, outcome: 'missed' })]);

    expect((await get(DAVE, '/history?limit=0')).status).toBe(400);
  });
});

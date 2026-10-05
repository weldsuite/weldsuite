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
  await db.insert(schema.chatChannelMembers).values(
    [ALICE, BOB].map((userId) => ({ id: generateId('chm'), channelId, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
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

function appFor(userId: string) {
  return createTestApp('/api/chat-calls', chatCallsRoutes, {
    context: {
      userId,
      permissions: permissions('channels:read', 'channels:create', 'channels:update'),
      tenantDb: db,
    },
    env: env(),
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

/**
 * DB-backed tests for GET /api/chat-calls/history: a member's phone-style call
 * history, with each call's direction and outcome for that member.
 *
 * Every test makes its own people, so the calls one test leaves behind never
 * show up in another test's history.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Env } from '../../types';
import type { CallHistoryItem } from '../../services/chat/call-history';
import { chatCallsRoutes } from './index';

// The decline tests go through POST /:callId/decline, which tears the room down
// and sends the decliner a missed-call push.
vi.mock('@weldsuite/cloudflare-realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/cloudflare-realtime')>()),
  kickAllParticipants: vi.fn(async () => 0),
  endMeeting: vi.fn(async () => undefined),
}));

vi.mock('@weldsuite/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/notifications')>()),
  sendMissedCallNotification: vi.fn(async () => undefined),
  cancelIncomingCallPush: vi.fn(async () => undefined),
}));

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const env = () =>
  ({
    WORKSPACE_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
  }) as unknown as Env;

function appFor(userId: string) {
  const app = createTestApp('/api/chat-calls', chatCallsRoutes, {
    context: { userId, permissions: permissions('channels:read'), tenantDb: db },
    env: env(),
  });
  app.executionCtx.waitUntil = () => {};
  return app;
}

interface HistoryBody {
  data: Array<Omit<CallHistoryItem, 'startedAt' | 'endedAt' | 'createdAt'> & { createdAt: string }>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

async function history(userId: string, query = ''): Promise<HistoryBody> {
  const res = await appFor(userId).request(`/api/chat-calls/history${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryBody;
}

/** Workspace members with ids unique to the calling test. */
async function people<N extends string>(...names: N[]): Promise<Record<N, string>> {
  const now = new Date();
  const ids = {} as Record<N, string>;
  const rows = names.map((name) => {
    const userId = generateId('user');
    ids[name] = userId;
    return {
      id: generateId('wm'),
      userId,
      email: `${userId}@example.com`,
      name,
      picture: `https://img.example.com/${name}.png`,
      role: 'MEMBER',
      createdAt: now,
      updatedAt: now,
    };
  });
  await db.insert(schema.workspaceMembers).values(rows as (typeof schema.workspaceMembers.$inferInsert)[]);
  return ids;
}

async function channel(type: 'dm' | 'public' | 'private', members: string[], name?: string) {
  const id = generateId('ch');
  await db.insert(schema.chatChannels).values({
    id,
    name: name ?? id,
    slug: id,
    type,
  } as typeof schema.chatChannels.$inferInsert);
  if (members.length > 0) {
    await db.insert(schema.chatChannelMembers).values(
      members.map((userId) => ({ id: generateId('chm'), channelId: id, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
    );
  }
  return id;
}

function joined(userId: string): ChatCallParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: new Date(Date.now() - 60_000).toISOString(),
    leftAt: new Date(Date.now() - 5_000).toISOString(),
    cfSessionId: `cf_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
  };
}

let clock = Date.parse('2026-10-01T09:00:00Z');

async function call(opts: {
  channelId: string;
  initiatorId: string;
  initiatorName?: string;
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'declined';
  participants?: ChatCallParticipant[];
  duration?: number | null;
  callType?: 'voice' | 'video';
  createdAt?: Date;
}) {
  const id = generateId('call');
  // Each call a minute after the previous one, unless the test pins the time.
  clock += 60_000;
  const createdAt = opts.createdAt ?? new Date(clock);
  const over = opts.status === 'ended' || opts.status === 'missed' || opts.status === 'declined';
  await db.insert(schema.chatCalls).values({
    id,
    channelId: opts.channelId,
    callType: opts.callType ?? 'voice',
    status: opts.status,
    cfAppId: `rtk_${id}`,
    initiatorId: opts.initiatorId,
    initiatorName: opts.initiatorName ?? 'Caller',
    participants: opts.participants ?? [joined(opts.initiatorId)],
    maxParticipants: (opts.participants ?? []).length,
    startedAt: createdAt,
    endedAt: over ? new Date(createdAt.getTime() + 30_000) : null,
    duration: opts.duration ?? null,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

const find = (body: HistoryBody, callId: string) => body.data.find((r) => r.id === callId);

describe('GET /history', () => {
  it('lists an unanswered incoming DM call as missed, with the caller as the person to show', async () => {
    const { Alice, Bob } = await people('Alice', 'Bob');
    const dm = await channel('dm', [Alice, Bob]);
    const callId = await call({ channelId: dm, initiatorId: Bob, initiatorName: 'Bob', status: 'missed' });

    const forAlice = find(await history(Alice), callId);
    expect(forAlice).toMatchObject({
      channelId: dm,
      channelType: 'dm',
      callType: 'voice',
      status: 'missed',
      direction: 'incoming',
      outcome: 'missed',
      initiatorId: Bob,
      initiatorName: 'Bob',
      counterpart: { userId: Bob, name: 'Bob', avatar: 'https://img.example.com/Bob.png' },
      otherMembers: [{ userId: Bob, name: 'Bob', avatar: 'https://img.example.com/Bob.png' }],
    });

    // The same call, seen by the caller: nobody picked up.
    expect(find(await history(Bob), callId)).toMatchObject({
      direction: 'outgoing',
      outcome: 'missed',
      counterpart: { userId: Alice, name: 'Alice' },
    });
  });

  it('lists an outgoing call the other side picked up as answered, with its duration', async () => {
    const { Alice, Bob } = await people('Alice', 'Bob');
    const dm = await channel('dm', [Alice, Bob]);
    const callId = await call({
      channelId: dm,
      initiatorId: Alice,
      initiatorName: 'Alice',
      status: 'ended',
      participants: [joined(Alice), joined(Bob)],
      duration: 125,
      callType: 'video',
    });

    expect(find(await history(Alice), callId)).toMatchObject({
      callType: 'video',
      direction: 'outgoing',
      outcome: 'answered',
      duration: 125,
      counterpart: { userId: Bob, name: 'Bob', avatar: 'https://img.example.com/Bob.png' },
    });
    expect(find(await history(Bob), callId)).toMatchObject({ direction: 'incoming', outcome: 'answered' });
  });

  it('lists a declined call as declined for both sides', async () => {
    const { Alice, Bob } = await people('Alice', 'Bob');
    const dm = await channel('dm', [Alice, Bob]);
    // Still ringing: start-and-join creates it active with only the caller in it.
    const callId = await call({ channelId: dm, initiatorId: Bob, initiatorName: 'Bob', status: 'active' });
    expect(find(await history(Alice), callId)?.outcome).toBe('ongoing');

    const res = await appFor(Alice).request(`/api/chat-calls/${callId}/decline`, { method: 'POST' });
    expect(res.status).toBe(200);

    expect(find(await history(Alice), callId)).toMatchObject({
      status: 'declined',
      direction: 'incoming',
      outcome: 'declined',
    });
    expect(find(await history(Bob), callId)).toMatchObject({ direction: 'outgoing', outcome: 'declined' });
  });

  it('in a group DM, an incoming call stays missed for the members who neither joined nor declined it', async () => {
    const { Alice, Bob, Carol } = await people('Alice', 'Bob', 'Carol');
    const group = await channel('dm', [Alice, Bob, Carol]);
    const answered = await call({
      channelId: group,
      initiatorId: Bob,
      initiatorName: 'Bob',
      status: 'ended',
      participants: [joined(Bob), joined(Carol)],
      duration: 60,
    });
    const declined = await call({ channelId: group, initiatorId: Bob, initiatorName: 'Bob', status: 'active' });
    expect((await appFor(Carol).request(`/api/chat-calls/${declined}/decline`, { method: 'POST' })).status).toBe(200);

    const forAlice = await history(Alice);
    expect(find(forAlice, answered)).toMatchObject({ outcome: 'missed', counterpart: { userId: Bob } });
    expect(find(forAlice, answered)?.otherMembers.map((m) => m.name)).toEqual(['Bob', 'Carol']);
    expect(find(forAlice, declined)?.outcome).toBe('missed');

    const forCarol = await history(Carol);
    expect(find(forCarol, answered)?.outcome).toBe('answered');
    expect(find(forCarol, declined)?.outcome).toBe('declined');
  });

  it('pages newest first with a cursor, without skipping or repeating calls that share a timestamp', async () => {
    const { Alice, Bob } = await people('Alice', 'Bob');
    const dm = await channel('dm', [Alice, Bob]);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await call({ channelId: dm, initiatorId: Bob, status: 'missed' }));
    // Two more at the very same instant: the id breaks the tie.
    const same = new Date(clock + 60_000);
    clock += 60_000;
    ids.push(await call({ channelId: dm, initiatorId: Alice, status: 'ended', createdAt: same }));
    ids.push(await call({ channelId: dm, initiatorId: Alice, status: 'ended', createdAt: same }));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await history(Alice, query);
      expect(page.data.length).toBeLessThanOrEqual(2);
      expect(page.pagination.totalCount).toBe(6);
      seen.push(...page.data.map((r) => r.id));
      cursor = page.pagination.cursor;
      expect(page.pagination.hasMore).toBe(cursor !== null);
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen)).toEqual(new Set(ids));
    // The pages, end to end, are the one-page list: newest first, nothing twice.
    const all = await history(Alice, '?limit=100');
    expect(seen).toEqual(all.data.map((r) => r.id));
    const created = all.data.map((r) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it("never shows calls from conversations the member isn't part of", async () => {
    const { Alice, Bob, Carol } = await people('Alice', 'Bob', 'Carol');
    const theirDm = await channel('dm', [Bob, Carol]);
    const general = await channel('public', [Alice, Bob, Carol], 'general');
    const open = await channel('public', [Bob], 'open-house');

    const otherDmCall = await call({ channelId: theirDm, initiatorId: Bob, status: 'missed' });
    // A channel call never rings anyone: one Alice did not take part in is not hers.
    const channelCallSkipped = await call({
      channelId: general,
      initiatorId: Bob,
      status: 'ended',
      participants: [joined(Bob), joined(Carol)],
    });
    const channelCallJoined = await call({
      channelId: general,
      initiatorId: Bob,
      status: 'ended',
      participants: [joined(Bob), joined(Alice)],
      duration: 300,
    });
    // Joined a public channel's call without being a member of the channel.
    const joinedWithoutMembership = await call({
      channelId: open,
      initiatorId: Bob,
      status: 'ended',
      participants: [joined(Bob), joined(Alice)],
    });
    const startedInChannel = await call({ channelId: general, initiatorId: Alice, status: 'missed' });

    const body = await history(Alice);
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain(otherDmCall);
    expect(ids).not.toContain(channelCallSkipped);
    expect(ids).toEqual(expect.arrayContaining([channelCallJoined, joinedWithoutMembership, startedInChannel]));
    expect(body.pagination.totalCount).toBe(3);

    expect(find(body, channelCallJoined)).toMatchObject({
      channelType: 'public',
      channelName: 'general',
      direction: 'incoming',
      outcome: 'answered',
      counterpart: null,
      otherMembers: [],
    });
    expect(find(body, startedInChannel)).toMatchObject({ direction: 'outgoing', outcome: 'missed' });
  });

  it('returns an empty page for someone without calls (not GET /:callId with id "history")', async () => {
    const { Alice } = await people('Alice');
    const body = await history(Alice);
    expect(body).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  });

  it('defaults to 30 calls a page and caps a larger limit at 100', async () => {
    const { Alice, Bob } = await people('Alice', 'Bob');
    const dm = await channel('dm', [Alice, Bob]);
    const base = clock;
    clock += 200 * 60_000;
    await db.insert(schema.chatCalls).values(
      Array.from({ length: 101 }, (_, i) => ({
        id: generateId('call'),
        channelId: dm,
        callType: 'voice',
        status: 'missed',
        initiatorId: Bob,
        initiatorName: 'Bob',
        participants: [joined(Bob)],
        createdAt: new Date(base + i * 60_000),
        updatedAt: new Date(base + i * 60_000),
      })),
    );

    const first = await history(Alice);
    expect(first.data).toHaveLength(30);
    expect(first.pagination).toMatchObject({ totalCount: 101, hasMore: true });

    const capped = await history(Alice, '?limit=500');
    expect(capped.data).toHaveLength(100);
    expect(capped.pagination.hasMore).toBe(true);
  });

  it('rejects a limit below 1', async () => {
    const { Alice } = await people('Alice');
    const res = await appFor(Alice).request('/api/chat-calls/history?limit=0');
    expect(res.status).toBe(400);
  });
});

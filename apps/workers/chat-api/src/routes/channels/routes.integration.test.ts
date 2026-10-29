/**
 * DB-backed tests for the /api/channels sub-routes the other files leave out:
 * a channel's message history and posting, its roster, self-join and leave,
 * removing a member, read receipts and "mark unread from here", muting, and
 * forwarding. Refusals included.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { channelsRoutes } from './index';
import { channelMembersRoutes } from '../channel-members';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

const ANN = 'user_rt_ann';
const BOB = 'user_rt_bob';
const CAROL = 'user_rt_carol';
const AGENT = 'agt_rt_helper';

const ALL = ['channels:read', 'channels:create', 'channels:update', 'messages:create', 'messages:read'];

let publicId: string;
let privateId: string;
let otherPublicId: string;

async function channel(name: string, type: string, members: Array<[string, string]>, memberType = 'user') {
  const id = generateId('ch');
  const now = new Date();
  await db.insert(schema.chatChannels).values({
    id,
    name,
    slug: `${name}-${id}`,
    type,
    memberCount: members.length,
    createdAt: now,
    updatedAt: now,
  });
  for (const [userId, role] of members) {
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'),
      channelId: id,
      userId,
      role,
      memberType: userId.startsWith('agt_') ? 'agent' : memberType,
      createdAt: now,
      joinedAt: now,
    });
  }
  return id;
}

async function message(channelId: string, authorId: string, content: string, at: Date, parentId?: string) {
  const id = generateId('msg');
  await db.insert(schema.chatMessages).values({
    id,
    channelId,
    authorId,
    authorName: authorId,
    content,
    parentId: parentId ?? null,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

function app(userId: string, keys: string[] = ALL) {
  return createTestApp('/api/channels', channelsRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
}

function members(userId: string, keys: string[] = ALL) {
  return createTestApp('/api/channel-members', channelMembersRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_rt_ann', userId: ANN, email: 'ann@example.com', name: 'Ann', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_rt_bob', userId: BOB, email: 'bob@example.com', name: 'Bob', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_rt_carol', userId: CAROL, email: 'carol@example.com', name: 'Carol', role: 'MEMBER', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await db.insert(schema.weldagentAgents).values({
    id: AGENT,
    name: 'Helper',
    description: 'Answers questions',
    icon: 'bot',
    visibility: 'workspace',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.weldagentAgents.$inferInsert);
  publicId = await channel('rt-public', 'public', [[ANN, 'owner'], [BOB, 'member'], [AGENT, 'member']]);
  privateId = await channel('rt-private', 'private', [[ANN, 'owner']]);
  otherPublicId = await channel('rt-elsewhere', 'public', [[CAROL, 'owner']]);
  const base = Date.now() - 60_000;
  await message(publicId, ANN, 'first', new Date(base));
  await message(publicId, BOB, 'second', new Date(base + 1000));
  await message(publicId, ANN, 'third', new Date(base + 2000));
}, 60_000);

describe('/api/channels/:channelId/messages', () => {
  it('GET pages newest first, then older with before and newer with after', async () => {
    const first = await app(BOB).request(`/api/channels/${publicId}/messages?limit=2`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as { data: { messages: Array<{ id: string; content: string }>; hasMore: boolean; nextCursor: string } };
    expect(page.data.messages.map((m) => m.content)).toEqual(['third', 'second']);
    expect(page.data.hasMore).toBe(true);

    const older = await app(BOB).request(`/api/channels/${publicId}/messages?before=${page.data.nextCursor}`);
    const olderBody = (await older.json()) as { data: { messages: Array<{ content: string }>; hasMore: boolean } };
    expect(olderBody.data.messages.map((m) => m.content)).toEqual(['first']);

    const firstId = page.data.messages[1]!.id;
    const newer = await app(BOB).request(`/api/channels/${publicId}/messages?after=${firstId}&limit=5`);
    const newerBody = (await newer.json()) as { data: { messages: Array<{ content: string }> } };
    expect(newerBody.data.messages.map((m) => m.content)).toEqual(['third']);
  });

  it('GET refuses a bad limit and a private channel the caller is not in', async () => {
    expect((await app(BOB).request(`/api/channels/${publicId}/messages?limit=0`)).status).toBe(400);
    expect((await app(BOB).request(`/api/channels/${privateId}/messages`)).status).toBe(403);
  });

  it('POST sends a message, a thread reply and a mention', async () => {
    const sent = await app(BOB).request(`/api/channels/${publicId}/messages`, json({ content: 'hello team' }));
    expect(sent.status).toBe(201);
    const { data } = (await sent.json()) as { data: { id: string; authorName: string } };
    expect(data.authorName).toBe('Bob');

    const reply = await app(ANN).request(
      `/api/channels/${publicId}/messages`,
      json({ content: `thanks <@${BOB}>`, parentId: data.id }),
    );
    expect(reply.status).toBe(201);
    const [parent] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, data.id));
    expect(parent?.threadReplyCount).toBe(1);
  });

  it('POST refuses an empty message, a private channel and a foreign thread parent', async () => {
    expect((await app(BOB).request(`/api/channels/${publicId}/messages`, json({ content: '' }))).status).toBe(400);
    expect((await app(BOB).request(`/api/channels/${privateId}/messages`, json({ content: 'x' }))).status).toBe(403);
    const elsewhere = await message(otherPublicId, CAROL, 'not here', new Date());
    const res = await app(BOB).request(`/api/channels/${publicId}/messages`, json({ content: 'x', parentId: elsewhere }));
    expect(res.status).toBe(400);
  });
});

describe('/api/channels/:channelId/members', () => {
  it('GET lists the roster with names, and the agent as an agent', async () => {
    const res = await app(BOB).request(`/api/channels/${publicId}/members`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ userId: string; name: string; agentIcon?: string | null }> };
    expect(data.find((m) => m.userId === ANN)?.name).toBe('Ann');
    expect(data.find((m) => m.userId === AGENT)?.name).toBe('Helper');
    expect(data.find((m) => m.userId === AGENT)?.agentIcon).toBe('bot');
  });

  it('GET refuses a private channel the caller is not in', async () => {
    expect((await app(BOB).request(`/api/channels/${privateId}/members`)).status).toBe(403);
  });

  it('POST /join joins a public channel once and refuses a private one', async () => {
    const joined = await app(CAROL).request(`/api/channels/${publicId}/members/join`, { method: 'POST' });
    expect(joined.status).toBe(201);
    const again = await app(CAROL).request(`/api/channels/${publicId}/members/join`, { method: 'POST' });
    expect(((await again.json()) as { data: { alreadyMember: boolean } }).data.alreadyMember).toBe(true);
    expect((await app(CAROL).request(`/api/channels/${privateId}/members/join`, { method: 'POST' })).status).toBe(400);
  });

  it('POST /leave lets a member leave, and refuses the owner and a stranger', async () => {
    const left = await app(CAROL).request(`/api/channels/${publicId}/members/leave`, { method: 'POST' });
    expect(left.status).toBe(200);
    expect((await app(ANN).request(`/api/channels/${publicId}/members/leave`, { method: 'POST' })).status).toBe(400);
    expect((await app(CAROL).request(`/api/channels/${publicId}/members/leave`, { method: 'POST' })).status).toBe(400);
  });

  it('DELETE /:userId removes a member, and 404s one who is not there', async () => {
    const ch = await channel('rt-kick', 'public', [[ANN, 'owner'], [CAROL, 'member']]);
    const res = await app(ANN).request(`/api/channels/${ch}/members/${CAROL}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await app(ANN).request(`/api/channels/${ch}/members/${CAROL}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app(BOB).request(`/api/channels/${privateId}/members/${ANN}`, { method: 'DELETE' })).status).toBe(403);
  });
});

describe('/api/channels/:channelId read state', () => {
  it('POST /read writes read receipts; beforeMessageId marks unread from there', async () => {
    const ch = await channel('rt-reads', 'public', [[ANN, 'owner'], [BOB, 'member']]);
    const base = Date.now() - 30_000;
    const m1 = await message(ch, ANN, 'one', new Date(base));
    const m2 = await message(ch, ANN, 'two', new Date(base + 1000));
    await message(ch, ANN, 'three', new Date(base + 2000));

    const read = await app(BOB).request(`/api/channels/${ch}/read`, { method: 'POST' });
    expect(read.status).toBe(200);

    const receipts = await app(BOB).request(`/api/channels/${ch}/read-receipts`);
    expect(receipts.status).toBe(200);
    const { data } = (await receipts.json()) as { data: Record<string, Array<{ userId: string; userName: string }>> };
    expect(data[m1]?.[0]?.userName).toBe('Bob');

    const unread = await app(BOB).request(`/api/channels/${ch}/read`, json({ beforeMessageId: m2 }));
    expect(unread.status).toBe(200);
    const body = (await unread.json()) as { data: { lastReadMessageId: string | null } };
    expect(body.data.lastReadMessageId).toBe(m1);

    const missing = await app(BOB).request(`/api/channels/${ch}/read`, json({ beforeMessageId: 'msg_nope' }));
    expect(missing.status).toBe(404);
    const bad = await app(BOB).request(`/api/channels/${ch}/read`, json({ beforeMessageId: 5 }));
    expect(bad.status).toBe(400);
  });

  it('GET /read-receipts refuses a private channel the caller is not in', async () => {
    expect((await app(BOB).request(`/api/channels/${privateId}/read-receipts`)).status).toBe(403);
  });

  it('PATCH /me mutes the caller, and 404s without a membership', async () => {
    const res = await app(BOB).request(`/api/channels/${publicId}/me`, json({ isMuted: true }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { isMuted: boolean } }).data.isMuted).toBe(true);
    expect((await app(BOB).request(`/api/channels/${privateId}/me`, json({ isMuted: true }, 'PATCH'))).status).toBe(404);
    expect((await app(BOB).request(`/api/channels/${publicId}/me`, json({ isMuted: 'yes' }, 'PATCH'))).status).toBe(400);
  });
});

describe('/api/channels/:channelId/messages/:messageId/forward', () => {
  it('forwards into a public channel, joining it, and refuses what the caller cannot reach', async () => {
    const [source] = await db
      .select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .where(and(eq(schema.chatMessages.channelId, publicId), eq(schema.chatMessages.content, 'first')));
    const res = await app(BOB).request(
      `/api/channels/${publicId}/messages/${source!.id}/forward`,
      json({ targetChannelIds: [otherPublicId], comment: ' look ' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { forwarded: Array<{ channelId: string }> } };
    expect(body.data.forwarded[0]?.channelId).toBe(otherPublicId);

    const missing = await app(BOB).request(
      `/api/channels/${publicId}/messages/msg_missing/forward`,
      json({ targetChannelIds: [otherPublicId] }),
    );
    expect(missing.status).toBe(404);
    const unknownTarget = await app(BOB).request(
      `/api/channels/${publicId}/messages/${source!.id}/forward`,
      json({ targetChannelIds: ['ch_nope'] }),
    );
    expect(unknownTarget.status).toBe(404);
    const privateTarget = await app(BOB).request(
      `/api/channels/${publicId}/messages/${source!.id}/forward`,
      json({ targetChannelIds: [privateId] }),
    );
    expect(privateTarget.status).toBe(403);
    expect(
      (await app(BOB).request(`/api/channels/${publicId}/messages/${source!.id}/forward`, json({ targetChannelIds: [] })))
        .status,
    ).toBe(400);
  });
});

describe('/api/channels/:id', () => {
  it('GET answers the channel with its roster, and 404s a private one', async () => {
    const res = await app(ANN).request(`/api/channels/${publicId}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { members: Array<{ userId: string }> } };
    expect(data.members.some((m) => m.userId === BOB)).toBe(true);
    expect((await app(BOB).request(`/api/channels/${privateId}`)).status).toBe(404);
    expect((await app(BOB).request('/api/channels/ch_missing')).status).toBe(404);
  });
});

describe('/api/channel-members', () => {
  it('GET / needs a channel, lists its rows, and refuses a private one', async () => {
    expect((await members(BOB).request('/api/channel-members')).status).toBe(400);
    const res = await members(BOB).request(`/api/channel-members?channelId=${publicId}&limit=2`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { data: Array<{ id: string }>; pagination: { cursor: string | null } };
    expect(page.data.length).toBe(2);
    const next = await members(BOB).request(`/api/channel-members?channelId=${publicId}&cursor=${page.pagination.cursor}`);
    expect(next.status).toBe(200);
    const filtered = await members(BOB).request(`/api/channel-members?channelId=${publicId}&userId=${ANN}`);
    expect(((await filtered.json()) as { data: unknown[] }).data.length).toBe(1);
    expect((await members(BOB).request(`/api/channel-members?channelId=${privateId}`)).status).toBe(403);
  });

  it('GET /:id answers a row, and 404s a private or missing one', async () => {
    const [row] = await db
      .select({ id: schema.chatChannelMembers.id })
      .from(schema.chatChannelMembers)
      .where(and(eq(schema.chatChannelMembers.channelId, privateId), eq(schema.chatChannelMembers.userId, ANN)));
    expect((await members(ANN).request(`/api/channel-members/${row!.id}`)).status).toBe(200);
    expect((await members(BOB).request(`/api/channel-members/${row!.id}`)).status).toBe(404);
    expect((await members(BOB).request('/api/channel-members/chm_missing')).status).toBe(404);
  });

  it('POST / self-joins a public channel, answers an existing row, and refuses the rest', async () => {
    const ch = await channel('rt-flat', 'public', [[ANN, 'owner']]);
    const joined = await members(CAROL).request('/api/channel-members', json({ channelId: ch, userId: CAROL, role: 'owner' }));
    expect(joined.status).toBe(201);
    const again = await members(CAROL).request('/api/channel-members', json({ channelId: ch, userId: CAROL }));
    expect(again.status).toBe(200);
    expect((await members(CAROL).request('/api/channel-members', json({ channelId: privateId, userId: CAROL }))).status).toBe(403);
    expect((await members(BOB).request('/api/channel-members', json({ channelId: ch, userId: CAROL }))).status).toBe(403);
    expect((await members(BOB).request('/api/channel-members', json({ channelId: ch, userId: 'user_x' }))).status).toBe(403);
    const owner = await members(ANN).request('/api/channel-members', json({ channelId: ch, userId: BOB, role: 'owner' }));
    expect(owner.status).toBe(201);
    const agent = await members(ANN).request(
      '/api/channel-members',
      json({ channelId: ch, userId: 'user_not_agent', memberType: 'agent' }),
    );
    expect(agent.status).toBe(400);
    expect((await members(ANN).request('/api/channel-members', json({ channelId: '' }))).status).toBe(400);
  });

  it('PATCH /:id sets self prefs and a moderator sets roles', async () => {
    const ch = await channel('rt-patch', 'public', [[ANN, 'owner'], [BOB, 'member']]);
    const [bob] = await db
      .select({ id: schema.chatChannelMembers.id })
      .from(schema.chatChannelMembers)
      .where(and(eq(schema.chatChannelMembers.channelId, ch), eq(schema.chatChannelMembers.userId, BOB)));
    const self = await members(BOB).request(
      `/api/channel-members/${bob!.id}`,
      json({ isMuted: true, notificationPreference: 'mentions', lastReadAt: '2026-01-01T10:00:00Z', lastReadMessageId: null }, 'PATCH'),
    );
    expect(self.status).toBe(200);
    const promoted = await members(ANN).request(`/api/channel-members/${bob!.id}`, json({ role: 'admin' }, 'PATCH'));
    expect(promoted.status).toBe(200);
    const [row] = await db.select().from(schema.chatChannelMembers).where(eq(schema.chatChannelMembers.id, bob!.id));
    expect(row?.role).toBe('admin');
    expect((await members(CAROL).request(`/api/channel-members/${bob!.id}`, json({ isMuted: false }, 'PATCH'))).status).toBe(403);
    expect((await members(BOB).request(`/api/channel-members/${bob!.id}`, json({ lastReadAt: 'soon' }, 'PATCH'))).status).toBe(400);
    expect((await members(BOB).request('/api/channel-members/chm_missing', json({ isMuted: true }, 'PATCH'))).status).toBe(404);
  });
});

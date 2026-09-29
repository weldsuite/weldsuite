/**
 * DB-backed integration tests for /api/chat-messages (WeldChat) — focused on
 * the membership boundary and author-spoofing protection.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

const MEMBER = 'user_member';
const OUTSIDER = 'user_outsider';

let publicChannelId: string;
let privateChannelId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  publicChannelId = generateId('ch');
  privateChannelId = generateId('ch');

  await db.insert(schema.chatChannels).values([
    { id: publicChannelId, name: 'general', slug: 'general', type: 'public', createdAt: now, updatedAt: now },
    { id: privateChannelId, name: 'secret', slug: 'secret', type: 'private', createdAt: now, updatedAt: now },
  ]);

  // MEMBER is a member of the private channel; OUTSIDER is not.
  await db.insert(schema.chatChannelMembers).values({
    id: generateId('cmb'),
    channelId: privateChannelId,
    userId: MEMBER,
    role: 'member',
    createdAt: now,
    joinedAt: now,
  });

  // Seed one message in each channel.
  await db.insert(schema.chatMessages).values([
    {
      id: generateId('cmsg'),
      channelId: publicChannelId,
      authorId: MEMBER,
      authorName: 'Member',
      content: 'hello public',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId('cmsg'),
      channelId: privateChannelId,
      authorId: MEMBER,
      authorName: 'Member',
      content: 'top secret',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}, 60_000);

describe('/api/chat-messages · membership boundary', () => {
  it('GET / requires a channelId', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request('/api/chat-messages');
    expect(res.status).toBe(400);
  });

  it('GET / returns messages of a public channel to anyone', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: OUTSIDER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-messages?channelId=${publicChannelId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string }[] };
    expect(body.data.some((m) => m.content === 'hello public')).toBe(true);
  });

  it('GET / lets a member read a private channel', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-messages?channelId=${privateChannelId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string }[] };
    expect(body.data.some((m) => m.content === 'top secret')).toBe(true);
  });

  it('GET / 403s a non-member of a private channel (no message leak)', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: OUTSIDER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-messages?channelId=${privateChannelId}`);
    expect(res.status).toBe(403);
  });

  it('POST / forces the author to the caller (ignores body authorId)', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: privateChannelId,
        authorId: 'user_spoofed_victim',
        authorName: 'Member',
        content: 'who am I',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, body.data.id))
      .limit(1);
    expect(row?.authorId).toBe(MEMBER);
    expect(row?.authorId).not.toBe('user_spoofed_victim');
  });

  it('POST / 403s a non-member posting to a private channel', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: OUTSIDER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: privateChannelId,
        authorName: 'Outsider',
        content: 'let me in',
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe('/api/chat-messages · inline (Discord-style) replies', () => {
  const OTHER = 'user_other';

  async function seedMessage(values: Partial<typeof schema.chatMessages.$inferInsert> = {}) {
    const now = new Date();
    const id = generateId('cmsg');
    await db.insert(schema.chatMessages).values({
      id,
      channelId: publicChannelId,
      authorId: OTHER,
      authorName: 'Other',
      content: 'original message',
      createdAt: now,
      updatedAt: now,
      ...values,
    });
    return id;
  }

  async function post(payload: Record<string, unknown>) {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: publicChannelId, ...payload }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, body.data.id))
      .limit(1);
    return row!;
  }

  it('keeps the reply top-level and snapshots the quoted message', async () => {
    const targetId = await seedMessage();
    const row = await post({ body: 'on it', replyToId: targetId });

    expect(row.parentId).toBeNull();
    const replyTo = (row.metadata as Record<string, any>).replyTo;
    expect(replyTo).toMatchObject({
      messageId: targetId,
      rootId: targetId,
      depth: 1,
      authorId: OTHER,
      authorName: 'Other',
      content: 'original message',
    });
    // Pings the quoted author by default, without a token in the body.
    expect(row.content).toBe('on it');
    expect(row.mentions).toEqual([OTHER]);
  });

  it('tracks the chain depth and root across replies to replies', async () => {
    const rootId = await seedMessage();
    const first = await post({ body: 'one', replyToId: rootId });
    const second = await post({ body: 'two', replyToId: first.id });

    const replyTo = (second.metadata as Record<string, any>).replyTo;
    expect(replyTo.depth).toBe(2);
    expect(replyTo.rootId).toBe(rootId);
    expect(replyTo.messageId).toBe(first.id);
  });

  it('does not ping when replyMention is false', async () => {
    const targetId = await seedMessage();
    const row = await post({ body: 'quiet', replyToId: targetId, replyMention: false });
    expect(row.mentions).toBeNull();
  });

  it('ignores a reply target from another channel and forged metadata', async () => {
    const foreignId = await seedMessage({ channelId: privateChannelId, content: 'top secret' });
    const row = await post({
      body: 'sneaky',
      replyToId: foreignId,
      metadata: { replyTo: { messageId: 'forged', content: 'fake quote' } },
    });
    expect((row.metadata as Record<string, unknown> | null)?.replyTo).toBeUndefined();
    expect(row.mentions).toBeNull();
  });
});

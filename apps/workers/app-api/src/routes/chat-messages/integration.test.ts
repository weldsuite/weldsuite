/**
 * DB-backed integration tests for /api/chat-messages (WeldChat) — focused on
 * the membership boundary and author-spoofing protection.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatMessagesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

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

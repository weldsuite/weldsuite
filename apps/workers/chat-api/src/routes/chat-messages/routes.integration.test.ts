/**
 * DB-backed tests for the /api/chat-messages routes the other file leaves
 * out: reading one message, pinned messages, deleting, reactions, unpinning
 * and uploading an attachment. Refusals included.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const ANN = 'user_msg_ann';
const BOB = 'user_msg_bob';
const ALL = ['channels:read', 'channels:create', 'messages:read', 'messages:create', 'messages:update', 'messages:delete'];

let publicId: string;
let privateId: string;
let quietId: string;

function app(userId: string, env: Record<string, unknown> = {}) {
  return createTestApp('/api/chat-messages', chatMessagesRoutes, {
    context: { userId, permissions: permissions(...ALL), tenantDb: db },
    env: env as never,
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function message(channelId: string, authorId: string, content: string, parentId?: string) {
  const id = generateId('msg');
  const now = new Date();
  await db.insert(schema.chatMessages).values({
    id, channelId, authorId, authorName: authorId, content, parentId: parentId ?? null, createdAt: now, updatedAt: now,
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  publicId = generateId('ch');
  privateId = generateId('ch');
  quietId = generateId('ch');
  await db.insert(schema.chatChannels).values([
    { id: publicId, name: 'msg-public', slug: `msg-public-${publicId}`, type: 'public', createdAt: now, updatedAt: now },
    { id: privateId, name: 'msg-private', slug: `msg-private-${privateId}`, type: 'private', createdAt: now, updatedAt: now },
    {
      id: quietId, name: 'msg-quiet', slug: `msg-quiet-${quietId}`, type: 'public',
      reactionsEnabled: false, attachmentsEnabled: false, createdAt: now, updatedAt: now,
    },
  ]);
  await db.insert(schema.chatChannelMembers).values([
    { id: generateId('cmb'), channelId: privateId, userId: ANN, role: 'owner', createdAt: now, joinedAt: now },
    { id: generateId('cmb'), channelId: publicId, userId: ANN, role: 'owner', createdAt: now, joinedAt: now },
  ]);
}, 60_000);

describe('/api/chat-messages', () => {
  it('GET /:id answers a message, and 404s a private or missing one', async () => {
    const id = await message(privateId, ANN, 'secret');
    expect((await app(ANN).request(`/api/chat-messages/${id}`)).status).toBe(200);
    expect((await app(BOB).request(`/api/chat-messages/${id}`)).status).toBe(404);
    expect((await app(ANN).request('/api/chat-messages/msg_missing')).status).toBe(404);
  });

  it('GET / lists a thread\'s replies with parentId', async () => {
    const parent = await message(publicId, ANN, 'parent');
    await message(publicId, BOB, 'reply one', parent);
    await message(publicId, BOB, 'reply two', parent);
    const res = await app(BOB).request(`/api/chat-messages?channelId=${publicId}&parentId=${parent}&limit=1`);
    const body = (await res.json()) as { data: Array<{ content: string }>; pagination: { cursor: string; totalCount: number } };
    expect(body.pagination.totalCount).toBe(2);
    const next = await app(BOB).request(
      `/api/chat-messages?channelId=${publicId}&parentId=${parent}&cursor=${body.pagination.cursor}&authorId=${BOB}`,
    );
    expect(next.status).toBe(200);
  });

  it('GET /pinned lists pinned messages, and DELETE /:id/pin unpins', async () => {
    const id = await message(publicId, ANN, 'pin me');
    expect((await app(ANN).request(`/api/chat-messages/${id}/pin`, { method: 'POST' })).status).toBe(200);
    const listed = await app(BOB).request(`/api/chat-messages/pinned?channelId=${publicId}`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { data: Array<{ id: string }> }).data.some((m) => m.id === id)).toBe(true);
    const unpinned = await app(ANN).request(`/api/chat-messages/${id}/pin`, { method: 'DELETE' });
    expect(unpinned.status).toBe(200);
    expect(((await unpinned.json()) as { data: { isPinned: boolean } }).data.isPinned).toBe(false);
    expect((await app(BOB).request('/api/chat-messages/pinned')).status).toBe(400);
    expect((await app(BOB).request(`/api/chat-messages/pinned?channelId=${privateId}`)).status).toBe(403);
    expect((await app(BOB).request('/api/chat-messages/msg_missing/pin', { method: 'DELETE' })).status).toBe(404);
  });

  it('pins until an expiry, and refuses a message it cannot see', async () => {
    const id = await message(publicId, ANN, 'for a while');
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await app(ANN).request(`/api/chat-messages/${id}/pin`, json({ expiresAt: until }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { pinExpiresAt: string } }).data.pinExpiresAt).toBe(until);
    const secret = await message(privateId, ANN, 'hidden');
    expect((await app(BOB).request(`/api/chat-messages/${secret}/pin`, { method: 'POST' })).status).toBe(404);
  });

  it('adds and removes a reaction', async () => {
    const id = await message(publicId, ANN, 'react to me');
    const added = await app(BOB).request(`/api/chat-messages/${id}/reactions`, json({ emoji: '👍' }));
    expect(added.status).toBe(200);
    expect(((await added.json()) as { data: { reactions: Record<string, string[]> } }).data.reactions['👍']).toEqual([BOB]);
    await app(ANN).request(`/api/chat-messages/${id}/reactions`, json({ emoji: '👍' }));
    const removed = await app(BOB).request(`/api/chat-messages/${id}/reactions/${encodeURIComponent('👍')}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { data: { reactions: Record<string, string[]> } }).data.reactions['👍']).toEqual([ANN]);
  });

  it('refuses a reaction where reactions are off, on a hidden message, and an empty emoji', async () => {
    const quiet = await message(quietId, ANN, 'no reactions here');
    expect((await app(BOB).request(`/api/chat-messages/${quiet}/reactions`, json({ emoji: '🎉' }))).status).toBe(400);
    const secret = await message(privateId, ANN, 'hidden');
    expect((await app(BOB).request(`/api/chat-messages/${secret}/reactions`, json({ emoji: '🎉' }))).status).toBe(404);
    expect((await app(BOB).request(`/api/chat-messages/${secret}/reactions/x`, { method: 'DELETE' })).status).toBe(404);
    expect((await app(BOB).request(`/api/chat-messages/${quiet}/reactions`, json({ emoji: '' }))).status).toBe(400);
  });

  it('DELETE /:id lets the author delete and keeps the thread count right', async () => {
    const parent = await message(publicId, ANN, 'thread');
    await db.update(schema.chatMessages).set({ threadReplyCount: 1 }).where(eq(schema.chatMessages.id, parent));
    const reply = await message(publicId, BOB, 'oops', parent);
    expect((await app(ANN).request(`/api/chat-messages/${reply}`, { method: 'DELETE' })).status).toBe(204);
    const [row] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, parent));
    expect(row?.threadReplyCount).toBe(0);
    const other = await message(publicId, ANN, 'mine');
    expect((await app(BOB).request(`/api/chat-messages/${other}`, { method: 'DELETE' })).status).toBe(403);
    expect((await app(BOB).request('/api/chat-messages/msg_missing', { method: 'DELETE' })).status).toBe(404);
  });

  it('PATCH /:id refuses someone else\'s message and a missing one', async () => {
    const id = await message(publicId, ANN, 'original');
    expect((await app(BOB).request(`/api/chat-messages/${id}`, json({ content: 'hacked' }, 'PATCH'))).status).toBe(403);
    expect((await app(BOB).request('/api/chat-messages/msg_missing', json({ content: 'x' }, 'PATCH'))).status).toBe(404);
    const edited = await app(ANN).request(`/api/chat-messages/${id}`, json({ content: 'edited', htmlContent: '<p>edited</p>' }, 'PATCH'));
    expect(edited.status).toBe(200);
  });
});

describe('/api/chat-messages/upload', () => {
  const env = () => ({ STORAGE: createMemoryR2(), R2_PUBLIC_URL: 'https://files.example.com' });

  function form(file: File | null, channelId?: string): RequestInit {
    const body = new FormData();
    if (file) body.append('file', file);
    if (channelId) body.append('channelId', channelId);
    return { method: 'POST', body };
  }

  it('stores a file and answers its public URL', async () => {
    const res = await app(ANN, env()).request(
      '/api/chat-messages/upload',
      form(new File(['hello'], 'notes 1.txt', { type: 'text/plain' }), publicId),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { url: string; fileName: string; fileSize: number } };
    expect(data.fileName).toBe('notes 1.txt');
    expect(data.fileSize).toBe(5);
    expect(data.url.startsWith('https://files.example.com/workspaces/')).toBe(true);
  });

  it('refuses a missing file, active content, a hidden channel, attachments off, and no storage', async () => {
    expect((await app(ANN, env()).request('/api/chat-messages/upload', form(null))).status).toBe(400);
    expect(
      (await app(ANN, env()).request('/api/chat-messages/upload', form(new File(['<svg></svg>'], 'x.svg', { type: 'image/svg+xml' }))))
        .status,
    ).toBe(400);
    expect(
      (await app(ANN, env()).request('/api/chat-messages/upload', form(new File(['<html>'], 'x.txt', { type: 'text/plain' })))).status,
    ).toBe(400);
    expect(
      (await app(BOB, env()).request('/api/chat-messages/upload', form(new File(['x'], 'x.txt', { type: 'text/plain' }), privateId)))
        .status,
    ).toBe(403);
    expect(
      (await app(ANN, env()).request('/api/chat-messages/upload', form(new File(['x'], 'x.txt', { type: 'text/plain' }), quietId)))
        .status,
    ).toBe(400);
    expect((await app(ANN).request('/api/chat-messages/upload', form(new File(['x'], 'x.txt'))))
      .status).toBe(500);
  });
});

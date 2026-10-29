/**
 * DB-backed tests for /api/chat-activity (the caller's WeldChat
 * notifications as a feed) and the DM membership mutations of /api/chat-dm:
 * archive, unarchive, pin and leave.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatActivityRoutes } from './index';
import { chatDmRoutes } from '../chat-dm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const ANN = 'user_act_ann';
const BOB = 'user_act_bob';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function activity(userId: string) {
  return createTestApp('/api/chat-activity', chatActivityRoutes, {
    context: { userId, permissions: permissions('messages:read'), tenantDb: db },
  });
}

function dm(userId: string) {
  return createTestApp('/api/chat-dm', chatDmRoutes, {
    context: { userId, permissions: permissions('messages:read', 'messages:create', 'messages:update', 'messages:delete'), tenantDb: db },
  });
}

async function notification(userId: string, type: string, minutesAgo: number) {
  const id = generateId('notif');
  await db.insert(schema.notifications).values({
    id,
    userId,
    title: `${type} for ${userId}`,
    body: 'preview',
    category: 'weldchat',
    notificationType: type,
    entityType: 'chat_message',
    entityId: generateId('msg'),
    actionUrl: '/weldchat/somewhere',
    actorId: BOB,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  } as typeof schema.notifications.$inferInsert);
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_act_ann', userId: ANN, email: 'ann@example.com', name: 'Ann', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_act_bob', userId: BOB, email: 'bob@example.com', name: 'Bob', role: 'MEMBER', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await notification(ANN, 'chat_mention', 5);
  await notification(ANN, 'chat_dm', 4);
  await notification(ANN, 'chat_thread_reply', 3);
  await notification(ANN, 'chat_missed_call', 2);
  await notification(BOB, 'chat_mention', 1);
}, 60_000);

describe('/api/chat-activity', () => {
  it('lists the caller\'s feed newest first, pages it, and filters it', async () => {
    const first = await activity(ANN).request('/api/chat-activity?limit=2');
    expect(first.status).toBe(200);
    const page = (await first.json()) as { data: Array<{ type: string }>; pagination: { cursor: string; totalCount: number; hasMore: boolean } };
    expect(page.data.map((n) => n.type)).toEqual(['chat_missed_call', 'chat_thread_reply']);
    expect(page.pagination.totalCount).toBe(4);
    const second = await activity(ANN).request(`/api/chat-activity?limit=2&cursor=${encodeURIComponent(page.pagination.cursor)}`);
    const next = (await second.json()) as { data: Array<{ type: string }> };
    expect(next.data.map((n) => n.type)).toEqual(['chat_dm', 'chat_mention']);
    const mentions = await activity(ANN).request('/api/chat-activity?filter=mentions');
    expect(((await mentions.json()) as { data: unknown[] }).data).toHaveLength(1);
    const ignored = await activity(ANN).request('/api/chat-activity?cursor=not-a-cursor');
    expect(ignored.status).toBe(200);
  });

  it('refuses an unknown filter and a bad limit', async () => {
    expect((await activity(ANN).request('/api/chat-activity?filter=everything')).status).toBe(400);
    expect((await activity(ANN).request('/api/chat-activity?limit=500')).status).toBe(400);
  });

  it('counts unread, marks one read, then all', async () => {
    const count = async () =>
      ((await (await activity(ANN).request('/api/chat-activity/unread-count')).json()) as { data: { count: number } }).data.count;
    expect(await count()).toBe(4);
    const [one] = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(eq(schema.notifications.userId, ANN)).limit(1);
    expect((await activity(ANN).request('/api/chat-activity/read', json({ notificationId: one!.id }))).status).toBe(204);
    expect(await count()).toBe(3);
    expect((await activity(ANN).request('/api/chat-activity/read', json({}))).status).toBe(204);
    expect(await count()).toBe(0);
    expect((await activity(ANN).request('/api/chat-activity/read', json({ notificationId: 5 }))).status).toBe(400);
  });
});

describe('/api/chat-dm membership', () => {
  it('archives, unarchives, pins, unpins and leaves a DM', async () => {
    const res = await dm(ANN).request(`/api/chat-dm/${BOB}`);
    expect(res.status).toBe(201);
    const { id } = ((await res.json()) as { data: { id: string } }).data;

    expect((await dm(ANN).request(`/api/chat-dm/${id}/archive`, { method: 'PATCH' })).status).toBe(200);
    expect((await dm(ANN).request(`/api/chat-dm/${id}/unarchive`, { method: 'PATCH' })).status).toBe(200);
    const pinned = await dm(ANN).request(`/api/chat-dm/${id}/pin`, json({ isPinned: true }, 'PATCH'));
    expect(((await pinned.json()) as { data: { isPinned: boolean } }).data.isPinned).toBe(true);
    await dm(BOB).request(`/api/chat-dm/${id}/pin`, json({ isPinned: true }, 'PATCH'));
    expect((await dm(ANN).request(`/api/chat-dm/${id}/pin`, json({ isPinned: false }, 'PATCH'))).status).toBe(200);
    const [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, id));
    expect((channel?.metadata as { pinnedBy: string[] }).pinnedBy).toEqual([BOB]);

    const again = await dm(ANN).request(`/api/chat-dm/${BOB}`);
    expect(again.status).toBe(200);
    const listed = await dm(ANN).request('/api/chat-dm');
    expect(((await listed.json()) as { data: Array<{ id: string }> }).data.some((c) => c.id === id)).toBe(true);

    expect((await dm(ANN).request(`/api/chat-dm/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await dm(ANN).request(`/api/chat-dm/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await dm(ANN).request(`/api/chat-dm/${id}/archive`, { method: 'PATCH' })).status).toBe(404);
    expect((await dm(ANN).request(`/api/chat-dm/${id}/unarchive`, { method: 'PATCH' })).status).toBe(404);
  });

  it('refuses a pin without a flag, a missing DM and an unknown person', async () => {
    expect((await dm(ANN).request('/api/chat-dm/ch_missing/pin', json({}, 'PATCH'))).status).toBe(400);
    expect((await dm(ANN).request('/api/chat-dm/ch_missing/pin', json({ isPinned: true }, 'PATCH'))).status).toBe(404);
    expect((await dm(ANN).request('/api/chat-dm/user_nobody')).status).toBe(404);
    const unknown = await dm(ANN).request('/api/chat-dm', json({ userIds: ['user_nobody'] }));
    expect(unknown.status).toBe(400);
    const group = await dm(ANN).request('/api/chat-dm', json({ userIds: [BOB, ANN] }));
    expect([200, 201]).toContain(group.status);
  });
});

/**
 * /api/notifications routes the privacy tests in integration.test.ts leave
 * out: the cursor list with actor names, the unread count, marking read,
 * creating, updating and soft-deleting, body validation (the schemas pass
 * unknown keys through, so any key naming a column reaches the insert) and
 * the permission gates. Real pglite tenant DB; runs in the Rust conformance
 * suite too (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { notificationsRoutes } from './index';

let db: Database;

const ANN = 'user_nt_ann';
const CAL = 'user_nt_cal';
const DAVE = 'user_nt_dave';
const ERIN = 'user_nt_erin';
const BOB = 'user_nt_bob';

const at = (day: number) => new Date(Date.UTC(2026, 0, day, 10));

type Seed = typeof schema.notifications.$inferInsert;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const rows: Seed[] = [
    { id: 'ntf_nt_1', userId: ANN, title: 'One', actorType: 'user', actorId: 'user_nt_actor', createdAt: at(1) },
    { id: 'ntf_nt_2', userId: ANN, title: 'Two', actorType: 'system', isRead: true, readAt: at(2), createdAt: at(2) },
    { id: 'ntf_nt_3a', userId: ANN, title: 'Three a', createdAt: at(3) },
    { id: 'ntf_nt_3b', userId: ANN, title: 'Three b', data: { ticket: 7 }, createdAt: at(3) },
    { id: 'ntf_nt_del', userId: ANN, title: 'Gone', deletedAt: at(6), createdAt: at(4) },
    { id: 'ntf_nt_4', userId: ANN, title: 'Four', actorType: 'user', actorId: 'user_nt_ghost', createdAt: at(5) },
    { id: 'ntf_nt_c1', userId: CAL, title: 'Cal one', createdAt: at(1) },
    { id: 'ntf_nt_c2', userId: CAL, title: 'Cal two', category: 'crm', entityType: 'lead', entityId: 'lead_1', createdAt: at(2) },
    { id: 'ntf_nt_c3', userId: CAL, title: 'Cal three', isRead: true, createdAt: at(3) },
    { id: 'ntf_nt_d1', userId: DAVE, title: 'Dave one', createdAt: at(1) },
    { id: 'ntf_nt_e1', userId: ERIN, title: 'Erin one', createdAt: at(1) },
    { id: 'ntf_nt_bob', userId: BOB, title: 'Bob private', createdAt: at(1) },
  ];
  await db.insert(schema.notifications).values(rows);
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_nt_actor',
    userId: 'user_nt_actor',
    email: 'actor@example.com',
    name: 'Actor Name',
    picture: 'https://cdn.example.com/actor.png',
  });
}, 60_000);

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/notifications', notificationsRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
  });
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

interface Page {
  data: Array<{ id: string; actorName: string | null; actorAvatar: string | null }>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

async function stored(id: string) {
  const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  return row;
}

describe('GET /api/notifications', () => {
  it('pages the caller rows newest first, id breaking ties, with the actor', async () => {
    const res = await app(ANN, 'general:read').request('/api/notifications?limit=2');
    expect(res.status).toBe(200);
    const first = (await res.json()) as Page;
    expect(first.data.map((r) => r.id)).toEqual(['ntf_nt_4', 'ntf_nt_3b']);
    expect(first.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'ntf_nt_3b' });
    // A user actor without a member row has no name or picture.
    expect(first.data[0]).toMatchObject({ actorName: null, actorAvatar: null });

    const next = (await (
      await app(ANN, 'general:read').request('/api/notifications?limit=2&cursor=ntf_nt_3b')
    ).json()) as Page;
    expect(next.data.map((r) => r.id)).toEqual(['ntf_nt_3a', 'ntf_nt_2']);
    expect(next.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'ntf_nt_2' });

    const last = (await (
      await app(ANN, 'general:read').request('/api/notifications?limit=2&cursor=ntf_nt_2')
    ).json()) as Page;
    expect(last.data.map((r) => r.id)).toEqual(['ntf_nt_1']);
    expect(last.data[0]).toMatchObject({ actorName: 'Actor Name', actorAvatar: 'https://cdn.example.com/actor.png' });
    expect(last.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });
  });

  it('starts over on an unknown cursor and leaves out deleted rows', async () => {
    const res = await app(ANN, 'general:read').request('/api/notifications?cursor=ntf_nt_missing');
    const body = (await res.json()) as Page;
    expect(body.data.map((r) => r.id)).toEqual(['ntf_nt_4', 'ntf_nt_3b', 'ntf_nt_3a', 'ntf_nt_2', 'ntf_nt_1']);
    expect(body.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });
  });

  it('reads the limit as parseInt does', async () => {
    const none = (await (await app(ANN, 'general:read').request('/api/notifications?limit=0')).json()) as Page;
    expect(none.data).toEqual([]);
    expect(none.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: null });

    // NaN: Drizzle leaves the LIMIT out, so every row comes back.
    const all = (await (await app(ANN, 'general:read').request('/api/notifications?limit=abc')).json()) as Page;
    expect(all.data).toHaveLength(5);
    expect(all.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });

    const two = (await (await app(ANN, 'general:read').request('/api/notifications?limit=2x')).json()) as Page;
    expect(two.data.map((r) => r.id)).toEqual(['ntf_nt_4', 'ntf_nt_3b']);
  });

  it('needs general:read', async () => {
    const res = await app(ANN).request('/api/notifications');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/notifications/unread-count and /:id', () => {
  it('counts the caller unread rows that are not deleted', async () => {
    const res = await app(ANN, 'general:read').request('/api/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { count: 4 } });
  });

  it('needs general:read for the count', async () => {
    const res = await app(ANN).request('/api/notifications/unread-count');
    expect(res.status).toBe(403);
  });

  it('returns a row, deleted or not, with its jsonb data', async () => {
    const res = await app(ANN, 'general:read').request('/api/notifications/ntf_nt_3b');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      id: 'ntf_nt_3b',
      userId: ANN,
      category: 'system',
      notificationType: 'custom',
      severity: 'info',
      data: { ticket: 7 },
      isRead: false,
      createdAt: '2026-01-03T10:00:00.000Z',
    });

    const deleted = await app(ANN, 'general:read').request('/api/notifications/ntf_nt_del');
    expect(deleted.status).toBe(200);
  });

  it('answers 404 with the id, also for a literal segment on another method', async () => {
    const res = await app(ANN, 'general:read').request('/api/notifications/read-all');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'NOT_FOUND', message: "Notification with ID 'read-all' not found" });
  });
});

describe('POST /api/notifications/read-all and /:id/read', () => {
  it('marks every unread row of the caller read', async () => {
    const res = await app(CAL, 'general:read').request('/api/notifications/read-all', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 2 } });
    expect((await stored('ntf_nt_c2'))?.isRead).toBe(true);
    expect((await stored('ntf_nt_c2'))?.readAt).toBeInstanceOf(Date);
    expect((await stored('ntf_nt_bob'))?.isRead).toBe(false);

    const count = await app(CAL, 'general:read').request('/api/notifications/unread-count');
    expect(await count.json()).toEqual({ data: { count: 0 } });
  });

  it('marks one row read and returns it', async () => {
    const res = await app(CAL, 'general:read').request('/api/notifications/ntf_nt_c2/read', { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: 'ntf_nt_c2', isRead: true, category: 'crm', entityId: 'lead_1' });
    expect(typeof data.readAt).toBe('string');
  });

  it("answers 404 for another user's row", async () => {
    const res = await app(CAL, 'general:read').request('/api/notifications/ntf_nt_bob/read', { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await stored('ntf_nt_bob'))?.isRead).toBe(false);
  });

  it('needs general:read', async () => {
    const all = await app(CAL).request('/api/notifications/read-all', { method: 'POST' });
    expect(all.status).toBe(403);
    const one = await app(CAL).request('/api/notifications/ntf_nt_c1/read', { method: 'POST' });
    expect(one.status).toBe(403);
  });
});

describe('POST /api/notifications', () => {
  it('creates a row; every key naming a column reaches the insert', async () => {
    const res = await app(DAVE, 'general:create').request(
      '/api/notifications',
      send('POST', {
        userId: DAVE,
        title: 'Hello',
        body: 'There',
        type: 'not a column',
        link: '/also/not',
        metadata: { not: 'a column' },
        isRead: true,
        category: 'helpdesk',
        notificationType: 'mention',
        entityType: 'ticket',
        entityId: 12345,
        actionUrl: '/desk/tickets/12345',
        actorType: 'user',
        actorId: 'user_nt_actor',
        icon: 'ticket',
        severity: 'warning',
        data: { nested: { a: [1, 2] }, flag: false },
        deliveredEmail: true,
        expiresAt: null,
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(Object.keys(data)).toEqual(['id']);
    expect(await stored(data.id)).toMatchObject({
      userId: DAVE,
      title: 'Hello',
      body: 'There',
      isRead: true,
      category: 'helpdesk',
      notificationType: 'mention',
      entityType: 'ticket',
      entityId: '12345',
      actionUrl: '/desk/tickets/12345',
      actorType: 'user',
      actorId: 'user_nt_actor',
      icon: 'ticket',
      severity: 'warning',
      data: { nested: { a: [1, 2] }, flag: false },
      deliveredInApp: true,
      deliveredEmail: true,
      deliveredPush: false,
      readAt: null,
      expiresAt: null,
      deletedAt: null,
    });
  });

  it('fills the column defaults', async () => {
    const res = await app(DAVE, 'general:create').request(
      '/api/notifications',
      send('POST', { userId: DAVE, title: 'Plain' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await stored(data.id)).toMatchObject({
      category: 'system',
      notificationType: 'custom',
      severity: 'info',
      isRead: false,
      body: null,
      data: null,
    });
  });

  it('inserts under a body id, yet answers with the generated one', async () => {
    const res = await app(DAVE, 'general:create').request(
      '/api/notifications',
      send('POST', { id: 'ntf_nt_custom', userId: DAVE, title: 'Custom id' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).not.toBe('ntf_nt_custom');
    expect((await stored('ntf_nt_custom'))?.title).toBe('Custom id');
    expect(await stored(data.id)).toBeUndefined();
  });

  it('rejects a body the schema refuses', async () => {
    const bad = [
      { userId: DAVE, title: 'x'.repeat(501) },
      { userId: 42, title: 'Wrong type' },
      { userId: DAVE, title: 'Null body', body: null },
      { userId: DAVE, title: 'Bad flag', isRead: 'yes' },
      { userId: DAVE, type: 'y'.repeat(51), title: 'Long type' },
    ];
    for (const body of bad) {
      const res = await app(DAVE, 'general:create').request('/api/notifications', send('POST', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
    }
  });

  it('answers 500 when the insert fails', async () => {
    const failing = [
      { title: 'No user' },
      { userId: null, title: 'Null user' },
      { userId: DAVE },
      { userId: DAVE, title: 't'.repeat(256) },
      { userId: DAVE, title: 'A timestamp from JSON', readAt: '2026-01-01T00:00:00.000Z' },
      { userId: DAVE, title: 'Taken id', id: 'ntf_nt_d1' },
      { userId: DAVE, title: 'Null flag', deliveredPush: null },
    ];
    for (const body of failing) {
      const res = await app(DAVE, 'general:create').request('/api/notifications', send('POST', body));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create notification' },
      });
    }
  });

  it('needs general:create', async () => {
    const res = await app(DAVE, 'general:read').request(
      '/api/notifications',
      send('POST', { userId: DAVE, title: 'Nope' }),
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/notifications/:id', () => {
  it('updates the column keys of the body', async () => {
    const res = await app(DAVE, 'general:update').request(
      '/api/notifications/ntf_nt_d1',
      send('PATCH', { title: 'Dave renamed', isRead: true, data: { k: 'v' }, type: 'ignored', severity: 'error' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'ntf_nt_d1' } });
    expect(await stored('ntf_nt_d1')).toMatchObject({
      title: 'Dave renamed',
      isRead: true,
      data: { k: 'v' },
      severity: 'error',
      userId: DAVE,
    });
  });

  it('clears a nullable column sent as null', async () => {
    const res = await app(DAVE, 'general:update').request(
      '/api/notifications/ntf_nt_d1',
      send('PATCH', { data: null, body: 'Now with a body' }),
    );
    expect(res.status).toBe(200);
    expect(await stored('ntf_nt_d1')).toMatchObject({ data: null, body: 'Now with a body' });
  });

  it("answers 404 for another user's row", async () => {
    const res = await app(DAVE, 'general:update').request(
      '/api/notifications/ntf_nt_bob',
      send('PATCH', { title: 'Hijacked' }),
    );
    expect(res.status).toBe(404);
    expect((await stored('ntf_nt_bob'))?.title).toBe('Bob private');
  });

  it('rejects a body the schema refuses', async () => {
    const res = await app(DAVE, 'general:update').request(
      '/api/notifications/ntf_nt_d1',
      send('PATCH', { isRead: 'yes' }),
    );
    expect(res.status).toBe(400);
  });

  it('answers 500 when there is nothing to set or the update fails', async () => {
    const failing = [{}, { type: 'not a column' }, { userId: null }, { createdAt: '2026-01-01T00:00:00.000Z' }];
    for (const body of failing) {
      const res = await app(DAVE, 'general:update').request('/api/notifications/ntf_nt_d1', send('PATCH', body));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update notification' },
      });
    }
    expect((await stored('ntf_nt_d1'))?.userId).toBe(DAVE);
  });

  it('needs general:update', async () => {
    const res = await app(DAVE, 'general:read').request(
      '/api/notifications/ntf_nt_d1',
      send('PATCH', { title: 'Nope' }),
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('soft-deletes the caller row once', async () => {
    const res = await app(ERIN, 'general:read').request('/api/notifications/ntf_nt_e1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await stored('ntf_nt_e1'))?.deletedAt).toBeInstanceOf(Date);

    const again = await app(ERIN, 'general:read').request('/api/notifications/ntf_nt_e1', { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it("answers 404 for another user's row", async () => {
    const res = await app(ERIN, 'general:read').request('/api/notifications/ntf_nt_bob', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await stored('ntf_nt_bob'))?.deletedAt).toBeNull();
  });

  it('needs general:read', async () => {
    const res = await app(ERIN).request('/api/notifications/ntf_nt_e1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});

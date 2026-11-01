/**
 * PATCH /api/meetings/:id/cancel and DELETE /api/meetings/:id against a real
 * schema (pglite), with the organizer scope (`meetings:scope:all` reaches
 * every meeting; without it only your own).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { meetingsRoutes } from './index';
import { fakeKv, fakeRealtime } from '../../test/fakes';
import type { Env, Variables } from '../../types';

const ME = 'user_test_default';

let db: Database;
let realtime = fakeRealtime();
let events: Array<{ entityType: string; action: string; entityId: string; data: Record<string, unknown> }> = [];
const eventsBinding = {
  send: async (message: (typeof events)[number]) => {
    events.push(message);
  },
  sendBatch: async (messages: Array<{ body: (typeof events)[number] }>) => {
    for (const message of messages) events.push(message.body);
  },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.meetings).values([
    { id: 'mtg_cx_mine', title: 'Mine', organizerId: ME, status: 'scheduled' },
    { id: 'mtg_cx_theirs', title: 'Theirs', organizerId: 'user_someone', status: 'scheduled' },
    { id: 'mtg_cx_done', title: 'Already', organizerId: ME, status: 'cancelled' },
    { id: 'mtg_cx_deleted', title: 'Deleted', organizerId: ME, status: 'scheduled', deletedAt: new Date() },
    { id: 'mtg_del_mine', title: 'Delete me', organizerId: ME, status: 'completed' },
    { id: 'mtg_del_theirs', title: 'Not yours', organizerId: 'user_someone', status: 'completed' },
  ]);
}, 60_000);

beforeEach(() => {
  realtime = fakeRealtime();
  events = [];
});

function app(perms: string[], scoped = false) {
  return createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
    context: { permissions: permissions(...perms, ...(scoped ? [] : ['meetings:scope:all'])), userId: ME, tenantDb: db },
    env: { WORKSPACE_CACHE: fakeKv(), REALTIME: realtime.binding, ENTITY_EVENTS: eventsBinding } as unknown as Partial<Env>,
  });
}

describe('PATCH /api/meetings/:id/cancel', () => {
  it('cancels the meeting, announces it and publishes the update', async () => {
    const { request } = app(['meetings:update'], true);
    const res = await request('/api/meetings/mtg_cx_mine/cancel?sendNotification=true', { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, 'mtg_cx_mine'));
    expect(row?.status).toBe('cancelled');
    expect(realtime.published).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        entityType: 'meeting',
        action: 'updated',
        entityId: 'mtg_cx_mine',
        data: { id: 'mtg_cx_mine', title: 'Mine', status: 'cancelled', hostId: ME },
      }),
    );

    expect((await request('/api/meetings/mtg_cx_done/cancel', { method: 'PATCH' })).status).toBe(400);
    expect((await request('/api/meetings/mtg_cx_deleted/cancel', { method: 'PATCH' })).status).toBe(404);
    expect((await request('/api/meetings/mtg_nope/cancel', { method: 'PATCH' })).status).toBe(404);
  });

  it("leaves someone else's meeting alone without the scope, cancels it with", async () => {
    expect((await app(['meetings:update'], true).request('/api/meetings/mtg_cx_theirs/cancel', { method: 'PATCH' })).status).toBe(403);
    expect((await app(['meetings:read']).request('/api/meetings/mtg_cx_theirs/cancel', { method: 'PATCH' })).status).toBe(403);
    expect((await app(['meetings:update']).request('/api/meetings/mtg_cx_theirs/cancel', { method: 'PATCH' })).status).toBe(200);
  });
});

describe('DELETE /api/meetings/:id', () => {
  it('soft-deletes your meeting and publishes the event', async () => {
    const { request } = app(['meetings:delete'], true);
    expect((await request('/api/meetings/mtg_del_theirs', { method: 'DELETE' })).status).toBe(404);
    expect((await request('/api/meetings/mtg_del_mine', { method: 'DELETE' })).status).toBe(204);
    const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, 'mtg_del_mine'));
    expect(row?.deletedAt).toBeTruthy();
    expect(events).toContainEqual(
      expect.objectContaining({ entityType: 'meeting', action: 'deleted', data: { id: 'mtg_del_mine', title: 'Delete me', status: 'completed' } }),
    );
    expect((await request('/api/meetings/mtg_del_mine', { method: 'DELETE' })).status).toBe(404);
  });

  it('reaches every meeting with the scope, and needs meetings:delete', async () => {
    expect((await app(['meetings:read', 'meetings:update']).request('/api/meetings/mtg_del_theirs', { method: 'DELETE' })).status).toBe(403);
    expect((await app(['meetings:delete']).request('/api/meetings/mtg_del_theirs', { method: 'DELETE' })).status).toBe(204);
  });
});

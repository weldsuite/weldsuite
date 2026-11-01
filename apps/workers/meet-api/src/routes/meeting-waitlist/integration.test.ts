/**
 * /api/meeting-waitlist against a real schema (pglite): the organizer's
 * admit / deny decisions and the generic CRUD rows.
 */

import { vi, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { meetingWaitlistRoutes } from './index';
import type { Env, Variables } from '../../types';

const HOST = 'user_test_default';

let db: Database;
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
    { id: 'mtg_wait_host', title: 'Hosted', organizerId: HOST, status: 'in_progress' },
    { id: 'mtg_wait_other', title: 'Not mine', organizerId: 'user_someone', status: 'in_progress' },
    { id: 'mtg_wait_gone', title: 'Deleted', organizerId: HOST, status: 'cancelled', deletedAt: new Date() },
  ]);
  const at = (minute: number) => new Date(Date.UTC(2026, 5, 1, 10, minute));
  await db.insert(schema.meetingSessionWaitlist).values([
    { id: 'wl_a', meetingId: 'mtg_wait_host', sessionId: 'msess_w1', name: 'Ada Guest', email: 'ada@example.com', createdAt: at(1), updatedAt: at(1) },
    { id: 'wl_b', meetingId: 'mtg_wait_host', sessionId: 'msess_w1', name: 'Bob Guest', email: 'bob@example.com', createdAt: at(2), updatedAt: at(2) },
    { id: 'wl_c', meetingId: 'mtg_wait_host', sessionId: 'msess_w2', name: 'Cy Visitor', email: 'cy@example.com', status: 'denied', createdAt: at(3), updatedAt: at(3) },
    { id: 'wl_d', meetingId: 'mtg_wait_other', sessionId: 'msess_w3', name: 'Dee Guest', email: 'dee@example.com', createdAt: at(4), updatedAt: at(4) },
    { id: 'wl_e', meetingId: 'mtg_wait_gone', sessionId: 'msess_w4', name: 'Eve Guest', email: 'eve@example.com', createdAt: at(5), updatedAt: at(5) },
    { id: 'wl_f', meetingId: 'mtg_wait_none', sessionId: 'msess_w5', name: 'Fay Guest', email: 'fay@example.com', createdAt: at(6), updatedAt: at(6) },
  ]);
}, 60_000);

beforeEach(() => {
  events = [];
});

function app(perms: string[] = ['meetings:read', 'meetings:create', 'meetings:update', 'meetings:delete']) {
  return createTestApp<Env, Variables>('/api/meeting-waitlist', meetingWaitlistRoutes, {
    context: { permissions: permissions(...perms), userId: HOST, tenantDb: db },
    env: { ENTITY_EVENTS: eventsBinding } as unknown as Partial<Env>,
  });
}

const json = { 'Content-Type': 'application/json' };
type Listed = { data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };

describe('admit / deny', () => {
  it('admits a pending guest once, as the organizer', async () => {
    const { request } = app(['meetings:read']);
    const res = await request('/api/meeting-waitlist/wl_a/admit', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ id: 'wl_a', status: 'admitted', decidedBy: HOST });
    expect(events).toContainEqual(
      expect.objectContaining({ entityType: 'meeting_waitlist', action: 'updated', entityId: 'wl_a', data: { id: 'wl_a', meetingId: 'mtg_wait_host', status: 'admitted' } }),
    );
    const again = await request('/api/meeting-waitlist/wl_a/admit', { method: 'POST' });
    expect(again.status).toBe(400);
  });

  it('denies a pending guest', async () => {
    const { request } = app(['meetings:read']);
    const res = await request('/api/meeting-waitlist/wl_b/deny', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ id: 'wl_b', status: 'denied' });
    expect((await request('/api/meeting-waitlist/wl_c/deny', { method: 'POST' })).status).toBe(400);
  });

  it("refuses another organizer's meeting, a deleted or unknown meeting and an unknown entry", async () => {
    const { request } = app(['meetings:read']);
    expect((await request('/api/meeting-waitlist/wl_d/admit', { method: 'POST' })).status).toBe(403);
    expect((await request('/api/meeting-waitlist/wl_d/deny', { method: 'POST' })).status).toBe(403);
    expect((await request('/api/meeting-waitlist/wl_e/admit', { method: 'POST' })).status).toBe(404);
    expect((await request('/api/meeting-waitlist/wl_f/deny', { method: 'POST' })).status).toBe(404);
    expect((await request('/api/meeting-waitlist/wl_nope/admit', { method: 'POST' })).status).toBe(404);
    expect((await request('/api/meeting-waitlist/wl_nope/deny', { method: 'POST' })).status).toBe(404);
    expect((await app(['meetings:create']).request('/api/meeting-waitlist/wl_d/admit', { method: 'POST' })).status).toBe(403);
  });
});

describe('generic rows', () => {
  it('lists newest first with filters and a cursor', async () => {
    const { request } = app();
    const all = (await (await request('/api/meeting-waitlist')).json()) as Listed;
    expect(all.data.map((e) => e.id).slice(0, 6)).toEqual(['wl_f', 'wl_e', 'wl_d', 'wl_c', 'wl_b', 'wl_a']);

    const session = (await (await request('/api/meeting-waitlist?sessionId=msess_w1')).json()) as Listed;
    expect(session.data.map((e) => e.id)).toEqual(['wl_b', 'wl_a']);
    const denied = (await (await request('/api/meeting-waitlist?status=denied&sessionId=msess_w2')).json()) as Listed;
    expect(denied.data.map((e) => e.id)).toEqual(['wl_c']);
    const search = (await (await request('/api/meeting-waitlist?search=Visitor')).json()) as Listed;
    expect(search.data.map((e) => e.id)).toEqual(['wl_c']);

    const first = (await (await request('/api/meeting-waitlist?sessionId=msess_w1&limit=1')).json()) as Listed;
    expect(first.pagination).toEqual({ totalCount: 2, hasMore: true, cursor: 'wl_b' });
    const next = (await (await request('/api/meeting-waitlist?sessionId=msess_w1&limit=1&cursor=wl_b')).json()) as Listed;
    expect(next.data.map((e) => e.id)).toEqual(['wl_a']);
    expect(next.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
  });

  it('reads one entry', async () => {
    const { request } = app();
    expect(((await (await request('/api/meeting-waitlist/wl_d')).json()) as { data: unknown }).data).toMatchObject({ id: 'wl_d', name: 'Dee Guest' });
    expect((await request('/api/meeting-waitlist/wl_nope')).status).toBe(404);
  });

  it('creates, updates and deletes an entry with its events', async () => {
    const { request } = app();
    const created = await request('/api/meeting-waitlist', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ meetingId: 'mtg_wait_host', sessionId: 'msess_w9', name: 'Gil Guest', email: 'gil@example.com' }),
    });
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    expect(id).toMatch(/^wl_/);
    expect(events).toContainEqual(
      expect.objectContaining({
        entityType: 'meeting_waitlist',
        action: 'created',
        // The id of this run's row (conformance mode compares both runs' events).
        data: { id: expect.stringMatching(/^wl_/), meetingId: 'mtg_wait_host', name: 'Gil Guest', email: 'gil@example.com', status: 'pending' },
      }),
    );

    const patched = await request(`/api/meeting-waitlist/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'admitted', name: 'Gil G.' }) });
    expect(await patched.json()).toEqual({ data: { id } });
    const [row] = await db.select().from(schema.meetingSessionWaitlist).where(eq(schema.meetingSessionWaitlist.id, id));
    expect(row).toMatchObject({ status: 'admitted', name: 'Gil G.', email: 'gil@example.com' });
    expect(events).toContainEqual(
      expect.objectContaining({ action: 'updated', data: { id, meetingId: 'mtg_wait_host', name: 'Gil G.', email: 'gil@example.com', status: 'admitted' } }),
    );

    expect((await request(`/api/meeting-waitlist/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await db.select().from(schema.meetingSessionWaitlist).where(eq(schema.meetingSessionWaitlist.id, id))).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ action: 'deleted', entityId: id }));
    expect((await request(`/api/meeting-waitlist/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('validates the body, answers 500 on a row the database refuses, and checks permissions', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request } = app();
    const post = (body: unknown) => request('/api/meeting-waitlist', { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await post({ sessionId: 'msess_w1' })).status).toBe(400);
    expect((await post({ sessionId: 'msess_w1', name: 'X', email: 'not-an-email' })).status).toBe(400);
    // No meeting: the column is required.
    expect((await post({ sessionId: 'msess_w1', name: 'X', email: 'x@example.com' })).status).toBe(500);
    expect((await request('/api/meeting-waitlist/wl_nope', { method: 'PATCH', headers: json, body: '{}' })).status).toBe(404);
    expect((await request('/api/meeting-waitlist/wl_d', { method: 'PATCH', headers: json, body: '{"name":""}' })).status).toBe(400);
    expect((await app(['meetings:read']).request('/api/meeting-waitlist', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);
    expect((await app(['meetings:read']).request('/api/meeting-waitlist/wl_d', { method: 'PATCH', headers: json, body: '{}' })).status).toBe(403);
    expect((await app(['meetings:read']).request('/api/meeting-waitlist/wl_d', { method: 'DELETE' })).status).toBe(403);
    expect((await app(['meetings:create']).request('/api/meeting-waitlist')).status).toBe(403);
  });
});

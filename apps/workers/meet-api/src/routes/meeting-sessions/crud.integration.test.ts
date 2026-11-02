/**
 * The generic meeting-session rows against a real schema (pglite): list, get,
 * latest per meeting, create, delete, and the RealtimeKit recordings listing
 * (RealtimeKit answered at the HTTP level, ../../test/fakes.ts).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { meetingSessionsRoutes } from './index';
import { RTK_ENV, fakeKv, fakeRtkApi } from '../../test/fakes';
import type { Env, Variables } from '../../types';

const rtk = fakeRtkApi();
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
  vi.stubGlobal('fetch', rtk.fetch);
  db = (await createPgliteDb()).db;
  await db.insert(schema.meetings).values([
    { id: 'mtg_crud_a', title: 'A', organizerId: 'user_test_default', status: 'completed' },
    { id: 'mtg_crud_b', title: 'B', organizerId: 'user_test_default', status: 'scheduled' },
  ]);
  const at = (minute: number) => new Date(Date.UTC(2026, 5, 2, 8, minute));
  await db.insert(schema.meetingSessions).values([
    { id: 'msess_crud_1', meetingId: 'mtg_crud_a', status: 'ended', cfAppId: 'rtk_crud_room', startedBy: 'u', startedByName: 'U', recordingUrl: 'https://saved.example.com/r.mp4', createdAt: at(1), updatedAt: at(1) },
    { id: 'msess_crud_2', meetingId: 'mtg_crud_a', status: 'ended', startedBy: 'u', startedByName: 'U', createdAt: at(2), updatedAt: at(2) },
    { id: 'msess_crud_3', meetingId: 'mtg_crud_a', status: 'active', cfAppId: 'rtk_crud_failing', startedBy: 'u', startedByName: 'U', createdAt: at(3), updatedAt: at(3) },
  ]);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  rtk.reset();
  events = [];
});

function app(perms: string[] = ['sessions:read', 'sessions:create', 'sessions:delete']) {
  return createTestApp<Env, Variables>('/api/meeting-sessions', meetingSessionsRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db },
    env: { ...RTK_ENV, WORKSPACE_CACHE: fakeKv(), ENTITY_EVENTS: eventsBinding } as unknown as Partial<Env>,
  });
}

const json = { 'Content-Type': 'application/json' };
type Listed = { data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };

describe('reads', () => {
  it('lists sessions newest first, by meeting and status, with a cursor', async () => {
    const { request } = app();
    const byMeeting = (await (await request('/api/meeting-sessions?meetingId=mtg_crud_a')).json()) as Listed;
    expect(byMeeting.data.map((s) => s.id)).toEqual(['msess_crud_3', 'msess_crud_2', 'msess_crud_1']);
    expect(byMeeting.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    const ended = (await (await request('/api/meeting-sessions?meetingId=mtg_crud_a&status=ended')).json()) as Listed;
    expect(ended.data.map((s) => s.id)).toEqual(['msess_crud_2', 'msess_crud_1']);

    const page = (await (await request('/api/meeting-sessions?meetingId=mtg_crud_a&limit=2')).json()) as Listed;
    expect(page.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'msess_crud_2' });
    const rest = (await (await request('/api/meeting-sessions?meetingId=mtg_crud_a&limit=2&cursor=msess_crud_2')).json()) as Listed;
    expect(rest.data.map((s) => s.id)).toEqual(['msess_crud_1']);

    const all = (await (await request('/api/meeting-sessions')).json()) as Listed;
    expect(all.pagination.totalCount).toBeGreaterThanOrEqual(3);
  });

  it('reads one session, and the latest of a meeting', async () => {
    const { request } = app();
    expect(((await (await request('/api/meeting-sessions/msess_crud_2')).json()) as { data: unknown }).data).toMatchObject({ id: 'msess_crud_2', meetingId: 'mtg_crud_a' });
    expect((await request('/api/meeting-sessions/msess_nope')).status).toBe(404);

    expect(((await (await request('/api/meeting-sessions/latest?meetingId=mtg_crud_a')).json()) as { data: { id: string } }).data.id).toBe('msess_crud_3');
    expect(await (await request('/api/meeting-sessions/latest?meetingId=mtg_crud_b')).json()).toEqual({ data: null });
    expect((await request('/api/meeting-sessions/latest')).status).toBe(400);
    expect((await app(['sessions:create']).request('/api/meeting-sessions/latest?meetingId=mtg_crud_a')).status).toBe(403);
  });

  it("lists RealtimeKit's recordings of the room next to the saved URL, best effort", async () => {
    rtk.state.recordings.set('rtk_crud_room', [
      { id: 'rec_1', meeting_id: 'rtk_crud_room', status: 'UPLOADED', download_url: 'https://rtk.example.com/rec_1.mp4' },
    ]);
    rtk.state.failures.set('recordings', 500);
    const { request } = app();
    // A failing listing answers no recordings.
    expect(await (await request('/api/meeting-sessions/msess_crud_3/recordings')).json()).toEqual({ data: { recordings: [], savedUrl: null } });

    rtk.state.failures.clear();
    const res = await request('/api/meeting-sessions/msess_crud_1/recordings');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { recordings: Array<{ id: string }>; savedUrl: string } };
    expect(data.savedUrl).toBe('https://saved.example.com/r.mp4');
    expect(data.recordings.map((r) => r.id)).toEqual(['rec_1']);

    // No room: nothing to ask RealtimeKit.
    expect(await (await request('/api/meeting-sessions/msess_crud_2/recordings')).json()).toEqual({ data: { recordings: [], savedUrl: null } });
    expect((await request('/api/meeting-sessions/msess_nope/recordings')).status).toBe(404);
  });
});

describe('writes', () => {
  it('creates a session row, server-owned columns stripped but its meeting kept', async () => {
    const { request } = app();
    const res = await request('/api/meeting-sessions', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ meetingId: 'mtg_crud_b', status: 'waiting', startedBy: 'user_x', startedByName: 'X', cfAppId: 'rtk_forged', recordingStatus: 'ready' }),
    });
    expect(res.status).toBe(201);
    const { id } = ((await res.json()) as { data: { id: string } }).data;
    expect(id).toMatch(/^msn_/);
    const [row] = await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, id));
    expect(row).toMatchObject({ meetingId: 'mtg_crud_b', status: 'waiting', startedBy: 'user_x', cfAppId: null });
    expect(row?.recordingStatus).not.toBe('ready');
    expect(events).toContainEqual(
      expect.objectContaining({ entityType: 'meeting_session', action: 'created', data: expect.objectContaining({ meetingId: 'mtg_crud_b', status: 'waiting', startedBy: 'user_x' }) }),
    );

    expect((await request('/api/meeting-sessions', { method: 'POST', headers: json, body: '{"status":5}' })).status).toBe(400);
    expect((await app(['sessions:read']).request('/api/meeting-sessions', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);
  });

  it('answers 500 when the database refuses the row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request } = app();
    // No meeting and no starter: required columns.
    const res = await request('/api/meeting-sessions', { method: 'POST', headers: json, body: '{"status":"waiting"}' });
    expect(res.status).toBe(500);
  });

  it('deletes a session', async () => {
    await db.insert(schema.meetingSessions).values({ id: 'msess_crud_del', meetingId: 'mtg_crud_b', status: 'ended', startedBy: 'u', startedByName: 'U' });
    const { request } = app();
    expect((await request('/api/meeting-sessions/msess_crud_del', { method: 'DELETE' })).status).toBe(204);
    expect(await db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, 'msess_crud_del'))).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'meeting_session', action: 'deleted', entityId: 'msess_crud_del' }));
    expect((await request('/api/meeting-sessions/msess_crud_del', { method: 'DELETE' })).status).toBe(404);
    expect((await app(['sessions:read']).request('/api/meeting-sessions/msess_crud_1', { method: 'DELETE' })).status).toBe(403);
  });
});

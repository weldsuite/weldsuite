/**
 * Time logged against a WeldMerge issue: `mergeIssueId` on create / update and
 * the `?mergeIssueId=` list filter of /api/time-entries (phase 5, WeldFlow time).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { timeEntriesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.mergeTeams).values({ id: 'mtm_time', key: 'TIME', name: 'Time team', createdByUserId: 'user_a' });
  await db.insert(schema.mergeIssues).values([
    { id: 'mis_time_1', teamId: 'mtm_time', number: 1, title: 'Fix tabs', creatorUserId: 'user_a' },
    { id: 'mis_time_2', teamId: 'mtm_time', number: 2, title: 'Gone', creatorUserId: 'user_a', deletedAt: new Date() },
  ]);
}, 60_000);

function app(userId: string, ...grants: string[]) {
  return createTestApp('/api/time-entries', timeEntriesRoutes, {
    context: { permissions: permissions(...grants), userId, tenantDb: db },
  }).request;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const FULL = ['time:read', 'time:create', 'time:update', 'merge_issues:read'];

describe('/api/time-entries · mergeIssueId', () => {
  it('POST / logs time against an issue, GET / filters on it, PATCH detaches it', async () => {
    const request = app('user_time', ...FULL);
    const created = await request('/api/time-entries', json({ date: '2026-07-01', duration: 45, mergeIssueId: 'mis_time_1', description: 'Debugging' }));
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    await request('/api/time-entries', json({ date: '2026-07-01', duration: 30, description: 'Unrelated' }));

    const [row] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id));
    expect(row?.mergeIssueId).toBe('mis_time_1');

    const listed = await request('/api/time-entries?mergeIssueId=mis_time_1');
    const body = (await listed.json()) as { data: Array<{ id: string; mergeIssueId: string | null }>; pagination: { totalCount: number } };
    expect(body.data.map((e) => e.id)).toEqual([id]);
    expect(body.data[0]!.mergeIssueId).toBe('mis_time_1');
    expect(body.pagination.totalCount).toBe(1);

    const detached = await request(`/api/time-entries/${id}`, json({ mergeIssueId: null }, 'PATCH'));
    expect(detached.status).toBe(200);
    const [after] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id));
    expect(after?.mergeIssueId).toBeNull();
    const empty = (await (await request('/api/time-entries?mergeIssueId=mis_time_1')).json()) as { data: unknown[] };
    expect(empty.data).toEqual([]);
  });

  it('PATCH / attaches an existing entry to an issue', async () => {
    const request = app('user_patch', ...FULL);
    const created = await request('/api/time-entries', json({ date: '2026-07-02', duration: 20 }));
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    expect((await request(`/api/time-entries/${id}`, json({ mergeIssueId: 'mis_time_1' }, 'PATCH'))).status).toBe(200);
    const [row] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id));
    expect(row?.mergeIssueId).toBe('mis_time_1');
  });

  it('only lists the caller’s own entries, even for the same issue', async () => {
    await app('user_one', ...FULL)('/api/time-entries', json({ date: '2026-07-03', duration: 10, mergeIssueId: 'mis_time_1' }));
    const other = await app('user_two', ...FULL)('/api/time-entries?mergeIssueId=mis_time_1');
    expect(((await other.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('404s an unknown or deleted issue, and an issue the caller may not read', async () => {
    const request = app('user_time2', ...FULL);
    for (const mergeIssueId of ['mis_missing', 'mis_time_2']) {
      const res = await request('/api/time-entries', json({ date: '2026-07-04', duration: 10, mergeIssueId }));
      expect(res.status).toBe(404);
    }
    const blind = app('user_blind', 'time:read', 'time:create');
    expect((await blind('/api/time-entries', json({ date: '2026-07-04', duration: 10, mergeIssueId: 'mis_time_1' }))).status).toBe(404);
    expect((await blind('/api/time-entries', json({ date: '2026-07-04', duration: 10 }))).status).toBe(201);
  });

  it('400s an empty mergeIssueId', async () => {
    const res = await app('user_time3', ...FULL)('/api/time-entries', json({ date: '2026-07-05', duration: 10, mergeIssueId: '' }));
    expect(res.status).toBe(400);
  });
});

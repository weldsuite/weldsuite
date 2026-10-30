/**
 * Every /api/helpdesk-departments route on pglite: the plain CRUD shape through
 * the shared suite (../../test/crud-suite.ts), then what is particular to
 * departments: the list's user order (`COALESCE(sort_order, 0)`, newest first,
 * id) and its cursor, the computed `agentCount`, the `isActive` filter, and
 * GET /inbox-counts. Runs against Rust in conformance mode
 * (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskDepartmentsRoutes } from './index';

const BASE = '/api/helpdesk-departments';

describeCrud(BASE, {
  base: BASE,
  routes: helpdeskDepartmentsRoutes,
  table: schema.helpdeskDepartments,
  gates: {
    read: 'departments:read',
    create: 'departments:create',
    update: 'departments:update',
    delete: 'departments:delete',
  },
  seed: (n) => ({ name: `Department ${n}` }),
  valid: { name: 'Customer Support', email: 'support@e2e.test', color: '#3b82f6', sortOrder: 3, isActive: true },
  // Passed through by the schema; the column is varchar(20).
  unstorable: { name: 'Bad priority', defaultPriority: 'x'.repeat(21) },
  invalid: [
    { name: '' },
    { name: 'x', email: 'nope' },
    { name: 'x', sortOrder: 1.5 },
    { name: 'x', color: 'x'.repeat(51) },
    { name: 'x', icon: 'x'.repeat(101) },
    { description: 'no name' },
  ],
  patch: { name: 'Sales', description: 'Renamed', autoAssignment: true },
  invalidPatch: { isActive: 'yes' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle Department' } },
    { query: 'search=needle%40find', match: { email: 'needle@find.test' } },
    { query: 'isActive=false', match: { isActive: false } },
  ],
});

type Row = Record<string, unknown>;
interface ListBody {
  data: Row[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

describe(`${BASE} · department specifics`, () => {
  let db: Database;
  const app = (...keys: string[]) =>
    createTestApp(BASE, helpdeskDepartmentsRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db },
    });
  const ids = (body: ListBody) => body.data.map((r) => r.id);

  beforeAll(async () => {
    // The same pglite as the suite above (one per file): start from nothing.
    db = (await createPgliteDb()).db;
    await db.delete(schema.helpdeskDepartments);
    await db.delete(schema.helpdeskAgents);
    const at = (s: number) => new Date(Date.UTC(2026, 1, 1, 9, 0, s));
    const tie = new Date(Date.UTC(2026, 1, 2));
    await db.insert(schema.helpdeskDepartments).values([
      { id: 'dep_s2', name: 'Two', sortOrder: 2, createdAt: at(1), updatedAt: at(1) },
      { id: 'dep_null', name: 'Unsorted', sortOrder: null, createdAt: at(2), updatedAt: at(2) },
      { id: 'dep_z0a', name: 'Zero A', sortOrder: 0, createdAt: tie, updatedAt: tie },
      { id: 'dep_z0b', name: 'Zero B', sortOrder: 0, createdAt: tie, updatedAt: tie, email: 'zero@b.test' },
      { id: 'dep_s1', name: 'One', sortOrder: 1, createdAt: at(3), updatedAt: at(3), agentCount: 99 },
      { id: 'dep_off', name: 'Off', sortOrder: 1, isActive: false, createdAt: at(4), updatedAt: at(4) },
      { id: 'dep_gone', name: 'Gone', createdAt: at(5), updatedAt: at(5), deletedAt: at(6) },
    ]);
    const agent = (id: string, extra: Partial<typeof schema.helpdeskAgents.$inferInsert>) => ({
      id,
      userId: `user_${id}`,
      name: id,
      email: `${id}@x.test`,
      ...extra,
    });
    await db.insert(schema.helpdeskAgents).values([
      agent('agt_1', { departmentId: 'dep_s1' }),
      agent('agt_2', { departmentId: 'dep_s1' }),
      agent('agt_3', { departmentId: 'dep_s1', deletedAt: at(9) }),
      agent('agt_4', { departmentId: 'dep_null' }),
      agent('agt_5', { teamIds: ['dep_s2'] }),
      agent('agt_6', {}),
    ]);
    const conv = (id: string, n: number, extra: Partial<typeof schema.helpdeskConversations.$inferInsert>) => ({
      id,
      conversationNumber: `CONV-D${n}`,
      customerName: 'Customer',
      subject: `Conversation ${n}`,
      createdAt: at(n),
      updatedAt: at(n),
      ...extra,
    });
    await db.insert(schema.helpdeskConversations).values([
      conv('dc_1', 1, { departmentId: 'dep_s1', status: 'active' }),
      conv('dc_2', 2, { departmentId: 'dep_s1', status: 'pending' }),
      conv('dc_3', 3, { departmentId: 'dep_s1', status: 'closed' }),
      conv('dc_4', 4, { departmentId: 'dep_s1', status: 'archived' }),
      conv('dc_5', 5, { departmentId: 'dep_s1', status: 'active', deletedAt: at(9) }),
      conv('dc_6', 6, { departmentId: 'dep_s2', status: 'resolved' }),
      conv('dc_7', 7, { status: 'active' }),
    ]);
  }, 60_000);

  it('lists by sort order (NULL as 0), then newest first, then id', async () => {
    const res = await app('departments:read').request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(ids(body)).toEqual(['dep_z0b', 'dep_z0a', 'dep_null', 'dep_off', 'dep_s1', 'dep_s2']);
    expect(body.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('counts live agents by departmentId only, over the column', async () => {
    const body = (await (await app('departments:read').request(BASE)).json()) as ListBody;
    const counts = Object.fromEntries(body.data.map((r) => [r.id, r.agentCount]));
    expect(counts).toEqual({ dep_z0b: 0, dep_z0a: 0, dep_null: 1, dep_off: 0, dep_s1: 2, dep_s2: 0 });
  });

  it('pages with a cursor through the ties and the NULL sort order', async () => {
    const { request } = app('departments:read');
    const first = (await (await request(`${BASE}?limit=2`)).json()) as ListBody;
    expect(ids(first)).toEqual(['dep_z0b', 'dep_z0a']);
    expect(first.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'dep_z0a' });
    const second = (await (await request(`${BASE}?limit=2&cursor=dep_z0a`)).json()) as ListBody;
    expect(ids(second)).toEqual(['dep_null', 'dep_off']);
    expect(second.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'dep_off' });
    const third = (await (await request(`${BASE}?limit=2&cursor=dep_off`)).json()) as ListBody;
    expect(ids(third)).toEqual(['dep_s1', 'dep_s2']);
    expect(third.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
    const afterNull = (await (await request(`${BASE}?limit=2&cursor=dep_null`)).json()) as ListBody;
    expect(ids(afterNull)).toEqual(['dep_off', 'dep_s1']);
  });

  it('an unknown cursor is ignored, and the count then drops the last filter instead', async () => {
    // With a cursor the count leaves out the last condition, assumed to be the
    // cursor's; when the cursor row is gone that is the isActive filter.
    const body = (await (await app('departments:read').request(`${BASE}?cursor=dep_missing&isActive=true`)).json()) as ListBody;
    expect(ids(body)).toEqual(['dep_z0b', 'dep_z0a', 'dep_null', 'dep_s1', 'dep_s2']);
    expect(body.pagination.totalCount).toBe(6);
  });

  it('filters on isActive (true, false; anything else is no filter) and search', async () => {
    const { request } = app('departments:read');
    expect(ids((await (await request(`${BASE}?isActive=false`)).json()) as ListBody)).toEqual(['dep_off']);
    expect(ids((await (await request(`${BASE}?isActive=true`)).json()) as ListBody)).toHaveLength(5);
    expect(ids((await (await request(`${BASE}?isActive=yes`)).json()) as ListBody)).toHaveLength(6);
    expect(ids((await (await request(`${BASE}?search=zero%40b`)).json()) as ListBody)).toEqual(['dep_z0b']);
    expect(ids((await (await request(`${BASE}?search=Zero`)).json()) as ListBody)).toEqual(['dep_z0b', 'dep_z0a']);
  });

  it('limit=0, 500 and abc', async () => {
    const { request } = app('departments:read');
    const zero = (await (await request(`${BASE}?limit=0`)).json()) as ListBody;
    expect(zero.data).toEqual([]);
    expect(zero.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: null });
    expect(((await (await request(`${BASE}?limit=500`)).json()) as ListBody).data).toHaveLength(6);
    expect(((await (await request(`${BASE}?limit=abc`)).json()) as ListBody).data).toHaveLength(6);
  });

  it('the detail is the row, with the stored agent_count column', async () => {
    const res = await app('departments:read').request(`${BASE}/dep_s1`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row };
    expect(data.id).toBe('dep_s1');
    expect(data.agentCount).toBe(99);
    expect((await app('departments:read').request(`${BASE}/dep_gone`)).status).toBe(404);
  });

  it('GET /inbox-counts counts open conversations per department', async () => {
    const res = await app('departments:read').request(`${BASE}/inbox-counts`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ departmentId: string; activeCount: number }> };
    const sorted = [...data].sort((a, b) => a.departmentId.localeCompare(b.departmentId));
    expect(sorted).toEqual([
      { departmentId: 'dep_s1', activeCount: 2 },
      { departmentId: 'dep_s2', activeCount: 1 },
    ]);
  });

  it('GET /inbox-counts needs departments:read', async () => {
    expect((await app('agents:read').request(`${BASE}/inbox-counts`)).status).toBe(403);
  });

  it('POST stores the row with its defaults; PATCH refuses a null isActive and sets passthrough columns', async () => {
    const created = await app('departments:create').request(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Billing', email: 'billing@x.test', notAColumn: 1 }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.helpdeskDepartments)
      .where(eq(schema.helpdeskDepartments.id, data.id));
    expect(row?.name).toBe('Billing');
    expect(row?.isActive).toBe(true);
    expect(row?.sortOrder).toBe(0);

    const bad = await app('departments:update').request(`${BASE}/${data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: null }),
    });
    expect(bad.status).toBe(400);
    const passthrough = await app('departments:update').request(`${BASE}/${data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managerName: 'Pat', agentIds: ['agt_1'] }),
    });
    expect(passthrough.status).toBe(200);
  });
});

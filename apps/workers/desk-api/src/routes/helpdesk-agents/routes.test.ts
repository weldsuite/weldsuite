/**
 * Every /api/helpdesk-agents route on pglite: the plain CRUD shape through the
 * shared suite (../../test/crud-suite.ts), then what is particular to agents
 * (the list's filters and ordering, `limit=0`, a null `userId`). Runs against
 * Rust in conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskAgentsRoutes } from './index';

const BASE = '/api/helpdesk-agents';

describeCrud(BASE, {
  base: BASE,
  routes: helpdeskAgentsRoutes,
  table: schema.helpdeskAgents,
  gates: { read: 'agents:read', create: 'agents:create', update: 'agents:update', delete: 'agents:delete' },
  seed: (n) => ({ userId: `user_seed_${n}`, name: `Agent ${n}`, email: `agent${n}@x.test` }),
  valid: { name: 'New Agent', email: 'new@x.test', userId: 'user_new', departmentId: 'dep_1', role: 'agent', isActive: true },
  // `userId` is optional in the schema but NOT NULL in the table.
  unstorable: { name: 'No user', email: 'nouser@x.test' },
  invalid: [
    { name: '', email: 'a@x.test' },
    { name: 'x', email: 'not-an-email' },
    { name: 'x', email: 'a@x.test', role: 'x'.repeat(51) },
    { email: 'a@x.test' },
  ],
  patch: { name: 'Renamed', departmentId: 'dep_2' },
  invalidPatch: { email: 'nope' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle Agent' } },
    { query: 'search=needle%40find', match: { email: 'needle@find.test' } },
    { query: 'departmentId=dep_filter', match: { departmentId: 'dep_filter' } },
    { query: 'userId=user_filter', match: { userId: 'user_filter' } },
    { query: 'status=on_leave', match: { status: 'on_leave' } },
  ],
});

type Row = Record<string, unknown>;
interface ListBody {
  data: Row[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe(`${BASE} · agent specifics`, () => {
  let db: Database;
  const app = (...keys: string[]) =>
    createTestApp(BASE, helpdeskAgentsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

  beforeAll(async () => {
    // The same pglite as the suite above (one per file): start from no agents.
    db = (await createPgliteDb()).db;
    await db.delete(schema.helpdeskAgents);
    const at =(s: number) => new Date(Date.UTC(2026, 1, 1, 9, 0, s));
    const tie = new Date(Date.UTC(2026, 1, 2));
    await db.insert(schema.helpdeskAgents).values([
      { id: 'agt_a', userId: 'user_a', name: 'Alice', email: 'alice@x.test', departmentId: 'dep_x', createdAt: at(1), updatedAt: at(1) },
      { id: 'agt_b', userId: 'user_b', name: 'Bob', email: 'bob@x.test', status: 'inactive', createdAt: at(2), updatedAt: at(2) },
      { id: 'agt_c', userId: 'user_c', name: 'Carol', email: 'carol@x.test', departmentId: 'dep_x', createdAt: tie, updatedAt: tie },
      { id: 'agt_d', userId: 'user_d', name: 'Dave', email: 'dave@x.test', createdAt: tie, updatedAt: tie },
      {
        id: 'agt_gone',
        userId: 'user_gone',
        name: 'Gone',
        email: 'gone@x.test',
        departmentId: 'dep_x',
        createdAt: at(3),
        updatedAt: at(3),
        deletedAt: at(4),
      },
    ]);
  }, 60_000);

  it('lists newest first, the id breaking a tie, without deleted rows', async () => {
    const res = await app('agents:read').request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.map((r) => r.id)).toEqual(['agt_d', 'agt_c', 'agt_b', 'agt_a']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });

  it('pages through the tie with a cursor', async () => {
    const { request } = app('agents:read');
    const first = (await (await request(`${BASE}?limit=1`)).json()) as ListBody;
    expect(first.data.map((r) => r.id)).toEqual(['agt_d']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'agt_d' });
    const second = (await (await request(`${BASE}?limit=2&cursor=agt_d`)).json()) as ListBody;
    expect(second.data.map((r) => r.id)).toEqual(['agt_c', 'agt_b']);
    expect(second.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'agt_b' });
  });

  it('combines filters, and the count follows them', async () => {
    const res = await app('agents:read').request(`${BASE}?departmentId=dep_x&status=active&search=Car`);
    const body = (await res.json()) as ListBody;
    expect(body.data.map((r) => r.id)).toEqual(['agt_c']);
    expect(body.pagination.totalCount).toBe(1);
  });

  it('limit=0 answers no rows, hasMore and no cursor', async () => {
    const body = (await (await app('agents:read').request(`${BASE}?limit=0`)).json()) as ListBody;
    expect(body.data).toEqual([]);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: null });
  });

  it('limit=500 is capped at 100', async () => {
    const body = (await (await app('agents:read').request(`${BASE}?limit=500`)).json()) as ListBody;
    expect(body.data).toHaveLength(4);
  });

  it('the detail of a deleted agent is a 404', async () => {
    const res = await app('agents:read').request(`${BASE}/agt_gone`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBeTruthy();
  });

  it('PATCH with a null userId is the route 500 (NOT NULL column)', async () => {
    const res = await app('agents:update').request(`${BASE}/agt_a`, json({ userId: null }, 'PATCH'));
    expect(res.status).toBe(500);
  });

  it('PATCH sets passthrough columns and leaves the rest', async () => {
    const res = await app('agents:update').request(
      `${BASE}/agt_b`,
      json({ status: 'active', availability: 'busy', skills: ['billing'] }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Row }).data).toEqual({ id: 'agt_b' });
    const [row] = await db.select().from(schema.helpdeskAgents).where(eq(schema.helpdeskAgents.id, 'agt_b'));
    expect(row?.status).toBe('active');
    expect(row?.availability).toBe('busy');
    expect(row?.skills).toEqual(['billing']);
    expect(row?.name).toBe('Bob');
  });

  it('POST stores the row with its defaults', async () => {
    const res = await app('agents:create').request(
      BASE,
      json({ name: 'Eve', email: 'eve@x.test', userId: 'user_e', departmentId: null, metadata: { a: 1 } }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.helpdeskAgents).where(eq(schema.helpdeskAgents.id, data.id));
    expect(row?.role).toBe('agent');
    expect(row?.status).toBe('active');
    expect(row?.departmentId).toBeNull();
  });
});

/**
 * `GET /v1/audit-logs`: scope, filters, both orders, a cursor walk over rows
 * that share a millisecond (microsecond fractions included), the fields that
 * are never exposed, 404 and 405.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';

let db: Database;

interface Item {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  changes: unknown;
  performedBy: string | null;
  performedByName: string | null;
  ipAddress: string | null;
  source: string | null;
}

interface Page {
  data: Item[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

async function insert(id: string, createdAt: string, extra: { action?: string; entityType?: string; entityId?: string; performedBy?: string; source?: string } = {}) {
  await db.execute(sql`
    insert into audit_logs (id, created_at, entity_type, entity_id, action, description, changes, data, performed_by, performed_by_name, ip_address, metadata)
    values (${id}, ${createdAt}::timestamp, ${extra.entityType ?? 'customer'}, ${extra.entityId ?? 'cus_1'}, ${extra.action ?? 'updated'}, ${`Row ${id}`},
            ${JSON.stringify({ name: { from: 'A', to: 'B' } })}::jsonb, ${JSON.stringify({ snapshot: 'secret-snapshot' })}::jsonb,
            ${extra.performedBy ?? 'user_1'}, 'Ann', '203.0.113.9',
            ${JSON.stringify({ source: extra.source ?? 'user', workspaceId: 'ws_1', eventId: 'ev_secret' })}::jsonb)
  `);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // Newest last in insertion order is NOT the id order: ids are chosen so ties break by id.
  await insert('aud_01', '2026-11-01 10:00:00.100000', { action: 'created', entityType: 'customer', entityId: 'cus_1' });
  await insert('aud_02', '2026-11-01 10:00:00.200100', { action: 'updated', entityType: 'customer', entityId: 'cus_1', performedBy: 'user_2' });
  // Three rows in the same millisecond, different microseconds, ids out of time order.
  await insert('aud_05', '2026-11-01 10:00:00.300900', { action: 'updated', entityType: 'order', entityId: 'ord_1', source: 'workflow' });
  await insert('aud_03', '2026-11-01 10:00:00.300100', { action: 'deleted', entityType: 'order', entityId: 'ord_2' });
  await insert('aud_04', '2026-11-01 10:00:00.300500', { action: 'updated', entityType: 'order', entityId: 'ord_3' });
  await insert('aud_06', '2026-11-01 10:00:01.000000', { action: 'created', entityType: 'ticket', entityId: 'tkt_1' });
}, 120_000);

const app = () => createExternalTestApp({ scopes: ['audit_logs:read'], tenantDb: db });

async function get(path: string): Promise<Page> {
  const res = await app().request(path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as Page;
}

const ids = (page: Page) => page.data.map((i) => i.id);

describe('GET /v1/audit-logs', () => {
  it('lists newest first by default with the public fields only', async () => {
    const res = await app().request('/v1/audit-logs');
    const text = await res.text();
    expect(res.status).toBe(200);
    const page = JSON.parse(text) as Page;
    // Same millisecond: ordered by id, newest (highest id) first.
    expect(ids(page)).toEqual(['aud_06', 'aud_05', 'aud_04', 'aud_03', 'aud_02', 'aud_01']);
    expect(page.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
    expect(page.data.find((i) => i.id === 'aud_05')).toEqual({
      id: 'aud_05',
      createdAt: '2026-11-01T10:00:00.300Z',
      action: 'updated',
      entityType: 'order',
      entityId: 'ord_1',
      description: 'Row aud_05',
      changes: { name: { from: 'A', to: 'B' } },
      performedBy: 'user_1',
      performedByName: 'Ann',
      ipAddress: '203.0.113.9',
      source: 'workflow',
    });
    for (const secret of ['secret-snapshot', 'ev_secret', 'eventId', 'workspaceId', 'snapshot', '"metadata"']) {
      expect(text, `leaks ${secret}`).not.toContain(secret);
    }
  });

  it('orders oldest first with order=asc', async () => {
    expect(ids(await get('/v1/audit-logs?order=asc'))).toEqual(['aud_01', 'aud_02', 'aud_03', 'aud_04', 'aud_05', 'aud_06']);
  });

  it('filters by action, entityType, entityId and performedBy', async () => {
    expect(ids(await get('/v1/audit-logs?action=created&order=asc'))).toEqual(['aud_01', 'aud_06']);
    expect(ids(await get('/v1/audit-logs?entityType=order&order=asc'))).toEqual(['aud_03', 'aud_04', 'aud_05']);
    expect(ids(await get('/v1/audit-logs?entityId=ord_2'))).toEqual(['aud_03']);
    expect(ids(await get('/v1/audit-logs?performedBy=user_2'))).toEqual(['aud_02']);
    expect(ids(await get('/v1/audit-logs?entityType=order&action=updated&order=asc'))).toEqual(['aud_04', 'aud_05']);
    const none = await get('/v1/audit-logs?action=nothing');
    expect(none.data).toEqual([]);
    expect(none.pagination.totalCount).toBe(0);
  });

  it('filters by since and until, both inclusive', async () => {
    expect(ids(await get('/v1/audit-logs?since=2026-11-01T10:00:00.250Z&order=asc'))).toEqual(['aud_03', 'aud_04', 'aud_05', 'aud_06']);
    expect(ids(await get('/v1/audit-logs?until=2026-11-01T10:00:00.250Z&order=asc'))).toEqual(['aud_01', 'aud_02']);
    expect(ids(await get('/v1/audit-logs?since=2026-11-01T10:00:00.300Z&until=2026-11-01T10:00:00.999Z&order=asc'))).toEqual(['aud_03', 'aud_04', 'aud_05']);
  });

  it('rejects a bad timestamp, order or limit', async () => {
    for (const q of ['since=yesterday', 'until=nope', 'order=sideways', 'limit=0', 'limit=500']) {
      expect((await app().request(`/v1/audit-logs?${q}`)).status, q).toBe(400);
    }
  });

  it('walks the whole log by cursor in both orders without a gap or a repeat', async () => {
    for (const order of ['asc', 'desc'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page = await get(`/v1/audit-logs?order=${order}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...ids(page));
        expect(page.pagination.totalCount).toBe(6);
        cursor = page.pagination.cursor;
        expect(page.pagination.hasMore).toBe(cursor !== null);
        pages++;
      } while (cursor && pages < 10);
      expect(pages, order).toBe(3);
      const expected = ['aud_01', 'aud_02', 'aud_03', 'aud_04', 'aud_05', 'aud_06'];
      expect(seen, order).toEqual(order === 'asc' ? expected : [...expected].reverse());
    }
  });

  it('pages through rows that share a millisecond with a page size of one', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await get(`/v1/audit-logs?order=asc&limit=1&entityType=order${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...ids(page));
      cursor = page.pagination.cursor;
    } while (cursor && seen.length < 10);
    expect(seen).toEqual(['aud_03', 'aud_04', 'aud_05']);
  });

  it('keeps the filters while paging', async () => {
    const first = await get('/v1/audit-logs?entityType=order&order=asc&limit=2');
    expect(ids(first)).toEqual(['aud_03', 'aud_04']);
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'aud_04' });
    expect(ids(await get('/v1/audit-logs?entityType=order&order=asc&limit=2&cursor=aud_04'))).toEqual(['aud_05']);
  });

  it('answers 400 for a cursor that is not a row, so a poller never silently restarts', async () => {
    const res = await app().request('/v1/audit-logs?cursor=aud_nope');
    expect(res.status).toBe(400);
  });

  it('needs the audit_logs:read scope', async () => {
    const wrong = createExternalTestApp({ scopes: ['legal_entities:read'], tenantDb: db });
    expect((await wrong.request('/v1/audit-logs')).status).toBe(403);
    expect((await wrong.request('/v1/audit-logs/aud_01')).status).toBe(403);
    for (const scopes of [['audit_logs:*'], ['*']]) {
      expect((await createExternalTestApp({ scopes, tenantDb: db }).request('/v1/audit-logs')).status, scopes.join()).toBe(200);
    }
    const anonymous = createExternalTestApp({ session: null, tenantDb: db });
    expect((await anonymous.request('/v1/audit-logs')).status).toBe(401);
  });
});

describe('GET /v1/audit-logs/:id', () => {
  it('returns one row in the public shape', async () => {
    const res = await app().request('/v1/audit-logs/aud_02');
    expect(res.status).toBe(200);
    const text = await res.text();
    const { data } = JSON.parse(text) as { data: Item };
    expect(data).toMatchObject({ id: 'aud_02', createdAt: '2026-11-01T10:00:00.200Z', performedBy: 'user_2', source: 'user' });
    expect(text).not.toContain('secret-snapshot');
    expect(text).not.toContain('ev_secret');
  });

  it('answers 404 for an unknown id', async () => {
    expect((await app().request('/v1/audit-logs/aud_nope')).status).toBe(404);
  });
});

describe('writes', () => {
  it('answer 405 with Allow', async () => {
    const { request } = createExternalTestApp({ scopes: ['*'], tenantDb: db });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request('/v1/audit-logs/aud_01', { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    }
  });
});

describe('GET /v1', () => {
  it('lists /v1/audit-logs among the endpoints', async () => {
    const res = await app().request('/v1');
    const body = (await res.json()) as { data: { endpoints: string[] } };
    expect(body.data.endpoints).toContain('/v1/audit-logs');
  });
});

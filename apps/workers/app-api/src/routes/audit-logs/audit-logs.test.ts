/**
 * /api/audit-logs routes index.test.ts leaves out: cursor and numbered-page
 * paging, more filters, entity history, reading, creating, updating and
 * deleting a row, body validation (the schemas pass unknown keys through, so
 * any key naming a column reaches the insert) and the permission gates. Real
 * pglite tenant DB; runs in the Rust conformance suite too
 * (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { auditLogsRoutes } from './index';

let db: Database;

const at = (day: number) => new Date(Date.UTC(2026, 1, day, 10));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const rows: (typeof schema.auditLogs.$inferInsert)[] = [
    {
      id: 'aud_al_1',
      entityType: 'company',
      entityId: 'cmp_1',
      action: 'created',
      description: "'Alpha' was created by Jane",
      performedBy: 'user_al_jane',
      performedByName: 'Jane',
      changes: { name: { from: null, to: 'Alpha' } },
      data: { name: 'Alpha', size: 12 },
      metadata: { source: 'import' },
      createdAt: at(1),
    },
    {
      id: 'aud_al_2',
      entityType: 'company',
      entityId: 'cmp_1',
      action: 'updated',
      description: "'Alpha' was renamed by Jane",
      performedBy: 'user_al_jane',
      createdAt: at(2),
    },
    {
      id: 'aud_al_3a',
      entityType: 'opportunity',
      entityId: 'opp_1',
      action: 'won',
      description: 'Deal won by Bob',
      performedBy: 'user_al_bob',
      createdAt: at(3),
    },
    {
      id: 'aud_al_3b',
      entityType: 'opportunity',
      entityId: 'opp_2',
      action: 'lost',
      description: 'Deal lost by Bob',
      createdAt: at(3),
    },
    {
      id: 'aud_al_4',
      entityType: 'meeting_session',
      entityId: 'mtg_1',
      action: 'created',
      description: 'Meeting session was created by System',
      createdAt: at(4),
    },
    {
      id: 'aud_al_edit',
      entityType: 'note',
      entityId: 'note_1',
      action: 'created',
      description: 'A note to edit',
      createdAt: at(5),
    },
    {
      id: 'aud_al_drop',
      entityType: 'note',
      entityId: 'note_2',
      action: 'created',
      description: 'A note to delete',
      createdAt: at(5),
    },
  ];
  await db.insert(schema.auditLogs).values(rows);
}, 60_000);

function app(...keys: string[]) {
  return createTestApp('/api/audit-logs', auditLogsRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys) },
  });
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

interface Page {
  data: Array<{ id: string }>;
  pagination: Record<string, unknown>;
}

async function page(query: string): Promise<Page> {
  const res = await app('general:read').request(`/api/audit-logs${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

const ids = (body: Page) => body.data.map((r) => r.id);

async function stored(id: string) {
  const [row] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.id, id));
  return row;
}

describe('GET /api/audit-logs · paging', () => {
  it('pages by cursor, newest first with the id breaking ties', async () => {
    const first = await page('?entityTypeNot=note&limit=2');
    expect(ids(first)).toEqual(['aud_al_3b', 'aud_al_3a']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'aud_al_3a' });

    const rest = await page('?entityTypeNot=note&limit=2&cursor=aud_al_3a');
    expect(ids(rest)).toEqual(['aud_al_2', 'aud_al_1']);
    expect(rest.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });

  it('pages by number when asked for a page', async () => {
    const second = await page('?entityTypeNot=note&page=2&limit=3');
    expect(ids(second)).toEqual(['aud_al_1']);
    expect(second.pagination).toEqual({
      totalCount: 4,
      hasMore: false,
      cursor: null,
      page: 2,
      pageSize: 3,
      totalPages: 2,
    });

    const first = await page('?entityTypeNot=note&page=0&pageSize=2');
    expect(ids(first)).toEqual(['aud_al_3b', 'aud_al_3a']);
    expect(first.pagination).toEqual({
      totalCount: 4,
      hasMore: true,
      cursor: 'aud_al_3a',
      page: 1,
      pageSize: 2,
      totalPages: 2,
    });
  });

  it('lets a cursor win over a page', async () => {
    const body = await page('?entityTypeNot=note&cursor=&page=2&limit=3');
    expect(ids(body)).toEqual(['aud_al_3b', 'aud_al_3a', 'aud_al_2']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'aud_al_2' });
  });

  it('reads the limit as parseInt does', async () => {
    const all = await page('?limit=abc');
    expect(ids(all)).toHaveLength(6);
    expect(all.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });

    const one = await page('?limit=0');
    expect(ids(one)).toEqual(['aud_al_edit']);
    expect(one.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'aud_al_edit' });

    const capped = await page('?limit=500&entityType=company');
    expect(ids(capped)).toEqual(['aud_al_2', 'aud_al_1']);
  });
});

describe('GET /api/audit-logs · filters', () => {
  it('combines equality filters', async () => {
    expect(ids(await page('?entityId=cmp_1&action=updated'))).toEqual(['aud_al_2']);
    expect(ids(await page('?entityType=opportunity&performedBy=user_al_bob'))).toEqual(['aud_al_3a']);
  });

  it('keeps rows without the column when excluding', async () => {
    expect(ids(await page('?entityTypeNot=note&performedByNot=user_al_jane'))).toEqual(['aud_al_3b', 'aud_al_3a']);
  });

  it('searches the entity id and description case-insensitively', async () => {
    expect(ids(await page('?search=ALPHA'))).toEqual(['aud_al_2', 'aud_al_1']);
    expect(ids(await page('?search=%20opp_2%20'))).toEqual(['aud_al_3b']);
  });

  it('answers 400 for a date it cannot read', async () => {
    const res = await app('general:read').request('/api/audit-logs?startDate=2026-01-01T00:00:00.000Z&endDate=soon');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid endDate — expected an ISO 8601 date' },
    });
  });

  it('needs general:read', async () => {
    const res = await app().request('/api/audit-logs');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/audit-logs/:entityType/:entityId and /:id', () => {
  it('returns the history of one entity, hidden types included', async () => {
    const res = await app('general:read').request('/api/audit-logs/meeting_session/mtg_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id)).toEqual(['aud_al_4']);
    expect(Object.keys(body)).toEqual(['data']);

    const limited = (await (await app('general:read').request('/api/audit-logs/company/cmp_1?limit=1')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(limited.data.map((r) => r.id)).toEqual(['aud_al_2']);
  });

  it('returns one row with its jsonb columns', async () => {
    const res = await app('general:read').request('/api/audit-logs/aud_al_1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      id: 'aud_al_1',
      createdAt: '2026-02-01T10:00:00.000Z',
      entityType: 'company',
      entityId: 'cmp_1',
      action: 'created',
      description: "'Alpha' was created by Jane",
      changes: { name: { from: null, to: 'Alpha' } },
      data: { name: 'Alpha', size: 12 },
      performedBy: 'user_al_jane',
      performedByName: 'Jane',
      ipAddress: null,
      metadata: { source: 'import' },
    });
  });

  it('answers 404 for an unknown id', async () => {
    const res = await app('general:read').request('/api/audit-logs/aud_al_missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Audit log with ID 'aud_al_missing' not found" },
    });
  });

  it('needs general:read', async () => {
    expect((await app().request('/api/audit-logs/aud_al_1')).status).toBe(403);
    expect((await app().request('/api/audit-logs/company/cmp_1')).status).toBe(403);
  });
});

describe('POST /api/audit-logs', () => {
  it('creates a row; every key naming a column reaches the insert', async () => {
    const res = await app('general:create').request(
      '/api/audit-logs',
      send('POST', {
        userId: 'not a column',
        details: { not: 'a column' },
        entityType: 'invoice',
        entityId: 'inv_1',
        action: 'sent',
        description: 'Invoice sent',
        performedBy: 'user_al_jane',
        performedByName: 'Jane',
        ipAddress: '10.0.0.1',
        changes: { status: { from: 'draft', to: 'sent' } },
        data: { total: 5 },
        metadata: { via: 'test' },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(Object.keys(data)).toEqual(['id']);
    expect(await stored(data.id)).toMatchObject({
      entityType: 'invoice',
      entityId: 'inv_1',
      action: 'sent',
      description: 'Invoice sent',
      performedBy: 'user_al_jane',
      performedByName: 'Jane',
      ipAddress: '10.0.0.1',
      changes: { status: { from: 'draft', to: 'sent' } },
      data: { total: 5 },
      metadata: { via: 'test' },
    });
  });

  it('rejects a body the schema refuses', async () => {
    const bad = [
      { entityType: 'x', entityId: 'y', action: 'a'.repeat(101), description: 'd' },
      { entityType: 'x', entityId: 7, action: 'a', description: 'd' },
      { entityType: 'e'.repeat(51), entityId: 'y', action: 'a', description: 'd' },
    ];
    for (const body of bad) {
      const res = await app('general:create').request('/api/audit-logs', send('POST', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
    }
  });

  it('answers 500 when the insert fails', async () => {
    const failing = [
      { entityType: 'x', entityId: 'y', action: 'a' },
      { entityType: 'x', entityId: null, action: 'a', description: 'd' },
      { entityType: 'x', entityId: 'y', action: 'a'.repeat(51), description: 'd' },
      { entityType: 'x', entityId: 'y', action: 'a', description: 'd', ipAddress: '1'.repeat(46) },
      { id: 'aud_al_1', entityType: 'x', entityId: 'y', action: 'a', description: 'd' },
    ];
    for (const body of failing) {
      const res = await app('general:create').request('/api/audit-logs', send('POST', body));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create audit log' } });
    }
  });

  it('needs general:create', async () => {
    const res = await app('general:read').request(
      '/api/audit-logs',
      send('POST', { entityType: 'x', entityId: 'y', action: 'a', description: 'd' }),
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH and DELETE /api/audit-logs/:id', () => {
  it('updates the column keys of the body', async () => {
    const res = await app('general:update').request(
      '/api/audit-logs/aud_al_edit',
      send('PATCH', { description: 'Edited', metadata: { edited: true }, details: 'ignored', performedBy: null }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'aud_al_edit' } });
    expect(await stored('aud_al_edit')).toMatchObject({
      description: 'Edited',
      metadata: { edited: true },
      performedBy: null,
    });
  });

  it('answers 404 for an unknown id and 500 with nothing to set', async () => {
    const missing = await app('general:update').request('/api/audit-logs/aud_al_missing', send('PATCH', { action: 'x' }));
    expect(missing.status).toBe(404);

    for (const body of [{}, { details: 'not a column' }, { description: null }]) {
      const res = await app('general:update').request('/api/audit-logs/aud_al_edit', send('PATCH', body));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update audit log' } });
    }
  });

  it('needs general:update', async () => {
    const res = await app('general:read').request('/api/audit-logs/aud_al_edit', send('PATCH', { action: 'x' }));
    expect(res.status).toBe(403);
  });

  it('deletes a row once', async () => {
    const res = await app('general:delete').request('/api/audit-logs/aud_al_drop', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await stored('aud_al_drop')).toBeUndefined();

    const again = await app('general:delete').request('/api/audit-logs/aud_al_drop', { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('needs general:delete', async () => {
    const res = await app('general:update').request('/api/audit-logs/aud_al_edit', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});

/**
 * GET /api/audit-logs filters (Settings › Activity Log) against pglite:
 * internal WeldMeet rows hidden by default, comma-list entity types, user and
 * date filters, and free-text search.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { auditLogsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

interface Row {
  id: string;
  entityType: string;
}

async function list(query = ''): Promise<Row[]> {
  const t = createTestApp('/api/audit-logs', auditLogsRoutes, {
    context: { tenantDb: db, permissions: permissions('general:read') },
  });
  const res = await t.request(`/api/audit-logs?limit=100${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Row[] }).data;
}

const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const rows: Array<[string, string, string, string, string]> = [
    // id, entityType, action, description, performedBy
    ['aud_1', 'company', 'created', "'Acme' was created by Jane", 'user_jane'],
    ['aud_2', 'customer', 'updated', 'Jane updated Company', 'user_jane'],
    ['aud_3', 'opportunity', 'won', "'Zeta 50% deal' was marked as won by Bob", 'user_bob'],
    ['aud_4', 'meeting_session', 'created', 'Meeting session was created by System', 'user_bob'],
    ['aud_5', 'meeting_message', 'created', 'Meeting message was created by System', 'user_bob'],
  ];
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));
  for (const [i, [id, entityType, action, description, performedBy]] of rows.entries()) {
    await db.insert(schema.auditLogs).values({
      id,
      entityType,
      entityId: `${entityType}_${i}`,
      action,
      description,
      performedBy,
      createdAt: day(10 + i),
      updatedAt: day(10 + i),
    } as typeof schema.auditLogs.$inferInsert);
  }
}, 60_000);

describe('GET /api/audit-logs', () => {
  it('hides internal meeting session and message rows by default', async () => {
    expect(ids(await list())).toEqual(['aud_1', 'aud_2', 'aud_3']);
  });

  it('still returns them when that entity type is asked for', async () => {
    expect(ids(await list('&entityType=meeting_session'))).toEqual(['aud_4']);
  });

  it('accepts a comma list of entity types (current + legacy name)', async () => {
    expect(ids(await list('&entityType=company,customer'))).toEqual(['aud_1', 'aud_2']);
  });

  it('filters by user', async () => {
    expect(ids(await list('&performedBy=user_bob'))).toEqual(['aud_3']);
  });

  it('filters by date range', async () => {
    const start = encodeURIComponent(new Date(Date.UTC(2026, 9, 11)).toISOString());
    const end = encodeURIComponent(new Date(Date.UTC(2026, 9, 12, 23, 59)).toISOString());
    expect(ids(await list(`&startDate=${start}&endDate=${end}`))).toEqual(['aud_2', 'aud_3']);
  });

  it('searches the description, with LIKE wildcards taken literally', async () => {
    expect(ids(await list('&search=acme'))).toEqual(['aud_1']);
    expect(ids(await list(`&search=${encodeURIComponent('50%')}`))).toEqual(['aud_3']);
    expect(ids(await list(`&search=${encodeURIComponent('%')}`))).toEqual(['aud_3']);
  });
});

describe('GET /api/audit-logs · exclusions', () => {
  it('excludes with <param>Not', async () => {
    expect(ids(await list('&entityTypeNot=company,customer'))).toEqual(['aud_3']);
    expect(ids(await list('&performedByNot=user_bob'))).toEqual(['aud_1', 'aud_2']);
  });
});

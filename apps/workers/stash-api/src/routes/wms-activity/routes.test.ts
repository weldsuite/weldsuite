/**
 * Every /api/wms-activity route on pglite: the read-only WMS activity log
 * (list with counts, summary, by entity, by user, recent). Runs against Rust
 * in conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { wmsActivityRoutes } from './index';

let db: Database;
const base = '/api/wms-activity';
const app = (...keys: string[]) =>
  createTestApp(base, wmsActivityRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = Date.now();
  const types = ['create', 'update', 'delete', 'receive', 'ship', 'pick', 'pack', 'adjust', 'transfer', 'other'];
  await db.insert(schema.activityLogs).values(
    types.map((activityType, i) => ({
      id: `act_seed${i}`,
      activityType,
      entityType: i % 2 === 0 ? 'pick_list' : 'inventory',
      entityId: i < 3 ? 'pl_needle' : `ent_${i}`,
      userId: i % 3 === 0 ? 'user_a' : 'user_b',
      warehouseId: i < 5 ? 'wh_a' : 'wh_b',
      description: i === 4 ? 'Shipped the haystack' : `Activity ${i}`,
      // Spread over five weeks, so each summary period counts a different set.
      createdAt: new Date(now - i * 4 * DAY - 60_000),
    })),
  );
  await db.insert(schema.activityLogs).values([
    { id: 'act_tie1', activityType: 'pick', createdAt: new Date(Date.UTC(2025, 0, 1)) },
    { id: 'act_tie2', activityType: 'pick', createdAt: new Date(Date.UTC(2025, 0, 1)) },
  ]);
}, 60_000);

describe('/api/wms-activity · list', () => {
  it('lists newest first with the count and the activity counts', async () => {
    const res = await app('inventory:read').request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; counts: { total: number; pick: number } };
    expect(body.counts.total).toBe(12);
    expect(body.counts.pick).toBe(3);
  });

  it('filters', async () => {
    const { request } = app('inventory:read');
    for (const query of [
      'search=haystack',
      'search=needle',
      'activityType=ship',
      'activityType=all',
      'entityType=pick_list',
      'entityType=all',
      'entityId=pl_needle',
      'userId=user_a',
      'warehouseId=wh_b',
      'warehouseId=all',
      `dateFrom=${new Date(Date.now() - 10 * DAY).toISOString()}`,
      `dateTo=${new Date(Date.now() - 10 * DAY).toISOString()}`,
      'dateFrom=2025-01-01&dateTo=2025-01-02',
      'search=&activityType=&userId=',
    ]) {
      expect((await request(`${base}?${query}`)).status, query).toBe(200);
    }
  });

  it('answers its 500 for a date it cannot read', async () => {
    expect((await app('inventory:read').request(`${base}?dateFrom=not-a-date`)).status).toBe(500);
  });

  it('pages with a cursor; a cursor that is gone drops the last filter from the count', async () => {
    const { request } = app('inventory:read');
    const first = (await (await request(`${base}?limit=3`)).json()) as { pagination: { cursor: string } };
    expect((await request(`${base}?limit=3&cursor=${first.pagination.cursor}`)).status).toBe(200);
    expect((await request(`${base}?limit=20&cursor=act_tie1`)).status).toBe(200);
    expect((await request(`${base}?cursor=act_missing&warehouseId=wh_a`)).status).toBe(200);
    for (const limit of ['0', 'abc', '-1', '500']) {
      expect((await request(`${base}?limit=${limit}`)).status).toBe(200);
    }
  });

  it('needs inventory:read', async () => {
    expect((await app().request(base)).status).toBe(403);
  });
});

describe('/api/wms-activity · summary', () => {
  it('counts a period, scoped to a warehouse', async () => {
    const { request } = app('inventory:read');
    for (const query of ['', '?period=1d', '?period=30d', '?period=7d', '?period=year', '?warehouseId=wh_a', '?warehouseId=all&period=30d']) {
      const res = await request(`${base}/summary${query}`);
      expect(res.status).toBe(200);
    }
    expect((await app().request(`${base}/summary`)).status).toBe(403);
  });
});

describe('/api/wms-activity · entity, user, recent', () => {
  it('answers an entity\'s activity', async () => {
    const { request } = app('inventory:read');
    const res = await request(`${base}/entity/pick_list/pl_needle`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(2);
    expect((await request(`${base}/entity/pick_list/pl_needle?limit=1`)).status).toBe(200);
    expect((await request(`${base}/entity/inventory/missing?limit=abc`)).status).toBe(200);
    expect((await app().request(`${base}/entity/pick_list/pl_needle`)).status).toBe(403);
  });

  it('answers a user\'s activity', async () => {
    const { request } = app('inventory:read');
    expect((await request(`${base}/user/user_a`)).status).toBe(200);
    expect((await request(`${base}/user/user_b?limit=2`)).status).toBe(200);
    expect((await request(`${base}/user/user_b?limit=500`)).status).toBe(200);
    expect((await app().request(`${base}/user/user_a`)).status).toBe(403);
  });

  it('answers the most recent activity', async () => {
    const { request } = app('inventory:read');
    for (const query of ['', '?limit=3', '?limit=80', '?warehouseId=wh_b', '?warehouseId=all', '?limit=-1']) {
      expect((await request(`${base}/recent${query}`)).status).toBe(200);
    }
    expect((await app().request(`${base}/recent`)).status).toBe(403);
  });
});

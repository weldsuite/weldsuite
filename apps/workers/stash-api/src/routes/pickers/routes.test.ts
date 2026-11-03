/**
 * Every /api/pickers route on pglite: warehouse workers (list with stats,
 * stats, detail with pick performance, their pick lists, create, full
 * update, status, soft delete). Runs against Rust in conformance mode
 * (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json } from '../../test/crud-suite';
import { pickersRoutes } from './index';

let db: Database;
const base = '/api/pickers';
const app = (...keys: string[]) =>
  createTestApp(base, pickersRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const worker = (n: number, overrides: Partial<typeof schema.warehouseWorkers.$inferInsert> = {}) => ({
  id: `wkr_seed${n}`,
  name: `Picker ${n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, n)),
  ...overrides,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.warehouseWorkers).values([
    worker(1, { warehouseId: 'wh_a', status: 'active', role: 'picker' }),
    worker(2, { warehouseId: 'wh_a', status: 'inactive', email: 'needle@pickers.test' }),
    worker(3, { warehouseId: 'wh_b', status: 'on_break', role: 'packer', name: 'Haystack Hal' }),
    worker(4, { warehouseId: 'wh_b', skills: ['forklift'] }),
    worker(5, { createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    worker(6, { createdAt: new Date(Date.UTC(2026, 0, 2)) }),
  ]);
  await db.insert(schema.pickLists).values([
    { id: 'pl_p1', pickListNumber: 'PL-1', warehouseId: 'wh_a', assignedTo: 'wkr_seed1', status: 'completed', totalItems: 3, pickedItems: 3 },
    { id: 'pl_p2', pickListNumber: 'PL-2', warehouseId: 'wh_a', assignedTo: 'wkr_seed1', status: 'in_progress', totalItems: 2, pickedItems: 1, createdAt: new Date(Date.UTC(2026, 1, 1)) },
    { id: 'pl_p3', pickListNumber: 'PL-3', warehouseId: 'wh_a', assignedTo: 'wkr_seed1', status: 'pending', deletedAt: new Date() },
  ]);
}, 60_000);

describe('/api/pickers · list and stats', () => {
  it('lists with the count and the status stats', async () => {
    const res = await app('warehouses:read').request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; stats: { total: number; on_break: number } };
    expect(body.stats.on_break).toBe(1);
  });

  it('filters, pages and ignores `all`', async () => {
    const { request } = app('warehouses:read');
    for (const query of [
      'search=needle',
      'search=Haystack',
      'status=active',
      'status=all',
      'warehouseId=wh_b',
      'warehouseId=all',
      'role=packer',
      'role=all',
      'limit=2',
      'limit=0',
      'limit=abc',
      'cursor=wkr_seed3&limit=2',
      'cursor=wkr_missing&role=picker',
      'cursor=wkr_missing',
    ]) {
      expect((await request(`${base}?${query}`)).status, query).toBe(200);
    }
    expect((await app().request(base)).status).toBe(403);
  });

  it('answers the stats, optionally for one warehouse', async () => {
    const { request } = app('warehouses:read');
    for (const query of ['', '?warehouseId=wh_a', '?warehouseId=all', '?warehouseId=']) {
      expect((await request(`${base}/stats${query}`)).status).toBe(200);
    }
    expect((await app().request(`${base}/stats`)).status).toBe(403);
  });
});

describe('/api/pickers · detail and pick lists', () => {
  it('answers a picker with their pick performance', async () => {
    const { request } = app('warehouses:read');
    const res = await request(`${base}/wkr_seed1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { performance: { totalPicklists: number } } };
    expect(body.data.performance.totalPicklists).toBe(2);
    expect((await request(`${base}/wkr_seed4`)).status).toBe(200);
    expect((await request(`${base}/wkr_missing`)).status).toBe(404);
    expect((await app().request(`${base}/wkr_seed1`)).status).toBe(403);
  });

  it('answers the pick lists assigned to a picker', async () => {
    const { request } = app('warehouses:read');
    for (const query of ['', '?status=completed', '?status=all']) {
      expect((await request(`${base}/wkr_seed1/picklists${query}`)).status).toBe(200);
    }
    expect((await request(`${base}/wkr_missing/picklists`)).status).toBe(200);
    expect((await app().request(`${base}/wkr_seed1/picklists`)).status).toBe(403);
  });
});

describe('/api/pickers · writes', () => {
  it('creates a picker with defaults', async () => {
    const { request } = app('warehouses:create');
    expect((await request(base, json({ name: 'New Picker' }))).status).toBe(201);
    const res = await request(
      base,
      json({
        name: 'Packer Pat',
        email: 'pat@pickers.test',
        phone: '+3100',
        warehouseId: 'wh_a',
        userId: null,
        role: 'packer',
        status: 'on_break',
        skills: ['scanner'],
        notes: 'nights',
        metadata: { shift: 'night' },
      }),
    );
    expect(res.status).toBe(201);
  });

  it('refuses an invalid picker', async () => {
    const { request } = app('warehouses:create');
    for (const body of [{}, { name: '' }, { name: 'x', email: 'nope' }, { name: 'x', status: 'sleeping' }, { name: 'x', skills: 'a' }]) {
      expect((await request(base, json(body))).status).toBe(400);
    }
    expect((await request(base, json({ name: 'x', userId: 'u'.repeat(40) }))).status).toBe(500);
    expect((await app('warehouses:read').request(base, json({ name: 'x' }))).status).toBe(403);
  });

  it('updates a picker', async () => {
    const { request } = app('warehouses:update');
    expect((await request(`${base}/wkr_seed4`, json({ name: 'Renamed', skills: ['a', 'b'] }, 'PUT'))).status).toBe(200);
    expect((await request(`${base}/wkr_seed4`, json({ warehouseId: null, status: 'inactive' }, 'PUT'))).status).toBe(200);
    expect((await request(`${base}/wkr_seed4`, json({}, 'PUT'))).status).toBe(200);
    expect((await request(`${base}/wkr_missing`, json({ name: 'x' }, 'PUT'))).status).toBe(404);
    expect((await request(`${base}/wkr_seed4`, json({ status: 'gone' }, 'PUT'))).status).toBe(400);
    expect((await app().request(`${base}/wkr_seed4`, json({ name: 'x' }, 'PUT'))).status).toBe(403);
  });

  it('sets a picker\'s status', async () => {
    const { request } = app('warehouses:update');
    expect((await request(`${base}/wkr_seed2/status`, json({ status: 'active' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/wkr_seed2/status`, json({ status: 'whatever' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/wkr_seed2/status`, json({}, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/wkr_seed2/status`, json({ status: '' }, 'PATCH'))).status).toBe(400);
    expect(
      (await request(`${base}/wkr_seed2/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: 'nope' })).status,
    ).toBe(400);
    expect((await request(`${base}/wkr_missing/status`, json({ status: 'active' }, 'PATCH'))).status).toBe(404);
    expect((await request(`${base}/wkr_seed2/status`, json({ status: 'x'.repeat(30) }, 'PATCH'))).status).toBe(500);
    expect((await app().request(`${base}/wkr_seed2/status`, json({ status: 'active' }, 'PATCH'))).status).toBe(403);
  });

  it('soft-deletes a picker', async () => {
    const { request } = app('warehouses:delete', 'warehouses:read');
    expect((await request(`${base}/wkr_seed6`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/wkr_seed6`, { method: 'DELETE' })).status).toBe(404);
    expect((await request(`${base}/wkr_seed6`)).status).toBe(404);
    expect((await app().request(`${base}/wkr_seed5`, { method: 'DELETE' })).status).toBe(403);
  });
});

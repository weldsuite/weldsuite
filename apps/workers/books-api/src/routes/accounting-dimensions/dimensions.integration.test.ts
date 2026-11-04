/**
 * /api/accounting-dimensions (pglite): classes and locations of an entity.
 * Create, list (filters, cursor), read, update and delete, and the refusals:
 * duplicate codes, a parent of another dimension or a circular one, a value
 * with children or on a booking, a bad cursor or dimension, permissions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingDimensionsRoutes } from './index';

let db: Database;
const ENTITY = 'ent_dim';

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[]; entity?: string | null } = {}) {
  const { request } = createTestApp('/api/accounting-dimensions', accountingDimensionsRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const entity = opts.entity === undefined ? ENTITY : opts.entity;
  const res = await request(`/api/accounting-dimensions${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; pagination?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values({ id: ENTITY, name: 'Dims Inc', jurisdictionCode: 'US', baseCurrency: 'USD' });
}, 60_000);

describe('classes and locations', () => {
  const ids: Record<string, string> = {};

  it('creates values, trimmed, with a parent of the same dimension', async () => {
    const retail = await call('', { method: 'POST', body: { dimension: 'class', name: '  Retail ', code: ' R ' } });
    expect(retail.status).toBe(201);
    expect(retail.data).toMatchObject({ dimension: 'class', name: 'Retail', code: 'R', parentId: null, isActive: true, deletedAt: null });
    ids.retail = retail.data.id;
    const online = await call('', { method: 'POST', body: { dimension: 'class', name: 'Online', parentId: ids.retail } });
    expect(online.status).toBe(201);
    ids.online = online.data.id;
    const hq = await call('', { method: 'POST', body: { dimension: 'location', name: 'HQ', isActive: false } });
    ids.hq = hq.data.id;
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const res = await call('', { method: 'POST', body: { dimension: 'location', name, code: name.slice(0, 1) } });
      ids[name] = res.data.id;
    }
  });

  it('lists by name with filters and a cursor', async () => {
    const classes = await call('?dimension=class');
    expect(classes.data.map((v: { name: string }) => v.name)).toEqual(['Online', 'Retail']);
    expect(classes.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
    const children = await call(`?parentId=${ids.retail}`);
    expect(children.data.map((v: { name: string }) => v.name)).toEqual(['Online']);
    const inactive = await call('?isActive=false');
    expect(inactive.data.map((v: { name: string }) => v.name)).toEqual(['HQ']);
    const search = await call('?search=et');
    expect(search.data.map((v: { name: string }) => v.name)).toEqual(['Beta', 'Retail']);
    const first = await call('?dimension=location&limit=2');
    expect(first.data.map((v: { name: string }) => v.name)).toEqual(['Alpha', 'Beta']);
    expect(first.pagination.hasMore).toBe(true);
    const next = await call(`?dimension=location&limit=2&cursor=${encodeURIComponent(first.pagination.cursor)}`);
    expect(next.data.map((v: { name: string }) => v.name)).toEqual(['Gamma', 'HQ']);
  });

  it('reads one value', async () => {
    const res = await call(`/${ids.online}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ name: 'Online', parentId: ids.retail });
  });

  it('updates a value', async () => {
    const res = await call(`/${ids.online}`, { method: 'PATCH', body: { name: 'Web shop', code: 'W', isActive: false } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ name: 'Web shop', code: 'W', isActive: false });
    const cleared = await call(`/${ids.online}`, { method: 'PATCH', body: { code: null } });
    expect(cleared.data.code).toBeNull();
  });

  it('refuses duplicate codes and bad parents', async () => {
    const dup = await call('', { method: 'POST', body: { dimension: 'location', name: 'Another', code: 'A' } });
    expect(dup.status).toBe(409);
    expect(dup.error?.message).toBe("Code 'A' is already used by another location");
    const dupPatch = await call(`/${ids.Beta}`, { method: 'PATCH', body: { code: 'A' } });
    expect(dupPatch.status).toBe(409);
    const wrongDimension = await call('', { method: 'POST', body: { dimension: 'location', name: 'Sub', parentId: ids.retail } });
    expect(wrongDimension.status).toBe(400);
    expect(wrongDimension.error?.message).toBe('The parent must be an existing value of the same dimension');
    const self = await call(`/${ids.retail}`, { method: 'PATCH', body: { parentId: ids.retail } });
    expect(self.error?.message).toBe('A value cannot be its own parent');
    const circular = await call(`/${ids.retail}`, { method: 'PATCH', body: { parentId: ids.online } });
    expect(circular.status).toBe(400);
    expect(circular.error?.message).toBe('That parent would make the hierarchy circular');
  });

  it('refuses to delete a value with children or on a booking, then deletes', async () => {
    const parent = await call(`/${ids.retail}`, { method: 'DELETE' });
    expect(parent.status).toBe(409);
    expect(parent.error?.message).toBe('This value has children — move or delete them first');
    await db.insert(schema.journalEntries).values({ id: 'je_dim', entityId: ENTITY, date: new Date('2026-01-01'), status: 'draft' });
    await db.insert(schema.journalLines).values({ id: 'jl_dim', entityId: ENTITY, journalEntryId: 'je_dim', accountId: 'acc_x', locationId: ids.Gamma });
    const used = await call(`/${ids.Gamma}`, { method: 'DELETE' });
    expect(used.status).toBe(409);
    expect(used.error?.message).toBe('This location is used on bookings — deactivate it instead');
    expect((await call(`/${ids.online}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/${ids.online}`)).status).toBe(404);
    expect((await call(`/${ids.retail}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('refuses a bad cursor, a bad dimension and a bad body; an entity-less tenant lists nothing', async () => {
    expect((await call('?cursor=***')).status).toBe(400);
    expect((await call('?dimension=region')).status).toBe(400);
    expect((await call('', { method: 'POST', body: { dimension: 'region', name: '' } })).status).toBe(400);
    expect((await call('', { method: 'POST', entity: 'ent_missing', body: { dimension: 'class', name: 'X' } })).status).toBe(400);
    const none = await call('', { entity: 'ent_missing' });
    expect(none.status).toBe(200);
    expect(none.data).toEqual([]);
    expect((await call('/dim_missing', { method: 'PATCH', body: { name: 'X' } })).status).toBe(404);
    expect((await call('/dim_missing', { method: 'DELETE' })).status).toBe(404);
  });

  it('needs the accounts permissions', async () => {
    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await call(`/${ids.hq}`, { perms: ['invoices:read'] })).status).toBe(403);
    expect((await call('', { method: 'POST', perms: ['accounts:read'], body: { dimension: 'class', name: 'X' } })).status).toBe(403);
    expect((await call(`/${ids.hq}`, { method: 'PATCH', perms: ['accounts:read'], body: { name: 'X' } })).status).toBe(403);
    expect((await call(`/${ids.hq}`, { method: 'DELETE', perms: ['accounts:read'] })).status).toBe(403);
  });
});

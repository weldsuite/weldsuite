/**
 * DELETE /api/accounting-entities/:id (pglite): a soft delete that takes the
 * entity out of every list and read; unknown ids and missing permissions are
 * refused. Also the list and read of a seeded entity.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from './index';

let db: Database;

async function call(path: string, opts: { method?: string; perms?: string[] } = {}) {
  const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const res = await request(`/api/accounting-entities${path}`, { method: opts.method ?? 'GET' });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values([
    { id: 'ent_keep', name: 'Keep BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', taxIdentifiers: { einOrSsn: '123-45-6789' } },
    { id: 'ent_gone', name: 'Gone BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
  ]);
}, 60_000);

describe('DELETE /api/accounting-entities/:id', () => {
  it('lists and reads seeded entities, an SSN in the EIN slot masked', async () => {
    const all = await call('');
    expect(all.data.map((e: { id: string }) => e.id)).toEqual(['ent_gone', 'ent_keep']);
    const keep = await call('/ent_keep');
    expect(keep.data).toMatchObject({ hasSsn: false, hasPostings: false, taxIdentifiers: { einOrSsn: '***-**-6789' } });
  });

  it('needs entities:delete', async () => {
    expect((await call('/ent_gone', { method: 'DELETE', perms: ['entities:read'] })).status).toBe(403);
  });

  it('soft-deletes the entity', async () => {
    expect((await call('/ent_gone', { method: 'DELETE' })).status).toBe(204);
    expect((await call('/ent_gone')).status).toBe(404);
    expect((await call('')).data.map((e: { id: string }) => e.id)).toEqual(['ent_keep']);
    expect((await call('/ent_gone', { method: 'DELETE' })).status).toBe(404);
  });
});

/**
 * DELETE /api/accounting-entities/:id (pglite): switches WeldBooks off for the
 * entity (removes only the extension row, the company stays), is refused once
 * WeldBooks holds documents, and unknown ids and missing permissions are
 * refused. Also the list and read of a seeded entity.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
    { id: 'ent_busy', name: 'Busy BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    { id: 'ent_hr', name: 'HR only BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
  ]);
  // WeldBooks is enabled by an extension row; ent_hr has none.
  await db.insert(schema.accountingEntitySettings).values([
    { entityId: 'ent_keep' },
    { entityId: 'ent_gone' },
    { entityId: 'ent_busy' },
  ]);
  await db.insert(schema.invoices).values({
    id: 'inv_busy',
    entityId: 'ent_busy',
    invoiceNumber: 'INV-0001',
    contactId: 'acn_busy',
    status: 'draft',
    issueDate: new Date('2026-01-01'),
    dueDate: new Date('2026-01-31'),
    currency: 'EUR',
  } as typeof schema.invoices.$inferInsert);
}, 60_000);

describe('DELETE /api/accounting-entities/:id', () => {
  it('lists the entities WeldBooks is enabled for, an SSN in the EIN slot masked', async () => {
    const all = await call('');
    expect(all.data.map((e: { id: string }) => e.id)).toEqual(['ent_busy', 'ent_gone', 'ent_keep']);
    const keep = await call('/ent_keep');
    expect(keep.data).toMatchObject({ hasSsn: false, hasPostings: false, taxIdentifiers: { einOrSsn: '***-**-6789' } });
  });

  it('needs entities:delete', async () => {
    expect((await call('/ent_gone', { method: 'DELETE', perms: ['entities:read'] })).status).toBe(403);
  });

  it('removes only the WeldBooks extension, the company stays', async () => {
    expect((await call('/ent_gone', { method: 'DELETE' })).status).toBe(204);
    expect((await call('')).data.map((e: { id: string }) => e.id)).toEqual(['ent_busy', 'ent_keep']);
    expect((await call('/ent_gone', { method: 'DELETE' })).status).toBe(404);
    const [core] = await db.select().from(schema.entities).where(eq(schema.entities.id, 'ent_gone')).limit(1);
    expect(core?.deletedAt).toBeNull();
    const ext = await db.select().from(schema.accountingEntitySettings).where(eq(schema.accountingEntitySettings.entityId, 'ent_gone'));
    expect(ext).toHaveLength(0);
  });

  it('is refused once WeldBooks holds documents for the entity', async () => {
    const res = await call('/ent_busy', { method: 'DELETE' });
    expect(res.status).toBe(409);
    const ext = await db.select().from(schema.accountingEntitySettings).where(eq(schema.accountingEntitySettings.entityId, 'ent_busy'));
    expect(ext).toHaveLength(1);
  });

  it('answers 404 for an entity WeldBooks is not enabled for', async () => {
    expect((await call('/ent_hr', { method: 'DELETE' })).status).toBe(404);
  });
});

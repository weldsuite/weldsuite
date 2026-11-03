/**
 * /api/journal-entries (pglite): manual entries from draft to posted and
 * reversed. Lists, reads, creates, edits and deletes drafts; posting applies
 * balances and the tax ledger; posted entries are immutable; closed periods,
 * lock dates, unknown accounts and dimensions, unbalanced lines and missing
 * permissions are refused.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { journalEntriesRoutes } from './index';

let db: Database;
const ENTITY = 'ent_je';

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[]; entity?: string | null } = {}) {
  const { request } = createTestApp('/api/journal-entries', journalEntriesRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const entity = opts.entity === undefined ? ENTITY : opts.entity;
  const res = await request(`/api/journal-entries${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; pagination?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-03-10',
  description: 'Office rent',
  reference: 'R-1',
  lines: [
    { accountId: 'acc_rent', debit: '121.00', taxRateId: 'txr_21', taxAmount: '21.00', description: 'Rent March' },
    { accountId: 'acc_bank', credit: '121.00' },
  ],
  ...overrides,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values([
    { id: ENTITY, name: 'Ledger BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    { id: 'ent_other', name: 'Other BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', periodLockDate: '2026-01-31' },
  ]);
  await db.insert(schema.accounts).values([
    { id: 'acc_rent', entityId: ENTITY, code: '4300', name: 'Rent', type: 'expense', normalSide: 'debit' },
    { id: 'acc_bank', entityId: ENTITY, code: '1100', name: 'Bank', type: 'asset', normalSide: 'debit' },
    { id: 'acc_foreign', entityId: 'ent_other', code: '1100', name: 'Bank', type: 'asset', normalSide: 'debit' },
  ]);
  await db.insert(schema.taxRates).values({ id: 'txr_21', entityId: ENTITY, jurisdictionCode: 'NL', name: 'BTW Hoog 21%', rate: '21.0000', type: 'both' });
  await db.insert(schema.accountingDimensionValues).values({ id: 'dim_hq', entityId: ENTITY, dimension: 'location', name: 'HQ' });
  await db.insert(schema.fiscalPeriods).values({ id: 'fp_jan', entityId: ENTITY, name: '2026-01', type: 'month', startDate: '2026-01-01', endDate: '2026-01-31', status: 'closed' });
}, 60_000);

describe('a manual entry from draft to reversal', () => {
  let id: string;

  it('creates a draft with its lines', async () => {
    const res = await call('', { method: 'POST', body: draft({ lines: [...draft().lines.slice(0, 1), { accountId: 'acc_bank', credit: '121.00', locationId: 'dim_hq', sortOrder: 5 }] }) });
    expect(res.status).toBe(201);
    id = res.data.id;
    expect(res.data.entryNumber).toBe('JE-0001');
    expect(res.data.lines).toHaveLength(2);
    expect(res.data.lines[0]).toMatchObject({ accountId: 'acc_rent', debit: '121.00', credit: '0', taxRateId: 'txr_21', currency: 'EUR', sortOrder: 0 });
    expect(res.data.lines[1]).toMatchObject({ credit: '121.00', locationId: 'dim_hq', sortOrder: 5 });
  });

  it('lists and reads it', async () => {
    const all = await call('');
    expect(all.status).toBe(200);
    expect(all.data.map((e: { id: string }) => e.id)).toContain(id);
    expect(all.pagination).toMatchObject({ hasMore: false, cursor: null });
    const filtered = await call('?status=draft&sourceType=manual&from=2026-03-01&to=2026-03-31&page=1&pageSize=10');
    expect(filtered.data.map((e: { id: string }) => e.id)).toEqual([id]);
    const one = await call(`/${id}`);
    expect(one.status).toBe(200);
    expect(one.data).toMatchObject({ id, status: 'draft', totalDebit: '121.00', description: 'Office rent' });
    expect(one.data.lines.map((l: { accountId: string }) => l.accountId)).toEqual(['acc_rent', 'acc_bank']);
  });

  it('edits the draft header', async () => {
    const res = await call(`/${id}`, { method: 'PATCH', body: { description: 'Office rent (March)', reference: 'R-2', date: '2026-03-11' } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id });
    expect((await call(`/${id}`)).data).toMatchObject({ description: 'Office rent (March)', reference: 'R-2', date: '2026-03-11T00:00:00.000Z' });
  });

  it('posts it: balances and tax-ledger rows', async () => {
    const res = await call(`/${id}/post`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id, status: 'posted' });
    const [rent] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, 'acc_rent'));
    expect(rent?.currentBalance).toBe('121.00');
    const tax = await db.select().from(schema.taxLines).where(eq(schema.taxLines.journalEntryId, id));
    expect(tax).toHaveLength(1);
    expect(tax[0]).toMatchObject({ direction: 'purchase', taxableAmount: '100.00', taxAmount: '21.00' });
  });

  it('refuses to edit, post again or delete a posted entry', async () => {
    expect((await call(`/${id}`, { method: 'PATCH', body: { description: 'x' } })).status).toBe(400);
    const again = await call(`/${id}/post`, { method: 'POST' });
    expect(again.status).toBe(400);
    expect(again.error?.message).toBe('Can only post draft journal entries');
    expect((await call(`/${id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it('reverses it once', async () => {
    const res = await call(`/${id}/reverse`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.data.entryNumber).toBe('JE-0002');
    expect((await call(`/${id}`)).data.status).toBe('reversed');
    const twice = await call(`/${id}/reverse`, { method: 'POST' });
    expect(twice.status).toBe(400);
    expect(twice.error?.message).toBe('This journal entry has already been reversed');
  });
});

describe('refusals', () => {
  it('an unbalanced entry, too few lines, a bad body', async () => {
    const unbalanced = await call('', { method: 'POST', body: draft({ lines: [{ accountId: 'acc_rent', debit: '10' }, { accountId: 'acc_bank', credit: '9' }] }) });
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.error?.message).toBe('Journal entry is not balanced. Total debit: 10.00, total credit: 9.00');
    expect((await call('', { method: 'POST', body: draft({ lines: [{ accountId: 'acc_rent', debit: '10' }] }) })).status).toBe(400);
    expect((await call('', { method: 'POST', body: { lines: 'no' } })).status).toBe(400);
  });

  it('a date in a closed period or on a lock date', async () => {
    const closed = await call('', { method: 'POST', body: draft({ date: '2026-01-15' }) });
    expect(closed.status).toBe(400);
    expect(closed.error?.message).toContain("Fiscal period '2026-01' is closed");
    const locked = await call('', { method: 'POST', entity: 'ent_other', body: draft({ date: '2026-01-10', lines: [{ accountId: 'acc_foreign', debit: '5' }, { accountId: 'acc_foreign', credit: '5' }] }) });
    expect(locked.status).toBe(400);
    expect(locked.error?.message).toContain('The books are locked up to and including 2026-01-31');
  });

  it('a dimension of another entity, and an account of another entity when posting', async () => {
    const dim = await call('', { method: 'POST', body: draft({ lines: [{ accountId: 'acc_rent', debit: '5', classId: 'dim_missing' }, { accountId: 'acc_bank', credit: '5' }] }) });
    expect(dim.status).toBe(400);
    expect(dim.error?.message).toBe('Class dim_missing does not exist in this accounting entity');
    const created = await call('', { method: 'POST', body: draft({ lines: [{ accountId: 'acc_rent', debit: '5' }, { accountId: 'acc_foreign', credit: '5' }] }) });
    expect(created.status).toBe(201);
    const posted = await call(`/${created.data.id}/post`, { method: 'POST' });
    expect(posted.status).toBe(400);
    expect(posted.error?.message).toBe('Account acc_foreign does not belong to this accounting entity');
    expect((await call(`/${created.data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/${created.data.id}`)).status).toBe(404);
  });

  it('no entity, unknown ids, a document entry, and missing permissions', async () => {
    expect((await call('', { entity: null })).status).toBe(400);
    expect((await call('', { method: 'POST', entity: null, body: draft() })).status).toBe(400);
    expect((await call('/je_missing')).status).toBe(404);
    expect((await call('/je_missing', { method: 'PATCH', body: { description: 'x' } })).status).toBe(404);
    expect((await call('/je_missing/post', { method: 'POST' })).status).toBe(404);
    expect((await call('/je_missing/reverse', { method: 'POST' })).status).toBe(404);
    expect((await call('/je_missing', { method: 'DELETE' })).status).toBe(404);

    await db.insert(schema.journalEntries).values({
      id: 'je_invoice', entityId: ENTITY, entryNumber: 'JE-9001', date: new Date('2026-03-01'), status: 'posted',
      sourceType: 'invoice', sourceId: 'inv_1', isAutomatic: true,
    });
    const doc = await call('/je_invoice/reverse', { method: 'POST' });
    expect(doc.status).toBe(400);
    expect(doc.error?.message).toBe('This entry was posted by a invoice. Correct it through that document instead.');

    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await call('', { method: 'POST', perms: ['journal:read'], body: draft() })).status).toBe(403);
    expect((await call('/je_invoice', { method: 'PATCH', perms: ['journal:read'], body: {} })).status).toBe(403);
    expect((await call('/je_invoice', { method: 'DELETE', perms: ['journal:read'] })).status).toBe(403);
  });
});

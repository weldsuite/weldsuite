/**
 * Base currency, jurisdiction and fiscal-year start freeze once the books rest
 * on them: posted documents or entries, payments, filed VAT returns, or
 * generated fiscal periods (TASK-1122).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { accountingEntitiesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function request(path: string, init?: { method?: string; body?: unknown }) {
  const { request: send } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: { permissions: permissions('entities:read', 'entities:create', 'entities:update'), tenantDb: db },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function createEntity(name: string): Promise<string> {
  const res = await request('/api/accounting-entities', {
    method: 'POST',
    body: { name, jurisdictionCode: 'NL', seedDefaults: false },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

const patch = (id: string, body: Record<string, unknown>) =>
  request(`/api/accounting-entities/${id}`, { method: 'PATCH', body });

async function getEntity(id: string) {
  const res = await request(`/api/accounting-entities/${id}`);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string; details?: { code?: string; fields?: string[] } } }).error;
}

async function postInvoice(entityId: string, status: string) {
  await db.insert(schema.invoices).values({
    id: generateId('inv'),
    entityId,
    contactId: 'acn_lock',
    status,
    issueDate: new Date('2026-01-10'),
    dueDate: new Date('2026-02-10'),
  });
}

describe('entity settings that freeze once the books rest on them', () => {
  it('a fresh entity can still change its base currency, jurisdiction and fiscal year start', async () => {
    const id = await createEntity('Fresh BV');
    const before = await getEntity(id);
    expect(before).toMatchObject({ hasPostings: false, hasFiscalPeriods: false, baseSettingsLocked: false, fiscalYearLocked: false });

    const res = await patch(id, { baseCurrency: 'GBP', fiscalYearStart: 7 });
    expect(res.status).toBe(200);
    expect(await getEntity(id)).toMatchObject({ baseCurrency: 'GBP', fiscalYearStart: 7 });
  });

  it('a draft invoice does not lock anything', async () => {
    const id = await createEntity('Draft BV');
    await postInvoice(id, 'draft');
    const res = await patch(id, { baseCurrency: 'USD' });
    expect(res.status).toBe(200);
    expect((await getEntity(id)).hasPostings).toBe(false);
  });

  it('refuses a new base currency or jurisdiction once a document is issued', async () => {
    const id = await createEntity('Issued BV');
    await postInvoice(id, 'sent');

    const entity = await getEntity(id);
    expect(entity).toMatchObject({ hasPostings: true, baseSettingsLocked: true, fiscalYearLocked: true });

    const currency = await patch(id, { baseCurrency: 'USD' });
    expect(currency.status).toBe(409);
    const currencyError = await errorOf(currency);
    expect(currencyError.message).toMatch(/base currency/);
    expect(currencyError.details).toMatchObject({ code: 'ENTITY_HAS_POSTINGS', fields: ['baseCurrency'] });

    const jurisdiction = await patch(id, { jurisdictionCode: 'US' });
    expect(jurisdiction.status).toBe(409);
    expect((await errorOf(jurisdiction)).details?.fields).toEqual(['jurisdictionCode']);

    const both = await patch(id, { baseCurrency: 'USD', jurisdictionCode: 'US' });
    expect(both.status).toBe(409);
    expect((await errorOf(both)).message).toMatch(/base currency and jurisdiction/);

    expect((await getEntity(id)).baseCurrency).toBe('EUR');
  });

  it('sending the unchanged values is not a change', async () => {
    const id = await createEntity('Same BV');
    await postInvoice(id, 'paid');
    const res = await patch(id, { name: 'Same BV renamed', baseCurrency: 'EUR', jurisdictionCode: 'nl', fiscalYearStart: 1 });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { name: string } }).data.name).toBe('Same BV renamed');
  });

  it('refuses a new fiscal year start once there are postings', async () => {
    const id = await createEntity('Fiscal BV');
    await db.insert(schema.journalEntries).values({
      id: generateId('je'),
      entityId: id,
      date: new Date('2026-03-01'),
      status: 'posted',
    });

    const res = await patch(id, { fiscalYearStart: 7 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details).toMatchObject({ code: 'ENTITY_HAS_POSTINGS', fields: ['fiscalYearStart'] });
    expect((await getEntity(id)).fiscalYearStart).toBe(1);
  });

  it('generated fiscal periods lock the fiscal year start, but not the currency', async () => {
    const id = await createEntity('Periods BV');
    await db.insert(schema.fiscalPeriods).values({
      id: generateId('fp'),
      entityId: id,
      name: '2026-01',
      type: 'month',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });

    const entity = await getEntity(id);
    expect(entity).toMatchObject({ hasPostings: false, hasFiscalPeriods: true, baseSettingsLocked: false, fiscalYearLocked: true });

    const res = await patch(id, { fiscalYearStart: 4 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details).toMatchObject({ code: 'ENTITY_HAS_FISCAL_PERIODS' });

    expect((await patch(id, { baseCurrency: 'USD' })).status).toBe(200);
  });

  it('a recorded payment or a filed VAT return counts as posted', async () => {
    const paid = await createEntity('Payment BV');
    await db.insert(schema.payments).values({
      id: generateId('pay'),
      entityId: paid,
      type: 'received',
      amount: '10.00',
      date: new Date('2026-02-01'),
      contactId: 'acn_lock',
    });
    expect((await patch(paid, { baseCurrency: 'USD' })).status).toBe(409);

    const filed = await createEntity('Vat BV');
    await db.insert(schema.vatReturns).values({
      id: generateId('vat'),
      entityId: filed,
      periodType: 'quarter',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-03-31'),
      status: 'filed',
    });
    expect((await patch(filed, { baseCurrency: 'USD' })).status).toBe(409);
  });
});

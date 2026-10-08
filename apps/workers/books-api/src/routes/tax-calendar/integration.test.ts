/**
 * The tax due-date calendar (pglite): deadlines of a US entity from its form,
 * payroll, 1099 vendors and agencies, completion marks, sales tax deadlines
 * done by a filed return, and the answer for an entity outside the US.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { taxCalendarRoutes } from './index';
import { addAgency, callRoute, createUsFixture, type UsFixture } from '../../services/sales-tax-returns/test-fixtures';

let db: Database;
let f: UsFixture;
let nlEntityId: string;

const calendar = (path: string, opts: Parameters<typeof callRoute>[4] = {}) =>
  callRoute(db, '/api/tax-calendar', taxCalendarRoutes, `/api/tax-calendar${path}`, { entityId: f.entityId, ...opts });

function itemsOf(res: Awaited<ReturnType<typeof calendar>>) {
  return Object.fromEntries((res.data.items as Array<Record<string, any>>).map((i) => [i.key, i]));
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  db = (await createPgliteDb()).db;
  f = await createUsFixture(db);
  await addAgency(f, { id: 'agy_tx', stateCode: 'TX', name: 'Texas Comptroller', firstPeriodStart: '2026-07-01' });

  const nl = await callRoute(db, '/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: {
      name: 'Ledger BV',
      jurisdictionCode: 'NL',
      vatNumber: 'NL123456789B01',
      taxIdentifiers: { registrationNumber: '12345678' },
      bankDetails: { iban: 'NL91ABNA0417164300' },
    },
  });
  nlEntityId = nl.data.id;
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('GET /api/tax-calendar', () => {
  it('lists the income tax, estimated tax and sales tax deadlines of the year', async () => {
    const res = await calendar('?year=2026');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ supported: true, year: 2026, today: '2026-10-08', form: 'sch_c' });
    expect(res.data.facts).toEqual({ hasPayroll: false, files1099: false, hasBackupWithholding: false, agencies: 1 });

    const items = itemsOf(res);
    // the single-member LLC files Schedule C: 15 April, extended to 15 October
    expect(items['sch_c:2025']).toMatchObject({ dueDate: '2026-04-15', kind: 'income_tax_return', completed: false, overdue: true });
    expect(items['sch_c:2025:extended']).toMatchObject({ dueDate: '2026-10-15', daysUntilDue: 7, overdue: false, extensionForm: 'Form 4868' });
    expect(items['1040es:2026:q3']).toMatchObject({ dueDate: '2026-09-15', overdue: true });
    // no 1099 vendors and no payroll: no such deadlines
    expect(Object.keys(items).some((k) => k.startsWith('1099_') || k.startsWith('941:'))).toBe(false);
    // the Texas return of the third quarter, due 20 October; its return does not exist yet
    expect(items['sales_tax:agy_tx:2026-09-30']).toMatchObject({
      kind: 'sales_tax', dueDate: '2026-10-20', agencyId: 'agy_tx', stateCode: 'TX', completed: false, returnId: null, daysUntilDue: 12,
    });
    // sorted by due date
    const dates = (res.data.items as Array<Record<string, any>>).map((i) => i.dueDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('adds 1099 and payroll deadlines when the entity has 1099 vendors and payroll', async () => {
    await db.insert(schema.parties).values({ id: 'pty_vendor', displayName: 'Contractor Co', role: 'supplier', is1099Vendor: true });
    await db.insert(schema.payrollImports).values({
      id: 'pri_1', entityId: f.entityId, source: 'csv', payDate: '2026-09-30', summary: { gross_wages: 1000 }, status: 'posted',
    });
    const res = await calendar('?year=2026');
    expect(res.data.facts).toMatchObject({ hasPayroll: true, files1099: true });
    const items = itemsOf(res);
    // 31 January 2026 is a Saturday
    expect(items['1099_nec_recipient:2025']).toMatchObject({ dueDate: '2026-02-02', kind: 'information_return', overdue: true });
    // payroll items are informational: never overdue
    expect(items['941:2026:q3']).toMatchObject({ informational: true, kind: 'payroll', overdue: false });
    expect(items['941:2026:q3'].dueDate < '2026-10-08').toBe(false);
  });

  it('marks a deadline done and takes the mark off again', async () => {
    const done = await calendar('/complete', {
      method: 'POST',
      body: { deadlineKey: '1040es:2026:q3', dueDate: '2026-09-15', notes: 'Paid online' },
      userId: 'user_owner',
    });
    expect(done.status).toBe(201);
    expect(done.data).toMatchObject({ deadlineKey: '1040es:2026:q3', dueDate: '2026-09-15', completedBy: 'user_owner', notes: 'Paid online' });

    const marked = itemsOf(await calendar('?year=2026'))['1040es:2026:q3'];
    expect(marked).toMatchObject({ completed: true, completionSource: 'manual', completedBy: 'user_owner', completionNotes: 'Paid online', overdue: false });

    // marking twice updates the note
    const again = await calendar('/complete', { method: 'POST', body: { deadlineKey: '1040es:2026:q3', dueDate: '2026-09-15', notes: 'Paid by check' } });
    expect(again.status).toBe(201);
    const rows = await db.select().from(schema.taxCalendarCompletions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toBe('Paid by check');

    expect((await calendar('/complete/1040es:2026:q3', { method: 'DELETE' })).status).toBe(204);
    expect(itemsOf(await calendar('?year=2026'))['1040es:2026:q3']).toMatchObject({ completed: false, overdue: true });
    expect((await calendar('/complete/1040es:2026:q3', { method: 'DELETE' })).status).toBe(404);
    expect((await calendar('/complete', { method: 'POST', body: { deadlineKey: 'bad key!', dueDate: '2026-09-15' } })).status).toBe(400);
  });

  it('a sales tax deadline is done when its return is filed', async () => {
    await db.insert(schema.taxReturns).values({
      id: 'txr_q3', entityId: f.entityId, jurisdictionCode: 'US', agencyId: 'agy_tx', stateCode: 'TX',
      periodStart: '2026-07-01', periodEnd: '2026-09-30', dueDate: '2026-10-20', status: 'calculated',
    });
    expect(itemsOf(await calendar('?year=2026'))['sales_tax:agy_tx:2026-09-30']).toMatchObject({
      completed: false, returnId: 'txr_q3', returnStatus: 'calculated',
    });

    await db.update(schema.taxReturns).set({ status: 'filed', filedAt: new Date('2026-10-07T12:00:00Z'), filedBy: 'user_filer' });
    expect(itemsOf(await calendar('?year=2026'))['sales_tax:agy_tx:2026-09-30']).toMatchObject({
      completed: true, completionSource: 'return', returnStatus: 'filed', completedBy: 'user_filer', overdue: false,
    });
  });

  it('answers supported: false and no deadlines for an entity outside the US', async () => {
    const res = await calendar('?year=2026', { entityId: nlEntityId });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ supported: false, year: 2026, form: null, items: [] });
    expect(res.data.message).toContain('US filings only');
    const complete = await calendar('/complete', { entityId: nlEntityId, method: 'POST', body: { deadlineKey: 'x:1', dueDate: '2026-09-15' } });
    expect(complete.status).toBe(400);
  });

  it('checks the year and the permissions', async () => {
    expect((await calendar('?year=1999')).status).toBe(400);
    expect((await calendar('?year=2026', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await calendar('/complete', { method: 'POST', body: { deadlineKey: 'a:1', dueDate: '2026-09-15' }, perms: ['taxes:read'] })).status).toBe(403);
    expect((await calendar('/complete/a:1', { method: 'DELETE', perms: ['taxes:read'] })).status).toBe(403);
  });
});

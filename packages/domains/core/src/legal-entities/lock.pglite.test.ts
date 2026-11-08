/**
 * Core updates may not change the fields an app's history rests on: the
 * country, base currency and fiscal year of an entity WeldBooks has posted
 * for, or the country and currency of an entity WeldHR has paid salaries
 * under. Mirrors the lock WeldBooks applies to its own PATCH.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { updateLegalEntity } from './service';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.legalEntities).values([
    { id: 'ent_books', name: 'Books BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', fiscalYearStart: 1 },
    { id: 'ent_periods', name: 'Periods BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', fiscalYearStart: 1 },
    { id: 'ent_hr', name: 'Payroll BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    { id: 'ent_off', name: 'No books BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
  ]);
  await db.insert(schema.accountingEntitySettings).values([{ entityId: 'ent_books' }, { entityId: 'ent_periods' }]);
  await db.insert(schema.journalEntries).values({ id: 'je_1', entityId: 'ent_books', date: new Date('2026-01-15'), status: 'posted' });
  await db.insert(schema.fiscalPeriods).values({
    id: 'fp_1',
    entityId: 'ent_periods',
    name: '2026',
    type: 'year',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  // A posted journal entry on an entity WeldBooks is not enabled for does not lock it.
  await db.insert(schema.journalEntries).values({ id: 'je_2', entityId: 'ent_off', date: new Date('2026-01-15'), status: 'posted' });
  await db.insert(schema.hrPayrollEmployers).values({
    id: 'emp_1',
    name: 'Payroll BV',
    legalName: 'Payroll BV',
    country: 'NL',
    currency: 'EUR',
    legalEntityId: 'ent_hr',
  });
  await db.insert(schema.hrPayRuns).values({
    id: 'run_1',
    employerId: 'emp_1',
    country: 'NL',
    currency: 'EUR',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    payDate: '2026-01-25',
    taxYear: 2026,
    periodNumber: 1,
  });
}, 120_000);

describe('updateLegalEntity lock', () => {
  it('refuses a new country or currency once WeldBooks has postings', async () => {
    await expect(updateLegalEntity(db, 'ent_books', { jurisdictionCode: 'BE' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateLegalEntity(db, 'ent_books', { baseCurrency: 'USD' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateLegalEntity(db, 'ent_books', { fiscalYearStart: 4 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows the same value in another case, and every other field', async () => {
    await expect(updateLegalEntity(db, 'ent_books', { jurisdictionCode: 'nl', name: 'Books B.V.' })).resolves.toMatchObject({
      name: 'Books B.V.',
    });
  });

  it('freezes the fiscal year once fiscal periods exist, but not the country', async () => {
    await expect(updateLegalEntity(db, 'ent_periods', { fiscalYearStart: 7 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateLegalEntity(db, 'ent_periods', { baseCurrency: 'USD' })).resolves.toMatchObject({ baseCurrency: 'USD' });
  });

  it('refuses a new country or currency once WeldHR has pay runs', async () => {
    await expect(updateLegalEntity(db, 'ent_hr', { baseCurrency: 'USD' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateLegalEntity(db, 'ent_hr', { fiscalYearStart: 4 })).resolves.toMatchObject({ fiscalYearStart: 4 });
  });

  it('ignores data of an app that is not enabled for the entity', async () => {
    await expect(updateLegalEntity(db, 'ent_off', { jurisdictionCode: 'BE' })).resolves.toMatchObject({ jurisdictionCode: 'BE' });
  });
});

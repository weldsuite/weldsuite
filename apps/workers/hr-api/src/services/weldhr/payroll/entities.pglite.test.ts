/**
 * The WeldBooks journal belongs to the employer's legal entity: without
 * WeldBooks enabled for it the journal is skipped, with a reason.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import { nlWorld, testDeps, type NlWorld } from '../../../test/payroll-fixtures';
import { approveRun } from './approve';
import { calculateRun } from './calculate';
import { loadEmployerForPayroll } from './employer-context';
import { createRun, getRunDetail } from './runs';

let db: Database;
let world: NlWorld;
const prep = { userId: 'user_prep' };
const boss = { userId: 'user_boss' };

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
  await db.delete(schema.legalEntityRegistrations);
  await db.delete(schema.legalEntities);
  world = await nlWorld(db);
});

async function approvedRun() {
  const { deps, booksCalls } = testDeps();
  const run = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' }, prep);
  await calculateRun(db, run.id, deps, prep);
  const result = await approveRun(db, run.id, deps, boss);
  return { run, result, booksCalls };
}

describe('the journal of a run of a legal entity', () => {
  it('is skipped with books_not_enabled when WeldBooks is not enabled for the entity', async () => {
    await db.insert(schema.legalEntities).values({ id: 'ent_hr_only', name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
    await db.update(schema.hrPayrollEmployers).set({ legalEntityId: 'ent_hr_only' }).where(eq(schema.hrPayrollEmployers.id, world.employerId));

    const { run, result, booksCalls } = await approvedRun();
    expect(result.journal).toMatchObject({ status: 'skipped' });
    expect(booksCalls).toHaveLength(0);
    expect(await getRunDetail(db, run.id, boss)).toMatchObject({ journalStatus: 'skipped', journalReason: 'books_not_enabled', journalError: null });
  });

  it('posts to the legal entity when WeldBooks is enabled for it', async () => {
    await db.insert(schema.legalEntities).values({ id: 'ent_with_books', name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
    await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_with_books' });
    await db.update(schema.hrPayrollEmployers).set({ legalEntityId: 'ent_with_books' }).where(eq(schema.hrPayrollEmployers.id, world.employerId));

    const { booksCalls } = await approvedRun();
    expect(booksCalls.map((c) => c.input.entityId)).toEqual(['ent_with_books']);
  });
});

describe('loadEmployerForPayroll', () => {
  it('merges the entity and registration, and falls back to the copied columns without a link', async () => {
    const unlinked = await loadEmployerForPayroll(db, world.employerId);
    expect(unlinked).toMatchObject({ name: 'Acme BV', legalName: 'Acme B.V.', country: 'NL' });
    expect(unlinked.nlSettings.loonheffingennummer).toBe('123456789L01');

    await db.insert(schema.legalEntities).values({ id: 'ent_m', name: 'Merged', legalName: 'Merged B.V.', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
    await db.insert(schema.legalEntityRegistrations).values({ id: 'ler_m', entityId: 'ent_m', type: 'nl_payroll_tax', number: '999999999L02', isPrimary: true });
    await db
      .update(schema.hrPayrollEmployers)
      .set({ legalEntityId: 'ent_m', registrationId: 'ler_m' })
      .where(eq(schema.hrPayrollEmployers.id, world.employerId));
    const linked = await loadEmployerForPayroll(db, world.employerId);
    expect(linked).toMatchObject({ name: 'Merged', legalName: 'Merged B.V.' });
    expect(linked.nlSettings.loonheffingennummer).toBe('999999999L02');
    // The deprecated columns are left alone by a read.
    expect(linked.nlSettings.sectorCode).toBe(52);
  });
});

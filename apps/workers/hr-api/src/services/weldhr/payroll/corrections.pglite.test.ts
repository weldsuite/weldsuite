/**
 * Correction runs store the difference between the recalculated payslip and
 * the payslip as it stands (the original plus the corrections already approved).
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import { nlWorld, testDeps, type NlWorld } from '../../../test/payroll-fixtures';
import { HrConflictError, HrValidationError } from '../shared';
import { approveRun } from './approve';
import { calculateRun } from './calculate';
import { combineNumeric, diffLines, diffNumeric, sumLines } from './corrections';
import { buildPaymentFile } from './files';
import { payslipPdf } from './payslips';
import { collectRunInputs, createRun, createRunInput, deleteRunInput, getRunDetail, listRunInputs, updateRunInput } from './runs';

let db: Database;
let world: NlWorld;
const prep = { userId: 'user_prep' };
const boss = { userId: 'user_boss' };

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
  world = await nlWorld(db);
});

async function approvedJuly(deps = testDeps().deps) {
  const run = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' }, prep);
  await calculateRun(db, run.id, deps, prep);
  await approveRun(db, run.id, deps, boss);
  return run;
}

const correct = (runId: string, extra: Record<string, unknown> = {}) =>
  createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: runId, employeeIds: [world.eva.id], payDate: '2026-08-05', ...extra } as never, prep);

describe('correction run', () => {
  it('copies the corrected run\'s period and stores only the difference', async () => {
    const { deps } = testDeps();
    const july = await approvedJuly(deps);
    const run = await correct(july.id);
    expect(run).toMatchObject({ kind: 'correction', correctsRunId: july.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-08-05', taxYear: 2026, periodNumber: 7, status: 'draft', employeeCount: 1 });
    expect(run.includedEmployeeIds).toEqual([world.eva.id]);

    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    const calculated = await calculateRun(db, run.id, deps, prep);
    // The fake engine: +100 gross, 20% tax, 10% employer premium.
    expect(calculated.totals).toEqual({ grossCents: 10_000, netCents: 8_000, employeeTaxesCents: 2_000, employeeDeductionsCents: 0, employerTaxesCents: 1_000, reimbursementsCents: 0, employerCostCents: 11_000 });

    const [original] = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, july.id)).then((rows) => rows.filter((r) => r.employeeId === world.eva.id));
    const [delta] = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id));
    expect(delta).toMatchObject({ status: 'draft', correctsPayslipId: original!.id, grossPay: '100.00', netPay: '80.00', employeeTaxes: '20.00', taxYear: 2026, periodStart: '2026-07-01', payDate: '2026-08-05' });
    // Unchanged lines (the salary) drop out; changed ones carry the difference.
    expect(delta!.lines.map((l) => [l.code, l.amountCents])).toEqual([['bonus', 10_000], ['wage_tax', -2_000], ['employer_premium', 1_000]]);
    expect((delta!.filingData as { amounts: { loonLbPh: number; wageTax: number } }).amounts).toMatchObject({ loonLbPh: 10_000, wageTax: 2_000 });
    // Year to date: the chain tip plus the difference.
    expect(delta!.ytd['gross']).toBe(310_000);
    expect((delta!.snapshot as { ytdDelta: Record<string, number> }).ytdDelta['gross']).toBe(10_000);
  });

  it('approves into a numbered final payslip, leaves the original alone, and is not billed', async () => {
    const { deps, meterCalls } = testDeps();
    const july = await approvedJuly(deps);
    const run = await correct(july.id);
    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, run.id, deps, prep);
    const result = await approveRun(db, run.id, deps, boss);
    expect(result.payslips.map((p) => p.number)).toEqual(['2026-0003']);
    const slips = (await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.eva.id))).sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''));
    expect(slips.map((s) => [s.number, s.status, s.grossPay, s.correctsPayslipId === null ? 'original' : 'correction'])).toEqual([
      ['2026-0001', 'final', '3000.00', 'original'],
      ['2026-0003', 'final', '100.00', 'correction'],
    ]);
    expect(meterCalls).toHaveLength(1);
    // The correction's PDF says what it is.
    expect(new TextDecoder().decode((await payslipPdf(db, slips[1]!, deps)).slice(0, 5))).toBe('%PDF-');
  });

  it('starts a second correction from the first one\'s inputs and corrects against the corrected payslip', async () => {
    const { deps } = testDeps();
    const july = await approvedJuly(deps);
    const first = await correct(july.id);
    await createRunInput(db, first.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, first.id, deps, prep);
    await approveRun(db, first.id, deps, boss);

    const second = await correct(july.id, { payDate: '2026-08-20' });
    const copied = await listRunInputs(db, second.id);
    expect(copied.map((i) => [i.code, i.amount])).toEqual([['bonus', '100.00']]);
    // The bonus was really 150: raise the copy by 50.
    await updateRunInput(db, second.id, copied[0]!.id, { amount: 150 });
    const calculated = await calculateRun(db, second.id, deps, prep);
    expect(calculated.totals).toMatchObject({ grossCents: 5_000, netCents: 4_000, employeeTaxesCents: 1_000 });
    await approveRun(db, second.id, deps, boss);

    // Every final payslip of the employee adds up to the corrected one.
    const all = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.eva.id));
    const gross = all.reduce((n, s) => n + Number(s.grossPay), 0);
    const net = all.reduce((n, s) => n + Number(s.netPay), 0);
    expect(gross).toBe(3150);
    expect(net).toBe(2520);
    const tip = all.sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '')).at(-1)!;
    expect(tip.ytd['gross']).toBe(315_000);
  });

  it('can correct downwards: a negative difference, a signed journal, nothing to pay', async () => {
    await resetPayrollTables(db);
    await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Acme Books', jurisdictionCode: 'NL' });
    world = await nlWorld(db, { accountingEntityId: 'ent_nl' });
    const { deps, booksCalls } = testDeps();
    const july = await approvedJuly(deps);
    const run = await correct(july.id);
    // An overlooked net deduction of 50: net pay goes down, gross stays.
    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'deduction.net', amount: 50 }, prep);
    await calculateRun(db, run.id, deps, prep);
    const result = await approveRun(db, run.id, deps, boss);
    expect(result.run.totals).toMatchObject({ grossCents: 0, netCents: -5_000, employeeDeductionsCents: 5_000 });

    const corrections = booksCalls.filter((c) => c.input.description.startsWith('Payroll correction'));
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.input.totals).toEqual({ grossWages: 0, employerTaxes: 0, employerBenefits: 0, reimbursements: 0, employeeTaxes: 0, employeeDeductions: 50, netPay: -50 });
    await expect(buildPaymentFile(db, run.id, deps)).rejects.toMatchObject({ code: 'NOTHING_TO_PAY' });
  });

  it('only corrects approved runs, people with a payslip in them, and one open correction at a time', async () => {
    const { deps } = testDeps();
    const draft = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-06-01' }, prep);
    await expect(correct(draft.id)).rejects.toBeInstanceOf(HrConflictError);

    const july = await approvedJuly(deps);
    await db.insert(schema.hrEmployees).values({ id: 'hremp_x', firstName: 'X', lastName: 'Y', email: 'x@example.com', status: 'active' });
    await expect(correct(july.id, { employeeIds: ['hremp_x'] })).rejects.toBeInstanceOf(HrValidationError);

    const first = await correct(july.id);
    await expect(correct(july.id)).rejects.toBeInstanceOf(HrConflictError);
    // Corrections of a correction go to the original run.
    await calculateRun(db, first.id, deps, prep);
    await approveRun(db, first.id, deps, boss);
    await expect(correct(first.id)).rejects.toBeInstanceOf(HrValidationError);
    // Collecting would pull in new pay, which is not what a correction does.
    const open = await correct(july.id);
    await expect(collectRunInputs(db, open.id, deps.keyring, prep)).rejects.toBeInstanceOf(HrConflictError);
  });

  it('defaults to every employee paid in the run', async () => {
    const { deps } = testDeps();
    const july = await approvedJuly(deps);
    const run = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, payDate: '2026-08-05' }, prep);
    expect(run.employeeCount).toBe(2);
    const detail = await getRunDetail(db, run.id, boss);
    expect(detail.employees.map((e) => e.displayName)).toEqual(['Eva Alder', 'Hans Berg']);
    await createRunInput(db, run.id, { employeeId: world.hans.id, code: 'hours.regular', quantity: 10 }, prep).then((input) => deleteRunInput(db, run.id, input.id));
  });
});

describe('difference arithmetic', () => {
  it('sums and subtracts lines by section, code and jurisdiction', () => {
    const a = [{ code: 'x', section: 'earning' as const, labelKey: 'x', amountCents: 100 }, { code: 'y', section: 'tax' as const, labelKey: 'y', amountCents: -30, jurisdiction: 'CA' }];
    const b = [{ code: 'x', section: 'earning' as const, labelKey: 'x', amountCents: 40 }, { code: 'z', section: 'earning' as const, labelKey: 'z', amountCents: 5 }];
    expect(sumLines([a, b]).map((l) => [l.code, l.amountCents])).toEqual([['x', 140], ['y', -30], ['z', 5]]);
    expect(diffLines(a, b).map((l) => [l.code, l.amountCents])).toEqual([['x', 60], ['y', -30], ['z', -5]]);
    expect(diffLines(a, a)).toEqual([]);
  });

  it('subtracts numbers nested in filing data and keeps the rest from the new side', () => {
    const after = { kind: 'us', federal: { fitWages: 1000, box12: { D: 50 } }, states: { CA: { stateWages: 900 } }, flag: true };
    const before = { kind: 'us', federal: { fitWages: 800, box12: { D: 50, DD: 10 } }, states: { CA: { stateWages: 900 } }, flag: false };
    expect(diffNumeric(after, before)).toEqual({ kind: 'us', federal: { fitWages: 200, box12: { D: 0, DD: -10 } }, states: { CA: { stateWages: 0 } }, flag: true });
    expect(combineNumeric({ a: 1, b: { c: 2 } }, { a: 2, b: { c: 3 }, d: 4 })).toEqual({ a: 3, b: { c: 5 }, d: 4 });
  });

  it('is exact on the fake engine: recalculating without changes gives a zero difference', async () => {
    const { deps } = testDeps();
    const july = await approvedJuly(deps);
    const run = await correct(july.id);
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.totals).toEqual({ grossCents: 0, netCents: 0, employeeTaxesCents: 0, employeeDeductionsCents: 0, employerTaxesCents: 0, reimbursementsCents: 0, employerCostCents: 0 });
    const [delta] = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id));
    expect(delta!.lines).toEqual([]);
  });
});

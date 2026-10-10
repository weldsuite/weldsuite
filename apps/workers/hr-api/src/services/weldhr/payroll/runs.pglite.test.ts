/**
 * Creating runs, collecting inputs from attendance, leave, absences and
 * declarations, and calculating with an injected fake engine.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import { TEST_KEYRING, createTestEmployee, nlWorld, testDeps, type NlWorld } from '../../../test/payroll-fixtures';
import { HrConflictError, HrValidationError } from '../shared';
import { approveRun } from './approve';
import { calculateRun } from './calculate';
import { setPaymentDetails, upsertProfile } from './employees';
import {
  cancelRun,
  collectRunInputs,
  createRun,
  createRunInput,
  deleteRunInput,
  getRunDetail,
  listRunInputs,
  listRuns,
  setRunEmployee,
  updateRun,
  updateRunInput,
} from './runs';

let db: Database;
let world: NlWorld;
const prep = { userId: 'user_prep' };

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
  world = await nlWorld(db);
});

const julyRun = () =>
  createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' }, prep);

describe('createRun', () => {
  it('uses the schedule\'s next period and counts the people on it', async () => {
    const run = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId }, prep);
    expect(run).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-01-31', payDate: '2026-01-23', taxYear: 2026, periodNumber: 1, status: 'draft', employeeCount: 2, kind: 'regular', preparedBy: 'user_prep' });
  });

  it('allows one live regular run per schedule and period', async () => {
    await julyRun();
    await expect(julyRun()).rejects.toBeInstanceOf(HrConflictError);
    // Cancelling frees the period.
    const [live] = await db.select().from(schema.hrPayRuns);
    await cancelRun(db, live!.id);
    await expect(julyRun()).resolves.toMatchObject({ periodStart: '2026-07-01' });
  });

  it('refuses a start that is not the first day of a pay period', async () => {
    await expect(
      createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-15' }, prep),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('creates an off-cycle run for chosen employees with explicit dates', async () => {
    await expect(
      createRun(db, { employerId: world.employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-20' }, prep),
    ).rejects.toBeInstanceOf(HrValidationError);
    const run = await createRun(
      db,
      { employerId: world.employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-20', employeeIds: [world.eva.id] },
      prep,
    );
    expect(run).toMatchObject({ kind: 'off_cycle', taxYear: 2026, periodNumber: 7, employeeCount: 1, payDate: '2026-07-20' });
    expect(run.includedEmployeeIds).toEqual([world.eva.id]);
    const stranger = await createTestEmployee(db, { firstName: 'Stranger' });
    await expect(
      createRun(db, { employerId: world.employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-20', employeeIds: [stranger.id] }, prep),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('leaves out paused employees and people whose employment ended before the period', async () => {
    await upsertProfile(db, world.hans.id, { employerId: world.employerId, status: 'paused' });
    const run = await julyRun();
    expect(run.employeeCount).toBe(1);
    const detail = await getRunDetail(db, run.id, { userId: 'u' });
    expect(detail.employees.map((e) => e.displayName)).toEqual(['Eva Alder']);

    await upsertProfile(db, world.hans.id, { employerId: world.employerId, status: 'active', endDate: '2026-06-15' });
    const second = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-08-01' }, prep);
    expect(second.employeeCount).toBe(1);
  });

  it('lists runs and filters them', async () => {
    await julyRun();
    expect(await listRuns(db, {})).toHaveLength(1);
    expect(await listRuns(db, { status: 'approved' })).toHaveLength(0);
    expect(await listRuns(db, { year: 2026, employerId: world.employerId })).toHaveLength(1);
  });
});

describe('inputs', () => {
  it('validates the code, the country and what the code needs', async () => {
    const run = await julyRun();
    await expect(createRunInput(db, run.id, { employeeId: world.eva.id, code: 'nope', amount: 1 }, prep)).rejects.toBeInstanceOf(HrValidationError);
    await expect(createRunInput(db, run.id, { employeeId: world.eva.id, code: 'us.tips_cash', amount: 1 }, prep)).rejects.toBeInstanceOf(HrValidationError);
    await expect(createRunInput(db, run.id, { employeeId: world.eva.id, code: 'nl.company_car' as never }, prep)).rejects.toBeInstanceOf(HrValidationError);
    await expect(createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus' }, prep)).rejects.toBeInstanceOf(HrValidationError);
    await expect(createRunInput(db, run.id, { employeeId: world.eva.id, code: 'hours.overtime' }, prep)).rejects.toBeInstanceOf(HrValidationError);
    const stranger = await createTestEmployee(db, { firstName: 'Stranger' });
    await expect(createRunInput(db, run.id, { employeeId: stranger.id, code: 'bonus', amount: 1 }, prep)).rejects.toBeInstanceOf(HrValidationError);

    const bonus = await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 250.5 }, prep);
    expect(bonus).toMatchObject({ code: 'bonus', amount: '250.50', source: 'manual' });
    const hours = await createRunInput(db, run.id, { employeeId: world.hans.id, code: 'hours.overtime', quantity: 3, rate: 125, workDate: '2026-07-04' }, prep);
    expect(hours).toMatchObject({ quantity: '3.0000', rate: '125.0000', workDate: '2026-07-04' });

    const updated = await updateRunInput(db, run.id, bonus.id, { amount: 300 });
    expect(updated.amount).toBe('300.00');
    expect(await listRunInputs(db, run.id, { employeeId: world.eva.id })).toHaveLength(1);
    await deleteRunInput(db, run.id, bonus.id);
    expect(await listRunInputs(db, run.id)).toHaveLength(1);
  });

  it('send a calculated run back to draft when pay changes, and refuse changes once approved', async () => {
    const { deps } = testDeps();
    const run = await julyRun();
    await calculateRun(db, run.id, deps, prep);
    expect((await getRunDetail(db, run.id, { userId: 'u' })).status).toBe('calculated');
    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 10 }, prep);
    expect((await getRunDetail(db, run.id, { userId: 'u' })).status).toBe('draft');

    await calculateRun(db, run.id, deps, prep);
    await setRunEmployee(db, run.id, world.hans.id, true);
    expect((await getRunDetail(db, run.id, { userId: 'u' })).status).toBe('draft');
    await updateRun(db, run.id, { notes: 'July' });

    await calculateRun(db, run.id, deps, prep);
    await approveRun(db, run.id, deps, { userId: 'user_boss' });
    await expect(createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 10 }, prep)).rejects.toBeInstanceOf(HrConflictError);
    await expect(updateRun(db, run.id, { notes: 'x' })).rejects.toBeInstanceOf(HrConflictError);
    await expect(cancelRun(db, run.id)).rejects.toBeInstanceOf(HrConflictError);
  });
});

describe('collectRunInputs', () => {
  async function seedSources() {
    // Attendance for Hans (hourly): two approved days, one unapproved day.
    const day = (date: string, minutes: number, approved: boolean) => ({
      id: `att_${date}`,
      employeeId: world.hans.id,
      date,
      workedMinutes: minutes,
      approvedAt: approved ? new Date() : null,
      approvedBy: approved ? 'user_mgr' : null,
    });
    await db.insert(schema.hrAttendanceRecords).values([day('2026-07-06', 480, true), day('2026-07-07', 450, true), day('2026-07-08', 480, false), day('2026-06-30', 480, true)]);
    // Eva (salaried): unpaid leave Mon-Tue 6-7 July; paid leave is not a payroll input in NL.
    await db.insert(schema.hrLeaveTypes).values([
      { id: 'lt_unpaid', name: 'Unpaid leave', isPaid: false },
      { id: 'lt_annual', name: 'Annual leave', isPaid: true },
    ]);
    await db.insert(schema.hrLeaveRequests).values([
      { id: 'lr_unpaid', employeeId: world.eva.id, leaveTypeId: 'lt_unpaid', startDate: '2026-07-06', endDate: '2026-07-07', days: 2, status: 'approved' },
      { id: 'lr_annual', employeeId: world.eva.id, leaveTypeId: 'lt_annual', startDate: '2026-07-13', endDate: '2026-07-14', days: 2, status: 'approved' },
      { id: 'lr_pending', employeeId: world.eva.id, leaveTypeId: 'lt_unpaid', startDate: '2026-07-20', endDate: '2026-07-20', days: 1, status: 'pending' },
    ]);
    // A sick report: Mon-Tue 20-21 July.
    await db.insert(schema.hrAbsences).values({ id: 'abs_1', employeeId: world.eva.id, startDate: '2026-07-20', endDate: '2026-07-21', firstDay: 'full' });
    // Declarations.
    const declaration = (id: string, status: string, amount: string) => ({ id, employeeId: world.eva.id, expenseDate: '2026-07-10', category: 'travel', description: `Train ${id}`, amount, currency: 'EUR', status });
    await db.insert(schema.hrDeclarations).values([declaration('dcl_ok', 'approved', '45.50'), declaration('dcl_pending', 'pending', '10.00')]);
  }

  it('turns approved hours, unpaid leave, sick days and approved expenses into inputs', async () => {
    await seedSources();
    const run = await julyRun();
    const summary = await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    expect(summary).toEqual({ attendance: 2, leave: 1, absence: 1, declaration: 1 });

    const inputs = await listRunInputs(db, run.id);
    const hans = inputs.filter((i) => i.employeeId === world.hans.id);
    expect(hans.map((i) => [i.code, i.quantity, i.workDate, i.source])).toEqual([
      ['hours.regular', '8.0000', '2026-07-06', 'attendance'],
      ['hours.regular', '7.5000', '2026-07-07', 'attendance'],
    ]);
    const eva = inputs.filter((i) => i.employeeId === world.eva.id);
    expect(eva.find((i) => i.code === 'hours.unpaid_leave')).toMatchObject({ quantity: '16.0000', source: 'leave', sourceRef: 'lr_unpaid' });
    expect(eva.find((i) => i.code === 'nl.sick_pay')).toMatchObject({ quantity: '16.0000', rate: '100.0000', source: 'absence', sourceRef: 'abs_1' });
    expect(eva.find((i) => i.code === 'reimbursement')).toMatchObject({ amount: '45.50', source: 'declaration', sourceRef: 'dcl_ok' });
    // Pending declarations, unapproved attendance, paid leave and other months are not inputs.
    expect(inputs).toHaveLength(5);
  });

  it('replaces what it collected before, keeps manual lines, and does not duplicate an edited line', async () => {
    await seedSources();
    const run = await julyRun();
    await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    const manual = await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    const [reimbursement] = (await listRunInputs(db, run.id)).filter((i) => i.code === 'reimbursement');
    // Editing the amount of a collected line makes it the preparer's own line.
    const edited = await updateRunInput(db, run.id, reimbursement!.id, { amount: 40 });
    expect(edited.source).toBe('manual');

    await db.update(schema.hrAttendanceRecords).set({ workedMinutes: 240 }).where(eq(schema.hrAttendanceRecords.id, 'att_2026-07-06'));
    const summary = await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    expect(summary.declaration).toBe(0);
    const inputs = await listRunInputs(db, run.id);
    expect(inputs.filter((i) => i.code === 'reimbursement')).toHaveLength(1);
    expect(inputs.find((i) => i.id === manual.id)).toBeTruthy();
    expect(inputs.filter((i) => i.employeeId === world.hans.id).map((i) => i.quantity).sort()).toEqual(['4.0000', '7.5000']);
  });

  it('does not collect an expense another open run already pays', async () => {
    await seedSources();
    const first = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' }, prep);
    await collectRunInputs(db, first.id, TEST_KEYRING, prep);
    const second = await createRun(db, { employerId: world.employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-30', employeeIds: [world.eva.id] }, prep);
    const summary = await collectRunInputs(db, second.id, TEST_KEYRING, prep);
    expect(summary.declaration).toBe(0);
    // Cancelling the first run releases it.
    await cancelRun(db, first.id);
    expect((await collectRunInputs(db, second.id, TEST_KEYRING, prep)).declaration).toBe(1);
  });

  it('only collects for people in the run', async () => {
    await seedSources();
    const run = await julyRun();
    await setRunEmployee(db, run.id, world.hans.id, true);
    await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    expect((await listRunInputs(db, run.id)).some((i) => i.employeeId === world.hans.id)).toBe(false);
  });
});

describe('calculateRun', () => {
  it('stores draft payslips with a snapshot, totals and the variance warnings', async () => {
    const { deps } = testDeps();
    const run = await julyRun();
    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 500 }, prep);
    await createRunInput(db, run.id, { employeeId: world.hans.id, code: 'hours.regular', quantity: 100 }, prep);
    const calculated = await calculateRun(db, run.id, deps, { userId: 'user_calc' });

    expect(calculated).toMatchObject({ status: 'calculated', calculatedBy: 'user_calc', employeeCount: 2 });
    // Eva 3000 + 500 bonus = 3500; Hans 100 h x 20 = 2000. Fake engine: 20% tax, 10% employer premium.
    expect(calculated.totals).toEqual({
      grossCents: 550_000,
      netCents: 440_000,
      employeeTaxesCents: 110_000,
      employeeDeductionsCents: 0,
      employerTaxesCents: 55_000,
      reimbursementsCents: 0,
      employerCostCents: 605_000,
    });
    const slips = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id));
    expect(slips).toHaveLength(2);
    const eva = slips.find((s) => s.employeeId === world.eva.id)!;
    expect(eva).toMatchObject({ status: 'draft', number: null, grossPay: '3500.00', netPay: '2800.00', employerCost: '3850.00', taxYear: 2026, periodNumber: 7, correctsPayslipId: null });
    expect(eva.lines.map((l) => l.code)).toEqual(['salary', 'bonus', 'wage_tax', 'employer_premium']);
    const snapshot = eva.snapshot as { input: { country: string; compensation: { amount: number }; inputs: unknown[]; nl: { applyLoonheffingskorting: boolean; anonymous: boolean } }; ruleSet: string };
    expect(snapshot.ruleSet).toBe('fake-1');
    expect(snapshot.input).toMatchObject({ country: 'NL', compensation: { amount: 3000 }, nl: { applyLoonheffingskorting: true, anonymous: false } });
    expect(snapshot.input.inputs).toHaveLength(1);
    // Nobody was paid before: first payslip for both.
    expect(calculated.issues.filter((i) => i.code === 'first_payslip').map((i) => i.employeeId).sort()).toEqual([world.eva.id, world.hans.id].sort());
    expect(calculated.issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('feeds the engine the right facts: compensation, components, elections, YTD, the rates', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { deps } = testDeps({
      engines: { ...testDeps().deps.engines, calculatePayslip: (input) => (seen.push(input as unknown as Record<string, unknown>), testDeps().deps.engines.calculatePayslip(input)) },
    });
    await db.insert(schema.hrPayComponents).values({ id: 'pc_1', employeeId: world.eva.id, code: 'allowance.taxable', amount: '50.00', effectiveFrom: '2026-07-15', params: {} });
    await db.insert(schema.hrPayComponents).values({ id: 'pc_2', employeeId: world.eva.id, code: 'allowance.taxable', amount: '99.00', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', params: {} });
    const run = await julyRun();
    await calculateRun(db, run.id, deps, prep);
    const eva = seen.find((i) => (i.compensation as { payType: string }).payType === 'salary') as {
      period: { start: string; end: string; payDate: string; taxYear: number; periodNumber: number; periodsPerYear: number; frequency: string };
      employee: { dateOfBirth: string; startDate: string };
      components: Array<{ code: string; amountCents: number }>;
      employer: { whkRatePercent: number; sectorCode: number; aofSmallEmployer: boolean; holidayAllowancePercent: number };
      nl: { contractHoursPerWeek: number; previousYearAnnualWageCents: number | null; insuredWw: boolean; writtenContract: boolean };
      ytd: Record<string, number>;
    };
    expect(eva.period).toMatchObject({ start: '2026-07-01', end: '2026-07-31', payDate: '2026-07-24', taxYear: 2026, periodNumber: 7, periodsPerYear: 12, frequency: 'monthly' });
    expect(eva.employee).toMatchObject({ dateOfBirth: '1990-05-17', startDate: '2026-01-01' });
    // Only the component that overlaps July.
    expect(eva.components).toEqual([expect.objectContaining({ code: 'allowance.taxable', amountCents: 5000 })]);
    expect(eva.employer).toMatchObject({ whkRatePercent: 1.16, sectorCode: 52, aofSmallEmployer: true, holidayAllowancePercent: 8 });
    expect(eva.nl).toMatchObject({ contractHoursPerWeek: 40, previousYearAnnualWageCents: null, insuredWw: true, writtenContract: true });
    expect(eva.ytd).toEqual({});
  });

  it('chains year-to-date from the latest final payslip of the year and reads last year\'s wage', async () => {
    const seen: Array<{ ytd: Record<string, number>; nl?: { previousYearAnnualWageCents: number | null } }> = [];
    const base = testDeps();
    const { deps } = testDeps({ engines: { ...base.deps.engines, calculatePayslip: (input) => (seen.push(input as never), base.deps.engines.calculatePayslip(input)) } });
    const june = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-06-01' }, prep);
    await calculateRun(db, june.id, deps, prep);
    await approveRun(db, june.id, deps, { userId: 'user_boss' });
    seen.length = 0;
    const july = await julyRun();
    await calculateRun(db, july.id, deps, prep);
    // The fake engine accumulates gross: Eva 3000 and Hans 0 hours.
    expect(seen.map((i) => i.ytd['gross']).sort()).toEqual([0, 300_000].sort());

    // A previous-year payslip gives the NL special-reward annual wage.
    await db.insert(schema.hrPayRuns).values({ id: 'run_2025', employerId: world.employerId, country: 'NL', currency: 'EUR', periodStart: '2025-12-01', periodEnd: '2025-12-31', payDate: '2025-12-23', taxYear: 2025, periodNumber: 12, status: 'paid' });
    await db.insert(schema.hrPayslips).values({
      id: 'slip_2025',
      runId: 'run_2025',
      employeeId: world.eva.id,
      employerId: world.employerId,
      country: 'NL',
      currency: 'EUR',
      status: 'final',
      number: '2025-0012',
      periodStart: '2025-12-01',
      periodEnd: '2025-12-31',
      payDate: '2025-12-23',
      taxYear: 2025,
      periodNumber: 12,
      ytd: { 'nl.loon_lb': 3_600_000, 'nl.months_employed_x10000': 120_000 },
    });
    seen.length = 0;
    await calculateRun(db, july.id, deps, prep);
    expect(seen.some((i) => i.nl?.previousYearAnnualWageCents === 3_600_000)).toBe(true);
  });

  it('passes the holiday allowance balance of last year and the usual work days to the Dutch engine', async () => {
    const seen: Array<{ compensation: { payType: string; amount: number }; nl?: { holidayAllowanceOpeningBalanceCents: number | null; usualWorkDaysPerWeek: number | null; contractHoursPerWeek: number | null } }> = [];
    const base = testDeps();
    const { deps } = testDeps({ engines: { ...base.deps.engines, calculatePayslip: (input) => (seen.push(input as never), base.deps.engines.calculatePayslip(input)) } });
    const parttime = await createTestEmployee(db, { firstName: 'Piet', lastName: 'Deeltijd', weeklyHours: 32 });
    await upsertProfile(db, parttime.id, { employerId: world.employerId, payScheduleId: world.scheduleId, startDate: '2026-01-01', nl: { writtenContract: true } });
    await db.insert(schema.hrCompensations).values({ id: 'comp_piet', employeeId: parttime.id, effectiveFrom: '2026-01-01', payType: 'salary', amount: '2400', period: 'month', currency: 'EUR' });
    await db.insert(schema.hrPayRuns).values({ id: 'run_2025', employerId: world.employerId, country: 'NL', currency: 'EUR', periodStart: '2025-12-01', periodEnd: '2025-12-31', payDate: '2025-12-23', taxYear: 2025, periodNumber: 12, status: 'paid' });
    await db.insert(schema.hrPayslips).values({
      id: 'slip_2025',
      runId: 'run_2025',
      employeeId: world.eva.id,
      employerId: world.employerId,
      country: 'NL',
      currency: 'EUR',
      status: 'final',
      number: '2025-0012',
      periodStart: '2025-12-01',
      periodEnd: '2025-12-31',
      payDate: '2025-12-23',
      taxYear: 2025,
      periodNumber: 12,
      // 1,000.00 brought in, 500.00 accrued this year, 200.00 paid: 1,300.00 still owed.
      ytd: { 'nl.holiday_allowance_opening': 100_000, 'nl.holiday_allowance_accrued': 50_000, 'nl.holiday_allowance_paid': 20_000, 'nl.loon_lb': 3_600_000, 'nl.months_employed_x10000': 120_000 },
    });
    const run = await julyRun();
    await calculateRun(db, run.id, deps, prep);
    const byAmount = new Map(seen.map((i) => [i.compensation.amount, i.nl!]));
    // Eva (3000 a month) was paid in December; Hans (hourly) and Piet were not.
    expect(byAmount.get(3000)).toMatchObject({ holidayAllowanceOpeningBalanceCents: 130_000, usualWorkDaysPerWeek: 5 });
    expect(byAmount.get(20)).toMatchObject({ holidayAllowanceOpeningBalanceCents: null, usualWorkDaysPerWeek: 5 });
    // Someone with no payslip last year starts with nothing; a 32-hour contract is a four-day week unless HR says otherwise.
    expect(byAmount.get(2400)).toMatchObject({ holidayAllowanceOpeningBalanceCents: null, usualWorkDaysPerWeek: 4 });
    await upsertProfile(db, parttime.id, { employerId: world.employerId, nl: { usualWorkDaysPerWeek: 5 } });
    seen.length = 0;
    await calculateRun(db, run.id, deps, prep);
    expect(seen.find((i) => i.nl!.contractHoursPerWeek === 32)!.nl).toMatchObject({ usualWorkDaysPerWeek: 5 });
  });

  it('turns a missing compensation into an error instead of a payslip, and a missing election into a warning', async () => {
    const { deps } = testDeps();
    const nobody = await createTestEmployee(db, { firstName: 'Nina', lastName: 'Zee' });
    await upsertProfile(db, nobody.id, { employerId: world.employerId, payScheduleId: world.scheduleId, startDate: '2026-01-01' });
    await setPaymentDetails(db, nobody.id, { nationalId: '111222333', dateOfBirth: '1991-01-01', bankIban: 'NL91ABNA0417164300' }, { keyring: TEST_KEYRING, selfService: false });
    const run = await julyRun();
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.employeeCount).toBe(2);
    const forNina = calculated.issues.filter((i) => i.employeeId === nobody.id).map((i) => `${i.severity}:${i.code}`);
    expect(forNina).toContain('error:missing_compensation');
    expect(forNina).toContain('warning:missing_tax_election');
    expect((await getRunDetail(db, run.id, { userId: 'u' })).canApprove).toBe(false);
    // Excluding her clears the error on the next calculation.
    await setRunEmployee(db, run.id, nobody.id, true);
    const again = await calculateRun(db, run.id, deps, prep);
    expect(again.issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('blocks on missing identity and bank details and warns about the anonymous rate setup in the list, not twice in the run', async () => {
    const { deps } = testDeps();
    const bare = await createTestEmployee(db, { firstName: 'Bart', lastName: 'Zwart' });
    await upsertProfile(db, bare.id, { employerId: world.employerId, payScheduleId: world.scheduleId, startDate: '2026-01-01' });
    await db.insert(schema.hrCompensations).values({ id: 'comp_bart', employeeId: bare.id, effectiveFrom: '2026-01-01', payType: 'salary', amount: '2000', period: 'month', currency: 'EUR' });
    const run = await julyRun();
    const calculated = await calculateRun(db, run.id, deps, prep);
    const codes = calculated.issues.filter((i) => i.employeeId === bare.id).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['missing_tax_id', 'missing_bank_account', 'missing_date_of_birth']));
    expect(codes.filter((c) => c === 'anonymous_rate')).toHaveLength(0);
    const slip = (await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, bare.id)))[0]!;
    expect((slip.snapshot as { input: { nl: { anonymous: boolean } } }).input.nl.anonymous).toBe(true);
  });

  it('treats an unavailable engine as an error on the payslip, not a failed run', async () => {
    const { deps } = testDeps({
      engines: {
        ...testDeps().deps.engines,
        calculatePayslip: () => {
          throw new Error('not implemented yet');
        },
      },
    });
    const run = await julyRun();
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.status).toBe('calculated');
    expect(calculated.issues.filter((i) => i.code === 'unsupported_tax_year' && i.severity === 'error')).toHaveLength(2);
    await expect(approveRun(db, run.id, deps, { userId: 'user_boss' })).rejects.toMatchObject({ code: 'RUN_HAS_ERRORS' });
  });

  it('passes the engine\'s own issues through unchanged', async () => {
    const base = testDeps();
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => ({ ...base.deps.engines.calculatePayslip(input), issues: [{ severity: 'warning', code: 'residence_state_differs', params: { state: 'NJ' } }] }),
      },
    });
    const run = await julyRun();
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.issues.find((i) => i.code === 'residence_state_differs')).toMatchObject({ severity: 'warning', params: { state: 'NJ' } });
  });

  it('flags a net pay that moved by more than 20% against the previous payslip', async () => {
    const { deps } = testDeps();
    const june = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-06-01' }, prep);
    await calculateRun(db, june.id, deps, prep);
    await approveRun(db, june.id, deps, { userId: 'user_boss' });
    const july = await julyRun();
    await createRunInput(db, july.id, { employeeId: world.eva.id, code: 'bonus', amount: 2000 }, prep);
    const calculated = await calculateRun(db, july.id, deps, prep);
    const change = calculated.issues.find((i) => i.code === 'large_change');
    expect(change).toMatchObject({ severity: 'warning', employeeId: world.eva.id });
    expect((change!.params as { percent: number }).percent).toBe(67);
    expect(calculated.issues.some((i) => i.code === 'first_payslip')).toBe(false);
    const detail = await getRunDetail(db, july.id, { userId: 'u' });
    expect(detail.payslips.find((p) => p.employeeId === world.eva.id)).toMatchObject({ previousNetPay: '2400.00', netPay: '4000.00' });
  });
});

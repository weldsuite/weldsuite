/**
 * Pay runs: create, the people in them, and the inputs that change pay
 * (collected from attendance, leave, absences and declarations, or typed).
 *
 *   draft → calculated → approved → paid
 *   draft | calculated → cancelled
 *
 * Calculating, approving and the files are in calculate.ts, approve.ts and
 * files.ts. Any change to what a run pays (inputs, who is in it, the pay
 * date) sends a calculated run back to draft, so what was reviewed is what
 * gets approved.
 */

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { HrPayrollIssue } from '@weldsuite/db/schema';
import { componentDef } from '@weldsuite/payroll-domain';
import { periodContaining, weekdaysBetween } from '@weldsuite/payroll-domain/periods';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { atomically } from '@weldsuite/worker-kit/atomically';
import type {
  CreateHrPayRunInput,
  CreateHrPayRunInputInput,
  UpdateHrPayRunInput,
  UpdateHrPayRunInputInput,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import type {
  HrPayRun as RunDto,
  HrPayRunDetail,
  HrPayRunInput as RunInputDto,
  HrPayslipSummary,
} from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { displayNameOf } from '../employees';
import { HrConflictError, HrNotFoundError, HrValidationError, memberNames } from '../shared';
import {
  countIssues,
  decimal2,
  decimal4,
  hasError,
  num,
  sortIssues,
  ts,
  type EmployeeRow,
  type EmployerRow,
  type PayslipRow,
  type ProfileRow,
  type RunInputRow,
  type RunRow,
  type ScheduleRow,
} from './common';
import { addDays, isIsoDate, maxDate, minDate, rangesOverlap, todayIso } from './dates';
import { compensationOn, loadEmployeePayrollData } from './employees';
import { requireEmployerRow } from './employers';
import { lastCompletedPeriods, nextPeriodOf, requireScheduleRow, specOf } from './schedules';
import { numberKey } from './ytd';

const r = schema.hrPayRuns;
const s = schema.hrPayslips;

export const COLLECTED_SOURCES = ['attendance', 'leave', 'absence', 'declaration'] as const;

export async function requireRun(db: Database, id: string): Promise<RunRow> {
  const [row] = await db.select().from(r).where(eq(r.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Pay run', id);
  return row;
}

export function assertEditable(run: RunRow): void {
  if (run.status !== 'draft' && run.status !== 'calculated') {
    throw new HrConflictError(`This pay run is ${run.status} and can no longer be changed`);
  }
}

/** A change to a calculated run's pay invalidates the calculation. */
async function reopen(db: Database, run: RunRow): Promise<void> {
  if (run.status === 'calculated') {
    await db.update(r).set({ status: 'draft', updatedAt: new Date() }).where(eq(r.id, run.id));
  }
}

// ---------------------------------------------------------------------------
// Who is in a run
// ---------------------------------------------------------------------------

/** Employment window of a profile: payroll dates, falling back to the employment dates. */
export function profileWindow(profile: Pick<ProfileRow, 'startDate' | 'endDate'>, employee: Pick<EmployeeRow, 'startDate' | 'endDate'>) {
  return { start: profile.startDate ?? employee.startDate ?? null, end: profile.endDate ?? employee.endDate ?? null };
}

/**
 * The employees a run could pay: for a regular run everyone active on its
 * schedule whose employment overlaps the period; for off-cycle and correction
 * runs the people it was created for.
 */
export async function candidateEmployeeIds(db: Database, run: RunRow): Promise<string[]> {
  const p = schema.hrPayrollProfiles;
  const e = schema.hrEmployees;
  if (run.kind === 'regular') {
    if (!run.payScheduleId) return [];
    const rows = await db
      .select({ employeeId: p.employeeId, profile: p, employee: e })
      .from(p)
      .innerJoin(e, eq(e.id, p.employeeId))
      .where(and(eq(p.payScheduleId, run.payScheduleId), eq(p.status, 'active'), isNull(e.deletedAt)));
    return rows
      .filter((row) => {
        const window = profileWindow(row.profile, row.employee);
        return rangesOverlap(window.start ?? '0001-01-01', window.end, run.periodStart, run.periodEnd);
      })
      .map((row) => row.employeeId);
  }
  return run.includedEmployeeIds ?? [];
}

export async function includedEmployeeIds(db: Database, run: RunRow): Promise<string[]> {
  const excluded = new Set(run.excludedEmployeeIds);
  return (await candidateEmployeeIds(db, run)).filter((id) => !excluded.has(id));
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export async function toRunDtos(db: Database, rows: RunRow[]): Promise<RunDto[]> {
  if (rows.length === 0) return [];
  const employerIds = [...new Set(rows.map((x) => x.employerId))];
  const scheduleIds = [...new Set(rows.map((x) => x.payScheduleId).filter((v): v is string => Boolean(v)))];
  const [employers, schedules, names] = await Promise.all([
    db.select({ id: schema.hrPayrollEmployers.id, name: schema.hrPayrollEmployers.name }).from(schema.hrPayrollEmployers).where(inArray(schema.hrPayrollEmployers.id, employerIds)),
    scheduleIds.length
      ? db.select({ id: schema.hrPaySchedules.id, name: schema.hrPaySchedules.name }).from(schema.hrPaySchedules).where(inArray(schema.hrPaySchedules.id, scheduleIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    memberNames(db, rows.flatMap((x) => [x.preparedBy, x.calculatedBy, x.approvedBy])),
  ]);
  const employerName = new Map(employers.map((x) => [x.id, x.name]));
  const scheduleName = new Map(schedules.map((x) => [x.id, x.name]));

  return rows.map((row) => {
    const { errors, warnings } = countIssues(row.issues);
    return {
      id: row.id,
      employerId: row.employerId,
      employerName: employerName.get(row.employerId) ?? '',
      payScheduleId: row.payScheduleId,
      payScheduleName: row.payScheduleId ? scheduleName.get(row.payScheduleId) ?? null : null,
      country: row.country as 'NL' | 'US',
      currency: row.currency,
      kind: row.kind as RunDto['kind'],
      correctsRunId: row.correctsRunId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      payDate: row.payDate,
      taxYear: row.taxYear,
      periodNumber: row.periodNumber,
      status: row.status as RunDto['status'],
      employeeCount: row.employeeCount,
      totals: row.totals,
      issues: sortIssues(row.issues),
      errorCount: errors,
      warningCount: warnings,
      notes: row.notes,
      preparedBy: row.preparedBy,
      preparedByName: row.preparedBy ? names.get(row.preparedBy) ?? null : null,
      calculatedAt: ts(row.calculatedAt),
      calculatedByName: row.calculatedBy ? names.get(row.calculatedBy) ?? null : null,
      approvedAt: ts(row.approvedAt),
      approvedByName: row.approvedBy ? names.get(row.approvedBy) ?? null : null,
      paidAt: ts(row.paidAt),
      journalStatus: row.journalStatus as RunDto['journalStatus'],
      journalEntryId: row.journalEntryId,
      journalError: row.journalError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/** Net pay of each employee's previous final payslip, for the variance column. */
async function previousNetPay(db: Database, run: RunRow, employeeIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (employeeIds.length === 0) return out;
  const s = schema.hrPayslips;
  const rows = await db
    .select({ employeeId: s.employeeId, netPay: s.netPay, periodEnd: s.periodEnd, payDate: s.payDate })
    .from(s)
    .where(
      and(
        inArray(s.employeeId, employeeIds),
        eq(s.employerId, run.employerId),
        eq(s.status, 'final'),
        isNull(s.correctsPayslipId),
        ne(s.runId, run.id),
        sql`${s.periodEnd} < ${run.periodEnd}`,
      ),
    )
    .orderBy(desc(s.periodEnd), desc(s.payDate));
  for (const row of rows) if (!out.has(row.employeeId)) out.set(row.employeeId, row.netPay);
  return out;
}

export async function payslipSummaries(db: Database, run: RunRow, rows: PayslipRow[]): Promise<HrPayslipSummary[]> {
  if (rows.length === 0) return [];
  const e = schema.hrEmployees;
  const employees = await db
    .select({ id: e.id, firstName: e.firstName, lastName: e.lastName, preferredName: e.preferredName })
    .from(e)
    .where(inArray(e.id, rows.map((x) => x.employeeId)));
  const nameOf = new Map(employees.map((x) => [x.id, displayNameOf(x)]));
  const previous = await previousNetPay(db, run, rows.map((x) => x.employeeId));
  return rows
    .map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: nameOf.get(row.employeeId) ?? '',
      status: row.status as HrPayslipSummary['status'],
      number: row.number,
      grossPay: row.grossPay,
      employeeTaxes: row.employeeTaxes,
      netPay: row.netPay,
      employerCost: row.employerCost,
      issues: sortIssues(row.issues),
      previousNetPay: previous.get(row.employeeId) ?? null,
      runId: row.runId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      payDate: row.payDate,
      currency: row.currency,
      employeeDeductions: row.employeeDeductions,
      reimbursements: row.reimbursements,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

export async function getRunDetail(db: Database, id: string, ctx: { userId: string }): Promise<HrPayRunDetail> {
  const run = await requireRun(db, id);
  const [dto] = await toRunDtos(db, [run]);
  const employer = await requireEmployerRow(db, run.employerId).catch(() => null);
  const candidates = await candidateEmployeeIds(db, run);
  const people = candidates.length
    ? await db
        .select({ id: schema.hrEmployees.id, firstName: schema.hrEmployees.firstName, lastName: schema.hrEmployees.lastName, preferredName: schema.hrEmployees.preferredName })
        .from(schema.hrEmployees)
        .where(inArray(schema.hrEmployees.id, candidates))
    : [];
  const excluded = new Set(run.excludedEmployeeIds);
  const slips = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, id));

  const fourEyesBlocks = Boolean(employer?.requireSeparateApprover && run.calculatedBy && run.calculatedBy === ctx.userId);
  return {
    ...dto!,
    employees: people
      .map((p) => ({
        employeeId: p.id,
        displayName: displayNameOf(p),
        excluded: excluded.has(p.id),
        issues: run.issues.filter((i) => i.employeeId === p.id),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    payslips: await payslipSummaries(db, run, slips),
    canApprove: run.status === 'calculated' && !hasError(run.issues) && !fourEyesBlocks,
    paymentFile: { format: run.country === 'NL' ? 'sepa' : 'nacha', available: run.status === 'approved' || run.status === 'paid' },
  };
}

export async function listRuns(
  db: Database,
  filters: { employerId?: string; status?: string; year?: number },
): Promise<RunDto[]> {
  const conditions = [];
  if (filters.employerId) conditions.push(eq(r.employerId, filters.employerId));
  if (filters.status) conditions.push(inArray(r.status, filters.status.split(',')));
  if (filters.year) conditions.push(eq(r.taxYear, Number(filters.year)));
  const rows = await db
    .select()
    .from(r)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(r.periodStart), desc(r.createdAt))
    .limit(500);
  return toRunDtos(db, rows);
}

// ---------------------------------------------------------------------------
// Create / update / cancel
// ---------------------------------------------------------------------------

async function employeesWithProfile(db: Database, employerId: string, ids: string[]) {
  const p = schema.hrPayrollProfiles;
  const rows = await db.select().from(p).where(and(inArray(p.employeeId, ids), eq(p.employerId, employerId), ne(p.status, 'ended')));
  const found = new Set(rows.map((x) => x.employeeId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new HrValidationError('Some employees are not on this employer\'s payroll', { employeeIds: missing });
  return rows;
}

export async function createRun(db: Database, input: CreateHrPayRunInput, ctx: { userId: string }): Promise<RunRow> {
  const employer = await requireEmployerRow(db, input.employerId);
  if (!employer.isActive) throw new HrValidationError('This employer is not active');
  const kind = input.kind ?? 'regular';
  const country = employer.country as 'NL' | 'US';

  if (kind === 'correction') return createCorrectionRun(db, input, employer, ctx);

  let schedule: ScheduleRow | null = null;
  let periodStart: string;
  let periodEnd: string;
  let payDate: string;
  let taxYear: number;
  let periodNumber: number;
  let includedEmployeeIds: string[] | null = null;

  if (kind === 'regular') {
    schedule = await requireScheduleRow(db, input.payScheduleId!);
    if (schedule.employerId !== employer.id) throw new HrValidationError('The pay schedule belongs to another employer');
    if (!schedule.isActive) throw new HrValidationError('This pay schedule is not active');
    let period;
    if (input.periodStart) {
      period = periodContaining(specOf(schedule), country, input.periodStart);
      if (period.start !== input.periodStart) {
        throw new HrValidationError(`periodStart must be the first day of a pay period (${period.start})`);
      }
      if (input.periodEnd && input.periodEnd !== period.end) {
        throw new HrValidationError(`periodEnd must be the last day of the pay period (${period.end})`);
      }
    } else {
      const last = (await lastCompletedPeriods(db, [schedule.id])).get(schedule.id) ?? null;
      period = nextPeriodOf(schedule, country, last);
    }
    periodStart = period.start;
    periodEnd = period.end;
    payDate = input.payDate ?? period.payDate;
    taxYear = period.taxYear;
    periodNumber = period.periodNumber;
  } else {
    if (!input.periodStart || !input.periodEnd || !input.payDate) {
      throw new HrValidationError('An off-cycle run needs its period and pay date');
    }
    if (!input.employeeIds?.length) throw new HrValidationError('An off-cycle run needs the employees it pays');
    if (input.periodEnd < input.periodStart) throw new HrValidationError('The period ends before it starts');
    const profiles = await employeesWithProfile(db, employer.id, input.employeeIds);
    includedEmployeeIds = [...new Set(input.employeeIds)];
    periodStart = input.periodStart;
    periodEnd = input.periodEnd;
    payDate = input.payDate;
    if (country === 'NL' && payDate.slice(0, 4) !== periodStart.slice(0, 4)) {
      throw new HrValidationError('A Dutch off-cycle run must be paid in the year of its period');
    }
    // Tax year and period number follow the employees' schedule when they have one.
    const scheduleId = input.payScheduleId ?? profiles.find((x) => x.payScheduleId)?.payScheduleId ?? null;
    schedule = scheduleId ? await requireScheduleRow(db, scheduleId).catch(() => null) : null;
    if (schedule) {
      const period = periodContaining(specOf(schedule), country, periodStart);
      taxYear = period.taxYear;
      periodNumber = period.periodNumber;
    } else {
      taxYear = Number((country === 'NL' ? periodStart : payDate).slice(0, 4));
      periodNumber = country === 'NL' ? Number(periodStart.slice(5, 7)) : 1;
    }
  }

  const id = generateId('hrpr');
  try {
    await db.insert(r).values({
      id,
      employerId: employer.id,
      payScheduleId: schedule?.id ?? null,
      country,
      currency: employer.currency,
      kind,
      periodStart,
      periodEnd,
      payDate,
      taxYear,
      periodNumber,
      status: 'draft',
      includedEmployeeIds,
      notes: input.notes ?? null,
      preparedBy: ctx.userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [existing] = await db
        .select({ id: r.id })
        .from(r)
        .where(and(eq(r.payScheduleId, schedule!.id), eq(r.periodStart, periodStart), eq(r.kind, 'regular'), ne(r.status, 'cancelled')))
        .limit(1);
      throw new HrConflictError(`A pay run for ${periodStart} - ${periodEnd} already exists${existing ? ` (${existing.id})` : ''}`);
    }
    throw err;
  }
  const run = await requireRun(db, id);
  const count = (await candidateEmployeeIds(db, run)).length;
  await db.update(r).set({ employeeCount: count }).where(eq(r.id, id));
  return { ...run, employeeCount: count };
}

async function createCorrectionRun(db: Database, input: CreateHrPayRunInput, employer: EmployerRow, ctx: { userId: string }): Promise<RunRow> {
  const corrected = await requireRun(db, input.correctsRunId!);
  if (corrected.employerId !== employer.id) throw new HrValidationError('The corrected run belongs to another employer');
  if (corrected.kind === 'correction') throw new HrValidationError('Correct the original run, not a correction');
  if (corrected.status !== 'approved' && corrected.status !== 'paid') {
    throw new HrConflictError('Only an approved or paid run can be corrected. Change a draft run directly.');
  }
  const originals = await db
    .select({ employeeId: s.employeeId })
    .from(s)
    .where(and(eq(s.runId, corrected.id), eq(s.status, 'final')));
  const eligible = new Set(originals.map((x) => x.employeeId));
  const selected = [...new Set(input.employeeIds?.length ? input.employeeIds : [...eligible])];
  if (selected.length === 0) throw new HrValidationError('There are no payslips to correct in that run');
  const notInRun = selected.filter((id) => !eligible.has(id));
  if (notInRun.length) throw new HrValidationError('Some employees have no payslip in the corrected run', { employeeIds: notInRun });

  // One open correction per payslip: two would both be computed against the same state.
  const open = await db
    .select({ id: r.id, included: r.includedEmployeeIds })
    .from(r)
    .where(and(eq(r.correctsRunId, corrected.id), inArray(r.status, ['draft', 'calculated'])));
  const busy = new Set(open.flatMap((x) => x.included ?? []));
  const clash = selected.filter((id) => busy.has(id));
  if (clash.length) throw new HrConflictError('Another open correction run already covers some of these employees');

  const payDate = input.payDate ?? todayIso();
  const id = generateId('hrpr');
  await db.insert(r).values({
    id,
    employerId: employer.id,
    payScheduleId: corrected.payScheduleId,
    country: corrected.country,
    currency: corrected.currency,
    kind: 'correction',
    correctsRunId: corrected.id,
    periodStart: corrected.periodStart,
    periodEnd: corrected.periodEnd,
    payDate,
    taxYear: corrected.taxYear,
    periodNumber: corrected.periodNumber,
    status: 'draft',
    employeeCount: selected.length,
    includedEmployeeIds: selected,
    notes: input.notes ?? null,
    preparedBy: ctx.userId,
  });
  // Start from the inputs that produced each payslip as it stands: the corrected run's, or, when the payslip was
  // corrected before, the latest correction's (which holds the full desired state). The preparer edits the copy.
  const i = schema.hrPayRunInputs;
  const originalSlips = await db.select().from(s).where(and(eq(s.runId, corrected.id), eq(s.status, 'final'), inArray(s.employeeId, selected)));
  const priorCorrections = originalSlips.length
    ? await db
        .select({ employeeId: s.employeeId, runId: s.runId, number: s.number, original: s.correctsPayslipId })
        .from(s)
        .where(and(inArray(s.correctsPayslipId, originalSlips.map((x) => x.id)), eq(s.status, 'final')))
    : [];
  const sourceRunOf = new Map<string, string>();
  for (const employeeId of selected) {
    const latest = priorCorrections
      .filter((x) => x.employeeId === employeeId)
      .sort((x, y) => (numberKey(y.number)?.[1] ?? 0) - (numberKey(x.number)?.[1] ?? 0))[0];
    sourceRunOf.set(employeeId, latest?.runId ?? corrected.id);
  }
  const sourceRuns = [...new Set(sourceRunOf.values())];
  const original = (await db.select().from(i).where(inArray(i.runId, sourceRuns))).filter((row) => sourceRunOf.get(row.employeeId) === row.runId);
  if (original.length) {
    await db.insert(i).values(
      original.map((row) => ({
        id: generateId('hrpi'),
        runId: id,
        employeeId: row.employeeId,
        code: row.code,
        label: row.label,
        quantity: row.quantity,
        rate: row.rate,
        amount: row.amount,
        workDate: row.workDate,
        source: 'manual',
        sourceRef: null,
        notes: row.notes,
        createdBy: ctx.userId,
      })),
    );
  }
  return requireRun(db, id);
}

export async function updateRun(db: Database, id: string, input: UpdateHrPayRunInput): Promise<RunRow> {
  const run = await requireRun(db, id);
  assertEditable(run);
  const payDateChanged = input.payDate !== undefined && input.payDate !== run.payDate;
  await db
    .update(r)
    .set({
      ...(input.payDate !== undefined && { payDate: input.payDate }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(payDateChanged && run.status === 'calculated' && { status: 'draft' }),
      updatedAt: new Date(),
    })
    .where(eq(r.id, id));
  return requireRun(db, id);
}

/** Cancel a draft or calculated run; its draft payslips go with it. */
export async function cancelRun(db: Database, id: string): Promise<RunRow> {
  const run = await requireRun(db, id);
  assertEditable(run);
  const now = new Date();
  await atomically(db, (h) => [
    h.update(r).set({ status: 'cancelled', cancelledAt: now, updatedAt: now }).where(eq(r.id, id)),
    h.delete(schema.hrPayslips).where(and(eq(schema.hrPayslips.runId, id), eq(schema.hrPayslips.status, 'draft'))),
  ]);
  return requireRun(db, id);
}

export async function setRunEmployee(db: Database, id: string, employeeId: string, excluded: boolean): Promise<RunRow> {
  const run = await requireRun(db, id);
  assertEditable(run);
  const candidates = await candidateEmployeeIds(db, run);
  if (!candidates.includes(employeeId)) throw new HrValidationError('That employee is not part of this run');
  const next = new Set(run.excludedEmployeeIds);
  if (excluded) next.add(employeeId);
  else next.delete(employeeId);
  const now = new Date();
  await atomically(db, (h) => [
    h.update(r).set({ excludedEmployeeIds: [...next], status: run.status === 'calculated' ? 'draft' : run.status, updatedAt: now }).where(eq(r.id, id)),
    ...(excluded
      ? [h.delete(schema.hrPayslips).where(and(eq(schema.hrPayslips.runId, id), eq(schema.hrPayslips.employeeId, employeeId), eq(schema.hrPayslips.status, 'draft')))]
      : []),
  ]);
  return requireRun(db, id);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function toInputDto(row: RunInputRow): RunInputDto {
  return {
    id: row.id,
    runId: row.runId,
    employeeId: row.employeeId,
    code: row.code,
    label: row.label,
    quantity: row.quantity,
    rate: row.rate,
    amount: row.amount,
    workDate: row.workDate,
    source: row.source as RunInputDto['source'],
    sourceRef: row.sourceRef,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRunInputs(db: Database, runId: string, filters: { employeeId?: string } = {}): Promise<RunInputDto[]> {
  await requireRun(db, runId);
  const i = schema.hrPayRunInputs;
  const rows = await db
    .select()
    .from(i)
    .where(filters.employeeId ? and(eq(i.runId, runId), eq(i.employeeId, filters.employeeId)) : eq(i.runId, runId))
    .orderBy(asc(i.employeeId), asc(i.createdAt));
  return rows.map(toInputDto);
}

function validateInput(country: 'NL' | 'US', code: string, v: { quantity?: number | null; rate?: number | null; amount?: number | null }) {
  const def = componentDef(code);
  if (!def) throw new HrValidationError(`Unknown pay code '${code}'`);
  if (!def.countries.includes(country)) throw new HrValidationError(`'${code}' is not available for ${country} payroll`);
  if (!def.oneOff) throw new HrValidationError(`'${code}' is set up on the employee, not entered on a pay run`);
  if ((def.entry === 'hours' || def.entry === 'days') && (v.quantity === null || v.quantity === undefined)) {
    throw new HrValidationError(`'${code}' needs a quantity`);
  }
  if (def.entry === 'amount' && (v.amount === null || v.amount === undefined)) throw new HrValidationError(`'${code}' needs an amount`);
}

export async function createRunInput(db: Database, runId: string, input: CreateHrPayRunInputInput, ctx: { userId: string }): Promise<RunInputDto> {
  const run = await requireRun(db, runId);
  assertEditable(run);
  if (!(await candidateEmployeeIds(db, run)).includes(input.employeeId)) {
    throw new HrValidationError('That employee is not part of this run');
  }
  validateInput(run.country as 'NL' | 'US', input.code, input);
  if (input.workDate && !isIsoDate(input.workDate)) throw new HrValidationError('workDate is not a date');
  const [row] = await db
    .insert(schema.hrPayRunInputs)
    .values({
      id: generateId('hrpi'),
      runId,
      employeeId: input.employeeId,
      code: input.code,
      label: input.label ?? null,
      quantity: input.quantity === null || input.quantity === undefined ? null : decimal4(input.quantity),
      rate: input.rate === null || input.rate === undefined ? null : decimal4(input.rate),
      amount: input.amount === null || input.amount === undefined ? null : decimal2(input.amount),
      workDate: input.workDate ?? null,
      source: 'manual',
      notes: input.notes ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  await reopen(db, run);
  return toInputDto(row!);
}

async function requireInput(db: Database, runId: string, inputId: string): Promise<RunInputRow> {
  const i = schema.hrPayRunInputs;
  const [row] = await db.select().from(i).where(and(eq(i.id, inputId), eq(i.runId, runId))).limit(1);
  if (!row) throw new HrNotFoundError('Pay run input', inputId);
  return row;
}

export async function updateRunInput(db: Database, runId: string, inputId: string, input: UpdateHrPayRunInputInput): Promise<RunInputDto> {
  const run = await requireRun(db, runId);
  assertEditable(run);
  const row = await requireInput(db, runId, inputId);
  const next = {
    quantity: input.quantity !== undefined ? input.quantity : num(row.quantity),
    rate: input.rate !== undefined ? input.rate : num(row.rate),
    amount: input.amount !== undefined ? input.amount : num(row.amount),
  };
  validateInput(run.country as 'NL' | 'US', row.code, next);
  // Editing the figures of a collected line makes it the preparer's own line: re-collecting must not overwrite it.
  const figuresChanged = input.quantity !== undefined || input.rate !== undefined || input.amount !== undefined;
  const [updated] = await db
    .update(schema.hrPayRunInputs)
    .set({
      ...(input.label !== undefined && { label: input.label }),
      ...(input.quantity !== undefined && { quantity: input.quantity === null ? null : decimal4(input.quantity) }),
      ...(input.rate !== undefined && { rate: input.rate === null ? null : decimal4(input.rate) }),
      ...(input.amount !== undefined && { amount: input.amount === null ? null : decimal2(input.amount) }),
      ...(input.workDate !== undefined && { workDate: input.workDate }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(figuresChanged && row.source !== 'manual' && { source: 'manual' }),
      updatedAt: new Date(),
    })
    .where(eq(schema.hrPayRunInputs.id, inputId))
    .returning();
  await reopen(db, run);
  return toInputDto(updated!);
}

export async function deleteRunInput(db: Database, runId: string, inputId: string): Promise<void> {
  const run = await requireRun(db, runId);
  assertEditable(run);
  await requireInput(db, runId, inputId);
  await db.delete(schema.hrPayRunInputs).where(eq(schema.hrPayRunInputs.id, inputId));
  await reopen(db, run);
}

// ---------------------------------------------------------------------------
// Collecting inputs from attendance, leave, absences and declarations
// ---------------------------------------------------------------------------

export interface CollectSummary {
  attendance: number;
  leave: number;
  absence: number;
  declaration: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Re-collect the run's inputs. Lines collected earlier are replaced (those
 * the preparer edited became `manual` and stay); manual lines are never
 * touched, and a candidate that a manual line already covers (same code and
 * source reference) is not collected twice.
 *
 *  - approved attendance → `hours.regular`, one line per worked day
 *    (hourly employees; US non-exempt salaried employees, for overtime)
 *  - approved unpaid leave → `hours.unpaid_leave` (salaried employees);
 *    approved paid leave → `hours.paid_leave` (US hourly)
 *  - sick reports → `nl.sick_pay` at 100% (NL, salaried; edit the rate for 70%)
 *  - approved, unpaid expense declarations up to the period end → `reimbursement`
 */
export async function collectRunInputs(db: Database, runId: string, keyring: EncryptionKeyring, ctx: { userId: string }): Promise<CollectSummary> {
  const run = await requireRun(db, runId);
  assertEditable(run);
  if (run.kind === 'correction') {
    throw new HrConflictError('A correction starts from the original run\'s inputs; edit those instead of collecting');
  }
  const employeeIds = await includedEmployeeIds(db, run);
  const summary: CollectSummary = { attendance: 0, leave: 0, absence: 0, declaration: 0 };
  const i = schema.hrPayRunInputs;

  if (employeeIds.length === 0) {
    await db.delete(i).where(and(eq(i.runId, runId), inArray(i.source, [...COLLECTED_SOURCES])));
    await reopen(db, run);
    return summary;
  }

  const data = await loadEmployeePayrollData(db, employeeIds, keyring);
  const country = run.country as 'NL' | 'US';
  const { periodStart, periodEnd } = run;

  const manual = await db.select().from(i).where(and(eq(i.runId, runId), eq(i.source, 'manual')));
  const manualKeys = new Set(manual.filter((m) => m.sourceRef).map((m) => `${m.code}|${m.sourceRef}`));
  const fresh: Array<typeof i.$inferInsert> = [];
  const push = (row: Omit<typeof i.$inferInsert, 'id' | 'runId' | 'createdBy'> & { sourceRef: string }, kind: keyof CollectSummary) => {
    if (manualKeys.has(`${row.code}|${row.sourceRef}`)) return;
    fresh.push({ id: generateId('hrpi'), runId, createdBy: ctx.userId, ...row });
    summary[kind] += 1;
  };

  const contractHours = (employeeId: string): number => {
    const d = data.get(employeeId)!;
    const comp = compensationOn(d.compensations, periodEnd);
    return d.profile?.nl.contractHoursPerWeek ?? comp?.hoursPerWeek ?? d.employee.weeklyHours ?? 40;
  };
  const payTypeOf = (employeeId: string) => compensationOn(data.get(employeeId)!.compensations, periodEnd)?.payType ?? null;
  const isNonexempt = (employeeId: string) => {
    const d = data.get(employeeId)!;
    return country === 'US' && (d.profile?.us.flsaStatus ?? (payTypeOf(employeeId) === 'hourly' ? 'nonexempt' : 'exempt')) === 'nonexempt';
  };
  const paidByHours = (employeeId: string) => payTypeOf(employeeId) === 'hourly';

  // Attendance
  const attendance = await db
    .select()
    .from(schema.hrAttendanceRecords)
    .where(
      and(
        inArray(schema.hrAttendanceRecords.employeeId, employeeIds),
        sql`${schema.hrAttendanceRecords.date} >= ${periodStart} AND ${schema.hrAttendanceRecords.date} <= ${periodEnd}`,
        sql`${schema.hrAttendanceRecords.approvedAt} IS NOT NULL`,
        sql`${schema.hrAttendanceRecords.workedMinutes} > 0`,
      ),
    )
    .orderBy(asc(schema.hrAttendanceRecords.date), asc(schema.hrAttendanceRecords.createdAt));
  const perDay = new Map<string, { employeeId: string; date: string; minutes: number; firstId: string }>();
  for (const row of attendance) {
    if (!paidByHours(row.employeeId) && !isNonexempt(row.employeeId)) continue;
    const key = `${row.employeeId}|${row.date}`;
    const entry = perDay.get(key) ?? { employeeId: row.employeeId, date: row.date, minutes: 0, firstId: row.id };
    entry.minutes += row.workedMinutes ?? 0;
    perDay.set(key, entry);
  }
  for (const day of perDay.values()) {
    push(
      { employeeId: day.employeeId, code: 'hours.regular', label: null, quantity: decimal4(round2(day.minutes / 60)), rate: null, amount: null, workDate: day.date, source: 'attendance', sourceRef: day.firstId, notes: null },
      'attendance',
    );
  }

  // Leave
  const leave = await db
    .select({ request: schema.hrLeaveRequests, isPaid: schema.hrLeaveTypes.isPaid, typeName: schema.hrLeaveTypes.name })
    .from(schema.hrLeaveRequests)
    .innerJoin(schema.hrLeaveTypes, eq(schema.hrLeaveTypes.id, schema.hrLeaveRequests.leaveTypeId))
    .where(
      and(
        inArray(schema.hrLeaveRequests.employeeId, employeeIds),
        eq(schema.hrLeaveRequests.status, 'approved'),
        sql`${schema.hrLeaveRequests.startDate} <= ${periodEnd} AND ${schema.hrLeaveRequests.endDate} >= ${periodStart}`,
      ),
    );
  for (const { request, isPaid, typeName } of leave) {
    const overlapStart = maxDate(request.startDate, periodStart);
    const overlapEnd = minDate(request.endDate, periodEnd);
    const total = weekdaysBetween(request.startDate, request.endDate);
    const inPeriod = weekdaysBetween(overlapStart, overlapEnd);
    if (total === 0 || inPeriod === 0) continue;
    const days = request.days * (inPeriod / total);
    const hours = round2(days * (contractHours(request.employeeId) / 5));
    if (hours <= 0) continue;
    if (!isPaid && payTypeOf(request.employeeId) === 'salary') {
      push(
        { employeeId: request.employeeId, code: 'hours.unpaid_leave', label: typeName, quantity: decimal4(hours), rate: null, amount: null, workDate: overlapStart, source: 'leave', sourceRef: request.id, notes: null },
        'leave',
      );
    } else if (isPaid && country === 'US' && paidByHours(request.employeeId)) {
      push(
        { employeeId: request.employeeId, code: 'hours.paid_leave', label: typeName, quantity: decimal4(hours), rate: null, amount: null, workDate: overlapStart, source: 'leave', sourceRef: request.id, notes: null },
        'leave',
      );
    }
  }

  // Sick reports (NL salaried)
  if (country === 'NL') {
    const absences = await db
      .select()
      .from(schema.hrAbsences)
      .where(
        and(
          inArray(schema.hrAbsences.employeeId, employeeIds),
          sql`${schema.hrAbsences.startDate} <= ${periodEnd}`,
          or(isNull(schema.hrAbsences.endDate), sql`${schema.hrAbsences.endDate} >= ${periodStart}`),
        ),
      );
    for (const absence of absences) {
      if (payTypeOf(absence.employeeId) !== 'salary') continue;
      const start = maxDate(absence.startDate, periodStart);
      const end = minDate(absence.endDate ?? periodEnd, periodEnd);
      let days = weekdaysBetween(start, end);
      if (absence.firstDay === 'half' && absence.startDate >= periodStart && weekdaysBetween(absence.startDate, absence.startDate) === 1) days -= 0.5;
      if (days <= 0) continue;
      push(
        { employeeId: absence.employeeId, code: 'nl.sick_pay', label: null, quantity: decimal4(round2(days * (contractHours(absence.employeeId) / 5))), rate: decimal4(100), amount: null, workDate: start, source: 'absence', sourceRef: absence.id, notes: null },
        'absence',
      );
    }
  }

  // Declarations: approved, not yet paid, not already in another live run
  const declarations = await db
    .select()
    .from(schema.hrDeclarations)
    .where(
      and(
        inArray(schema.hrDeclarations.employeeId, employeeIds),
        eq(schema.hrDeclarations.status, 'approved'),
        eq(schema.hrDeclarations.currency, run.currency),
        sql`${schema.hrDeclarations.expenseDate} <= ${periodEnd}`,
        isNull(schema.hrDeclarations.paidAt),
      ),
    );
  if (declarations.length) {
    const taken = await db
      .select({ ref: i.sourceRef })
      .from(i)
      .innerJoin(r, eq(r.id, i.runId))
      .where(
        and(
          inArray(i.sourceRef, declarations.map((d) => d.id)),
          ne(i.runId, runId),
          inArray(r.status, ['draft', 'calculated', 'approved']),
        ),
      );
    const takenIds = new Set(taken.map((x) => x.ref));
    for (const d of declarations) {
      if (takenIds.has(d.id)) continue;
      push(
        { employeeId: d.employeeId, code: 'reimbursement', label: d.description.slice(0, 160), quantity: null, rate: null, amount: decimal2(Number(d.amount)), workDate: d.expenseDate, source: 'declaration', sourceRef: d.id, notes: null },
        'declaration',
      );
    }
  }

  await atomically(db, (h) => [
    h.delete(i).where(and(eq(i.runId, runId), inArray(i.source, [...COLLECTED_SOURCES]))),
    ...(fresh.length ? [h.insert(i).values(fresh)] : []),
  ]);
  await reopen(db, run);
  return summary;
}

/**
 * Pay schedules: how often an employer pays and on which day. The periods
 * themselves are computed (`@weldsuite/payroll-domain/periods`); only the
 * schedule (frequency, anchor, pay-date rule) is stored.
 */

import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { nextPeriodToRun, type PayScheduleSpec } from '@weldsuite/payroll-domain/periods';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { CreateHrPayScheduleInput, UpdateHrPayScheduleInput } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import type { HrPayPeriod, HrPaySchedule as ScheduleDto } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { HrConflictError, HrNotFoundError, HrValidationError } from '../shared';
import type { EmployerRow, ScheduleRow } from './common';
import { isIsoDate } from './dates';
import { requireEmployerRow } from './employers';

const t = schema.hrPaySchedules;

export function specOf(row: Pick<ScheduleRow, 'frequency' | 'anchorDate' | 'payDateRule'>): PayScheduleSpec {
  return { frequency: row.frequency as PayScheduleSpec['frequency'], anchorDate: row.anchorDate, payDateRule: row.payDateRule };
}

export async function requireScheduleRow(db: Database, id: string): Promise<ScheduleRow> {
  const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Pay schedule', id);
  return row;
}

function assertRuleAllowed(employer: Pick<EmployerRow, 'country'>, frequency: string, rule: ScheduleRow['payDateRule']) {
  if (employer.country === 'NL') {
    if (frequency !== 'monthly') throw new HrValidationError('Dutch payroll runs monthly in this version');
    if (rule.kind === 'offset_after_end') {
      throw new HrValidationError('Dutch payroll pays on a day of the month or on the last business day');
    }
  }
  if (rule.kind === 'last_business_day' && frequency !== 'monthly' && frequency !== 'semimonthly') {
    throw new HrValidationError('The last business day only fits monthly and semi-monthly schedules');
  }
}

export async function createSchedule(db: Database, input: CreateHrPayScheduleInput): Promise<ScheduleDto> {
  const employer = await requireEmployerRow(db, input.employerId);
  if (!isIsoDate(input.anchorDate)) throw new HrValidationError('anchorDate is not a date');
  assertRuleAllowed(employer, input.frequency, input.payDateRule);
  const id = generateId('hrps');
  await db.insert(t).values({
    id,
    employerId: input.employerId,
    name: input.name.trim(),
    frequency: input.frequency,
    anchorDate: input.anchorDate,
    payDateRule: input.payDateRule,
  });
  return getSchedule(db, id);
}

export async function updateSchedule(db: Database, id: string, input: UpdateHrPayScheduleInput): Promise<ScheduleDto> {
  const row = await requireScheduleRow(db, id);
  if (input.payDateRule) {
    const employer = await requireEmployerRow(db, row.employerId);
    assertRuleAllowed(employer, row.frequency, input.payDateRule);
  }
  await db
    .update(t)
    .set({
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.payDateRule !== undefined && { payDateRule: input.payDateRule }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(t.id, id));
  return getSchedule(db, id);
}

/** Soft delete; refused while it has pay runs or employees. */
export async function deleteSchedule(db: Database, id: string): Promise<void> {
  await requireScheduleRow(db, id);
  const [runs] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hrPayRuns)
    .where(eq(schema.hrPayRuns.payScheduleId, id));
  if (Number(runs?.count ?? 0) > 0) throw new HrConflictError('This schedule has pay runs and cannot be deleted. Deactivate it instead.');
  const [profiles] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hrPayrollProfiles)
    .where(and(eq(schema.hrPayrollProfiles.payScheduleId, id), ne(schema.hrPayrollProfiles.status, 'ended')));
  if (Number(profiles?.count ?? 0) > 0) throw new HrConflictError('Employees are still on this schedule. Move them first.');
  const now = new Date();
  await db.update(t).set({ deletedAt: now, updatedAt: now, isActive: false }).where(eq(t.id, id));
}

/** The latest approved or paid regular run of each schedule: the next period follows it. */
export async function lastCompletedPeriods(db: Database, scheduleIds: string[]) {
  const out = new Map<string, { start: string; end: string }>();
  if (scheduleIds.length === 0) return out;
  const r = schema.hrPayRuns;
  const rows = await db
    .select({ scheduleId: r.payScheduleId, periodStart: r.periodStart, periodEnd: r.periodEnd })
    .from(r)
    .where(and(inArray(r.payScheduleId, scheduleIds), eq(r.kind, 'regular'), inArray(r.status, ['approved', 'paid'])))
    .orderBy(desc(r.periodStart));
  for (const row of rows) {
    if (row.scheduleId && !out.has(row.scheduleId)) out.set(row.scheduleId, { start: row.periodStart, end: row.periodEnd });
  }
  return out;
}

export function nextPeriodOf(schedule: ScheduleRow, country: 'NL' | 'US', last: { start: string; end: string } | null): HrPayPeriod {
  const period = nextPeriodToRun(specOf(schedule), country, last);
  return { ...period };
}

export async function toScheduleDtos(db: Database, rows: ScheduleRow[]): Promise<ScheduleDto[]> {
  if (rows.length === 0) return [];
  const employerIds = [...new Set(rows.map((r) => r.employerId))];
  const employers = await db
    .select({ id: schema.hrPayrollEmployers.id, country: schema.hrPayrollEmployers.country })
    .from(schema.hrPayrollEmployers)
    .where(inArray(schema.hrPayrollEmployers.id, employerIds));
  const countryOf = new Map(employers.map((e) => [e.id, e.country as 'NL' | 'US']));
  const counts = await db
    .select({ scheduleId: schema.hrPayrollProfiles.payScheduleId, count: sql<number>`count(*)::int` })
    .from(schema.hrPayrollProfiles)
    .where(and(inArray(schema.hrPayrollProfiles.payScheduleId, rows.map((r) => r.id)), eq(schema.hrPayrollProfiles.status, 'active')))
    .groupBy(schema.hrPayrollProfiles.payScheduleId);
  const employeeCount = new Map(counts.map((c) => [c.scheduleId, Number(c.count)]));
  const last = await lastCompletedPeriods(db, rows.map((r) => r.id));

  return rows.map((row) => {
    const country = countryOf.get(row.employerId) ?? 'NL';
    let nextPeriod: HrPayPeriod | null = null;
    try {
      nextPeriod = nextPeriodOf(row, country, last.get(row.id) ?? null);
    } catch {
      nextPeriod = null;
    }
    return {
      id: row.id,
      employerId: row.employerId,
      name: row.name,
      frequency: row.frequency as ScheduleDto['frequency'],
      anchorDate: row.anchorDate,
      payDateRule: row.payDateRule,
      isActive: row.isActive,
      employeeCount: employeeCount.get(row.id) ?? 0,
      nextPeriod,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function listSchedules(db: Database, filters: { employerId?: string } = {}): Promise<ScheduleDto[]> {
  const conditions = [isNull(t.deletedAt)];
  if (filters.employerId) conditions.push(eq(t.employerId, filters.employerId));
  const rows = await db.select().from(t).where(and(...conditions)).orderBy(t.name);
  return toScheduleDtos(db, rows);
}

export async function getSchedule(db: Database, id: string): Promise<ScheduleDto> {
  const row = await requireScheduleRow(db, id);
  return (await toScheduleDtos(db, [row]))[0]!;
}

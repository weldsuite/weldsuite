/**
 * Sick reports.
 *
 * An employee reports sick from a first day and stays absent until they, or HR
 * on their behalf, report recovered: the end date is open in between. One
 * report per employee can be open at a time, and reports never overlap.
 *
 * Days are Mon–Fri days from the first sick day up to the last one (or today
 * while the report is open); a half first day counts as half.
 */

import { and, desc, eq, gte, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { displayNameOf, requireEmployee } from './employees';
import {
  HrConflictError,
  HrNotFoundError,
  HrValidationError,
  addDays,
  assertDateOrder,
  memberNames,
  todayIso,
  workingDaysBetween,
} from './shared';

/** A new report this soon after the previous one continues the same absence period. */
export const RELAPSE_WINDOW_DAYS = 28;

const ab = schema.hrAbsences;
const emp = schema.hrEmployees;
const dep = schema.hrDepartments;

type AbsenceRow = typeof ab.$inferSelect;
export type AbsenceStatus = 'ongoing' | 'completed';

/** Still absent: no last sick day yet, or one that has not passed. */
export function absenceStatus(endDate: string | null, today: string = todayIso()): AbsenceStatus {
  return endDate === null || endDate >= today ? 'ongoing' : 'completed';
}

export function absenceDays(
  absence: Pick<AbsenceRow, 'startDate' | 'endDate' | 'firstDay'>,
  today: string = todayIso(),
): number {
  const days = workingDaysBetween(absence.startDate, absence.endDate ?? today);
  const startsOnWorkingDay = workingDaysBetween(absence.startDate, absence.startDate) === 1;
  return absence.firstDay === 'half' && startsOnWorkingDay && days > 0 ? days - 0.5 : days;
}

function present(row: AbsenceRow, today: string) {
  return { ...row, status: absenceStatus(row.endDate, today), days: absenceDays(row, today) };
}

export async function requireAbsence(db: Database, id: string) {
  const [row] = await db.select().from(ab).where(eq(ab.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Sick report', id);
  return row;
}

/** Another report of this employee that shares a day with [startDate, endDate]. */
async function assertNoOverlap(
  db: Database,
  employeeId: string,
  startDate: string,
  endDate: string | null,
  exceptId?: string,
) {
  const conditions: SQL[] = [eq(ab.employeeId, employeeId)];
  const stillRunning = or(isNull(ab.endDate), gte(ab.endDate, startDate));
  if (stillRunning) conditions.push(stillRunning);
  if (endDate) conditions.push(lte(ab.startDate, endDate));
  if (exceptId) conditions.push(ne(ab.id, exceptId));
  const [overlap] = await db.select({ endDate: ab.endDate }).from(ab).where(and(...conditions)).limit(1);
  if (!overlap) return;
  throw new HrConflictError(
    overlap.endDate === null ? 'There is already an open sick report' : 'This overlaps another sick report',
  );
}

// ---------------------------------------------------------------------------
// Back office
// ---------------------------------------------------------------------------

export interface AbsenceFilters {
  status?: AbsenceStatus;
  employeeId?: string;
  departmentId?: string;
  limit?: number;
  cursor?: string;
}

export async function listAbsences(db: Database, filters: AbsenceFilters, today: string = todayIso()) {
  const limit = Math.min(filters.limit ?? 50, 200);
  const conditions: SQL[] = [isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(ab.employeeId, filters.employeeId));
  if (filters.departmentId) conditions.push(eq(emp.departmentId, filters.departmentId));
  if (filters.status === 'completed') conditions.push(lt(ab.endDate, today));
  if (filters.status === 'ongoing') {
    const ongoing = or(isNull(ab.endDate), gte(ab.endDate, today));
    if (ongoing) conditions.push(ongoing);
  }

  const pageConditions = [...conditions];
  if (filters.cursor) {
    const [cur] = await db.select({ startDate: ab.startDate, id: ab.id }).from(ab).where(eq(ab.id, filters.cursor)).limit(1);
    if (cur) pageConditions.push(sql`(${ab.startDate}, ${ab.id}) < (${cur.startDate}, ${cur.id})`);
  }

  const [rows, countRes] = await Promise.all([
    db
      .select({
        absence: ab,
        firstName: emp.firstName,
        lastName: emp.lastName,
        preferredName: emp.preferredName,
        employeeUserId: emp.userId,
        departmentName: dep.name,
        // The previous report ended less than four weeks before this one began.
        relapse: sql<boolean>`exists (
          select 1 from hr_absences previous
          where previous.employee_id = ${ab.employeeId}
            and previous.id <> ${ab.id}
            and previous.end_date < ${ab.startDate}
            and previous.end_date >= ${ab.startDate} - ${RELAPSE_WINDOW_DAYS}::int
        )`,
      })
      .from(ab)
      .innerJoin(emp, eq(emp.id, ab.employeeId))
      .leftJoin(dep, and(eq(dep.id, emp.departmentId), isNull(dep.deletedAt)))
      .where(and(...pageConditions))
      .orderBy(desc(ab.startDate), desc(ab.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(ab)
      .innerJoin(emp, eq(emp.id, ab.employeeId))
      .where(and(...conditions)),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const reporters = await memberNames(db, page.map((r) => r.absence.reportedBy));
  return {
    data: page.map((r) => {
      const reportedBy = r.absence.reportedBy;
      const reportedBySelf = Boolean(reportedBy) && (reportedBy === r.employeeUserId || reportedBy === `portal:${r.absence.employeeId}`);
      return {
        ...present(r.absence, today),
        employeeName: displayNameOf(r),
        departmentName: r.departmentName,
        relapse: Boolean(r.relapse),
        reportedBySelf,
        reportedByName: reportedBy && !reportedBySelf ? reporters.get(reportedBy) ?? null : null,
      };
    }),
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor: hasMore && page.length ? page[page.length - 1]!.absence.id : null,
  };
}

export async function createAbsence(
  db: Database,
  input: { employeeId: string; startDate: string; firstDay?: 'full' | 'half'; endDate?: string | null; note?: string | null },
  reportedBy: string,
) {
  await requireEmployee(db, input.employeeId);
  const endDate = input.endDate ?? null;
  assertDateOrder(input.startDate, endDate, 'Sick report');
  await assertNoOverlap(db, input.employeeId, input.startDate, endDate);
  const now = new Date();
  const [row] = await db
    .insert(ab)
    .values({
      id: generateId('hrabs'),
      employeeId: input.employeeId,
      startDate: input.startDate,
      endDate,
      firstDay: input.firstDay ?? 'full',
      note: input.note?.trim() || null,
      reportedBy,
      recoveredReportedBy: endDate ? reportedBy : null,
      recoveredReportedAt: endDate ? now : null,
    })
    .returning();
  return row!;
}

export async function updateAbsence(
  db: Database,
  id: string,
  input: { startDate?: string; firstDay?: 'full' | 'half'; endDate?: string | null; note?: string | null },
  updatedBy: string,
) {
  const existing = await requireAbsence(db, id);
  const startDate = input.startDate ?? existing.startDate;
  const endDate = input.endDate === undefined ? existing.endDate : input.endDate;
  assertDateOrder(startDate, endDate, 'Sick report');
  await assertNoOverlap(db, existing.employeeId, startDate, endDate, id);
  const now = new Date();
  // Who reported the recovery only changes when the report is closed or reopened here.
  const closing = endDate !== null && existing.endDate === null;
  const reopening = endDate === null && existing.endDate !== null;
  const [row] = await db
    .update(ab)
    .set({
      startDate,
      endDate,
      firstDay: input.firstDay ?? existing.firstDay,
      note: input.note === undefined ? existing.note : input.note?.trim() || null,
      ...(closing ? { recoveredReportedBy: updatedBy, recoveredReportedAt: now } : {}),
      ...(reopening ? { recoveredReportedBy: null, recoveredReportedAt: null } : {}),
      updatedAt: now,
    })
    .where(eq(ab.id, id))
    .returning();
  return row!;
}

/**
 * Close an open report. `onlyEmployeeId` is the self-service guard: someone
 * else's report is a 404, and an employee cannot report a recovery ahead of time.
 */
export async function recoverAbsence(
  db: Database,
  id: string,
  endDate: string,
  recoveredBy: string,
  onlyEmployeeId?: string,
  today: string = todayIso(),
) {
  const existing = await requireAbsence(db, id);
  if (onlyEmployeeId && existing.employeeId !== onlyEmployeeId) throw new HrNotFoundError('Sick report', id);
  if (existing.endDate !== null) throw new HrConflictError('This sick report is already closed');
  assertDateOrder(existing.startDate, endDate, 'Sick report');
  if (onlyEmployeeId && endDate > today) throw new HrValidationError('The last sick day cannot be in the future');
  const now = new Date();
  const [row] = await db
    .update(ab)
    .set({ endDate, recoveredReportedBy: recoveredBy, recoveredReportedAt: now, updatedAt: now })
    .where(eq(ab.id, id))
    .returning();
  return row!;
}

export async function deleteAbsence(db: Database, id: string) {
  await requireAbsence(db, id);
  await db.delete(ab).where(eq(ab.id, id));
}

// ---------------------------------------------------------------------------
// Self-service (My HR)
// ---------------------------------------------------------------------------

/** An employee reporting themselves sick: from today or earlier, never ahead of time. */
export async function reportSick(
  db: Database,
  employeeId: string,
  input: { startDate: string; firstDay?: 'full' | 'half'; note?: string | null },
  reportedBy: string,
  today: string = todayIso(),
) {
  if (input.startDate > today) throw new HrValidationError('The first sick day cannot be in the future');
  if (input.startDate < addDays(today, -RELAPSE_WINDOW_DAYS)) {
    throw new HrValidationError('Ask HR to add a sick report that started more than four weeks ago');
  }
  return createAbsence(db, { ...input, employeeId }, reportedBy);
}

/** The employee's open report, if any, and their earlier ones. */
export async function employeeAbsences(db: Database, employeeId: string, today: string = todayIso()) {
  const rows = await db
    .select()
    .from(ab)
    .where(eq(ab.employeeId, employeeId))
    .orderBy(desc(ab.startDate), desc(ab.id))
    .limit(100);
  // Who filed the report stays in the back office.
  const reports = rows.map((row) => ({
    id: row.id,
    startDate: row.startDate,
    endDate: row.endDate,
    firstDay: row.firstDay,
    note: row.note,
    status: absenceStatus(row.endDate, today),
    days: absenceDays(row, today),
    createdAt: row.createdAt,
  }));
  return {
    // Open means not yet reported recovered, whatever the dates say.
    current: reports.find((report) => report.endDate === null) ?? null,
    history: reports.filter((report) => report.endDate !== null),
  };
}

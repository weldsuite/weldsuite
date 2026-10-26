/**
 * Shifts, attendance and leave.
 *
 * Attendance is one row per employee per worked block (usually one per day).
 * Worked and late minutes are computed on write so reports never re-derive
 * them: worked = clock-out − clock-in − breaks; late = clock-in − the start of
 * the shift that covers that day, past a five-minute grace period.
 */

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt as lessThan, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { displayNameOf, requireEmployee } from './employees';
import {
  HrConflictError,
  HrNotFoundError,
  HrValidationError,
  assertDateOrder,
  companyNames,
  employedShareOfYear,
  memberNames,
  todayIso,
  workingDaysBetween,
  yearOf,
} from './shared';
import { NO_CLOCK_PLACE, workLocationNames, type ClockPlace } from './work-locations';

const LATE_GRACE_MINUTES = 5;

const sh = schema.hrShifts;
const att = schema.hrAttendanceRecords;
const lt = schema.hrLeaveTypes;
const la = schema.hrLeaveAllowances;
const lr = schema.hrLeaveRequests;
const emp = schema.hrEmployees;

const employeeNameColumns = {
  employeeFirstName: emp.firstName,
  employeeLastName: emp.lastName,
  employeePreferredName: emp.preferredName,
};

function employeeName(row: { employeeFirstName: string; employeeLastName: string; employeePreferredName: string | null }) {
  return displayNameOf({ firstName: row.employeeFirstName, lastName: row.employeeLastName, preferredName: row.employeePreferredName });
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export async function listShifts(db: Database, filters: { from: string; to: string; employeeId?: string; companyId?: string }) {
  const conditions: SQL[] = [
    gte(sh.startsAt, new Date(`${filters.from}T00:00:00Z`)),
    lte(sh.startsAt, new Date(`${filters.to}T23:59:59Z`)),
    isNull(emp.deletedAt),
  ];
  if (filters.employeeId) conditions.push(eq(sh.employeeId, filters.employeeId));
  if (filters.companyId) conditions.push(eq(sh.companyId, filters.companyId));
  const rows = await db
    .select({ shift: sh, ...employeeNameColumns })
    .from(sh)
    .innerJoin(emp, eq(emp.id, sh.employeeId))
    .where(and(...conditions))
    .orderBy(asc(sh.startsAt))
    .limit(2000);
  const names = await companyNames(db, rows.map((r) => r.shift.companyId));
  return rows.map((r) => ({
    ...r.shift,
    employeeName: employeeName(r),
    companyName: r.shift.companyId ? names.get(r.shift.companyId) ?? null : null,
  }));
}

async function requireShift(db: Database, id: string) {
  const [row] = await db.select().from(sh).where(eq(sh.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Shift', id);
  return row;
}

export function assertShiftWindow(startsAt: Date, endsAt: Date) {
  if (endsAt <= startsAt) throw new HrValidationError('A shift must end after it starts');
  if (endsAt.getTime() - startsAt.getTime() > 24 * 3600 * 1000) {
    throw new HrValidationError('A shift cannot be longer than 24 hours');
  }
}

/** One person works one shift at a time: a shift may touch another (17:00 end, 17:00 start) but not overlap it. */
export async function assertNoOverlappingShift(
  db: Database,
  employeeId: string,
  startsAt: Date,
  endsAt: Date,
  opts: { exceptId?: string; message?: string } = {},
) {
  const conditions: SQL[] = [eq(sh.employeeId, employeeId), lessThan(sh.startsAt, endsAt), gt(sh.endsAt, startsAt)];
  if (opts.exceptId) conditions.push(ne(sh.id, opts.exceptId));
  const [clash] = await db.select({ id: sh.id }).from(sh).where(and(...conditions)).limit(1);
  if (clash) throw new HrConflictError(opts.message ?? 'This shift overlaps another shift of this employee');
}

/** A break is optional, but when set it has both ends and sits inside the shift. */
export function assertShiftBreak(startsAt: Date, endsAt: Date, breakStartsAt: Date | null, breakEndsAt: Date | null) {
  if (!breakStartsAt && !breakEndsAt) return;
  if (!breakStartsAt || !breakEndsAt) throw new HrValidationError('A break needs both a start and an end time');
  if (breakEndsAt <= breakStartsAt) throw new HrValidationError('A break must end after it starts');
  if (breakStartsAt < startsAt || breakEndsAt > endsAt) throw new HrValidationError('A break must fall inside the shift');
}

/** `undefined` keeps what is stored, `null` clears it. */
function resolveInstant(input: string | null | undefined, existing: Date | null): Date | null {
  if (input === undefined) return existing;
  return input ? new Date(input) : null;
}

interface ShiftDetailsInput {
  companyId?: string | null;
  workType?: string | null;
  breakStartsAt?: string | null;
  breakEndsAt?: string | null;
  notes?: string | null;
}

export async function createShift(
  db: Database,
  input: ShiftDetailsInput & { employeeId: string; startsAt: string; endsAt: string },
  createdBy: string,
) {
  await requireEmployee(db, input.employeeId);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  assertShiftWindow(startsAt, endsAt);
  const breakStartsAt = resolveInstant(input.breakStartsAt, null);
  const breakEndsAt = resolveInstant(input.breakEndsAt, null);
  assertShiftBreak(startsAt, endsAt, breakStartsAt, breakEndsAt);
  await assertNoOverlappingShift(db, input.employeeId, startsAt, endsAt);
  const [row] = await db
    .insert(sh)
    .values({
      id: generateId('hrshf'),
      ...input,
      workType: input.workType?.trim() || null,
      startsAt,
      endsAt,
      breakStartsAt,
      breakEndsAt,
      createdBy,
    })
    .returning();
  return row!;
}

export async function updateShift(
  db: Database,
  id: string,
  input: ShiftDetailsInput & { startsAt?: string; endsAt?: string },
) {
  const existing = await requireShift(db, id);
  const startsAt = input.startsAt ? new Date(input.startsAt) : existing.startsAt;
  const endsAt = input.endsAt ? new Date(input.endsAt) : existing.endsAt;
  assertShiftWindow(startsAt, endsAt);
  const breakStartsAt = resolveInstant(input.breakStartsAt, existing.breakStartsAt);
  const breakEndsAt = resolveInstant(input.breakEndsAt, existing.breakEndsAt);
  assertShiftBreak(startsAt, endsAt, breakStartsAt, breakEndsAt);
  await assertNoOverlappingShift(db, existing.employeeId, startsAt, endsAt, { exceptId: id });
  const [row] = await db
    .update(sh)
    .set({
      companyId: input.companyId,
      workType: input.workType === undefined ? undefined : input.workType?.trim() || null,
      notes: input.notes,
      startsAt,
      endsAt,
      breakStartsAt,
      breakEndsAt,
      updatedAt: new Date(),
    })
    .where(eq(sh.id, id))
    .returning();
  return row!;
}

export async function deleteShift(db: Database, id: string) {
  await requireShift(db, id);
  await db.delete(sh).where(eq(sh.id, id));
}

/**
 * The shift a record on `date` belongs to: its own shift (a clock-in or switch
 * picked it) while that shift still runs into `date`, else the day's first
 * shift. "Runs into", not "starts on": a night shift from 22:00 to 06:00 is
 * still the record's shift when it was clocked in at 01:00 the next day. A
 * record HR moved to another date no longer touches its old shift and falls
 * back.
 */
async function shiftFor(db: Database, employeeId: string, date: string, shiftId: string | null) {
  if (shiftId) {
    const [own] = await db
      .select()
      .from(sh)
      .where(
        and(
          eq(sh.id, shiftId),
          eq(sh.employeeId, employeeId),
          lte(sh.startsAt, new Date(`${date}T23:59:59Z`)),
          gt(sh.endsAt, new Date(`${date}T00:00:00Z`)),
        ),
      )
      .limit(1);
    if (own) return own;
  }
  return shiftOn(db, employeeId, date);
}

/** The shift that starts on `date` for this employee, if any. */
async function shiftOn(db: Database, employeeId: string, date: string) {
  const [row] = await db
    .select()
    .from(sh)
    .where(
      and(
        eq(sh.employeeId, employeeId),
        gte(sh.startsAt, new Date(`${date}T00:00:00Z`)),
        lte(sh.startsAt, new Date(`${date}T23:59:59Z`)),
      ),
    )
    .orderBy(asc(sh.startsAt))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export function workedMinutes(clockIn: Date | null, clockOut: Date | null, breakMinutes: number): number | null {
  if (!clockIn || !clockOut) return null;
  const minutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000) - breakMinutes;
  return Math.max(0, minutes);
}

export function lateMinutesFor(clockIn: Date | null, shiftStart: Date | null): number {
  if (!clockIn || !shiftStart) return 0;
  const late = Math.round((clockIn.getTime() - shiftStart.getTime()) / 60000);
  return late > LATE_GRACE_MINUTES ? late : 0;
}

type AttendanceWrite = {
  companyId?: string | null;
  date?: string;
  clockIn?: string | null;
  clockOut?: string | null;
  breakMinutes?: number;
  status?: string;
  notes?: string | null;
};

/**
 * Clock times that make a record. A clock-out on the next calendar day is a
 * night shift and fine; what is checked is the span: positive, at most a day,
 * and longer than the break taken inside it.
 */
export function assertAttendanceTimes(clockIn: Date | null, clockOut: Date | null, breakMinutes: number) {
  if (!clockIn || !clockOut) return;
  if (clockOut <= clockIn) throw new HrValidationError('Clock-out must be after clock-in');
  const spanMinutes = (clockOut.getTime() - clockIn.getTime()) / 60000;
  if (spanMinutes > 24 * 60) throw new HrValidationError('A record cannot span more than 24 hours');
  if (breakMinutes >= spanMinutes) {
    throw new HrValidationError('The break must be shorter than the time between clock-in and clock-out');
  }
}

/** Derive worked/late minutes and — when the caller did not pick one — the status. */
async function derive(
  db: Database,
  employeeId: string,
  merged: { date: string; clockIn: Date | null; clockOut: Date | null; breakMinutes: number; status?: string; shiftId?: string | null },
  explicitStatus: boolean,
) {
  assertAttendanceTimes(merged.clockIn, merged.clockOut, merged.breakMinutes);
  const shift = await shiftFor(db, employeeId, merged.date, merged.shiftId ?? null);
  const late = lateMinutesFor(merged.clockIn, shift?.startsAt ?? null);
  let status = merged.status ?? 'present';
  if (!explicitStatus && merged.clockIn) status = late > 0 ? 'late' : 'present';
  return {
    shiftId: shift?.id ?? merged.shiftId ?? null,
    companyId: shift?.companyId ?? null,
    workedMinutes: workedMinutes(merged.clockIn, merged.clockOut, merged.breakMinutes),
    lateMinutes: late,
    status,
  };
}

export async function requireAttendance(db: Database, id: string) {
  const [row] = await db.select().from(att).where(eq(att.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Attendance record', id);
  return row;
}

export interface AttendanceFilters {
  employeeId?: string;
  companyId?: string;
  from?: string;
  to?: string;
  status?: string;
  unapproved?: boolean;
  limit?: number;
  cursor?: string;
}

export async function listAttendance(db: Database, filters: AttendanceFilters) {
  const limit = Math.min(filters.limit ?? 100, 500);
  const conditions: SQL[] = [isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(att.employeeId, filters.employeeId));
  if (filters.companyId) conditions.push(eq(att.companyId, filters.companyId));
  if (filters.from) conditions.push(gte(att.date, filters.from));
  if (filters.to) conditions.push(lte(att.date, filters.to));
  if (filters.status) conditions.push(inArray(att.status, filters.status.split(',')));
  if (filters.unapproved) conditions.push(isNull(att.approvedAt));

  const pageConditions = [...conditions];
  if (filters.cursor) {
    const [cur] = await db.select({ date: att.date, id: att.id }).from(att).where(eq(att.id, filters.cursor)).limit(1);
    if (cur) pageConditions.push(sql`(${att.date}, ${att.id}) < (${cur.date}, ${cur.id})`);
  }

  const [rows, countRes] = await Promise.all([
    db
      .select({ record: att, ...employeeNameColumns })
      .from(att)
      .innerJoin(emp, eq(emp.id, att.employeeId))
      .where(and(...pageConditions))
      .orderBy(desc(att.date), desc(att.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(att)
      .innerJoin(emp, eq(emp.id, att.employeeId))
      .where(and(...conditions)),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const [companies, approvers, places] = await Promise.all([
    companyNames(db, page.map((r) => r.record.companyId)),
    memberNames(db, page.map((r) => r.record.approvedBy)),
    workLocationNames(db, page.flatMap((r) => [r.record.clockInLocationId, r.record.clockOutLocationId])),
  ]);
  return {
    data: page.map((r) => ({
      ...r.record,
      employeeName: employeeName(r),
      companyName: r.record.companyId ? companies.get(r.record.companyId) ?? null : null,
      approvedByName: r.record.approvedBy ? approvers.get(r.record.approvedBy) ?? null : null,
      clockInLocationName: r.record.clockInLocationId ? places.get(r.record.clockInLocationId) ?? null : null,
      clockOutLocationName: r.record.clockOutLocationId ? places.get(r.record.clockOutLocationId) ?? null : null,
    })),
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor: hasMore && page.length ? page[page.length - 1]!.record.id : null,
  };
}

export async function createAttendance(
  db: Database,
  input: AttendanceWrite & { employeeId: string; date: string },
  /**
   * `shiftId` pins the record to that shift instead of the day's first one;
   * `place` is where a self-service clock-in happened.
   */
  opts: { createdBy: string; source?: string; shiftId?: string | null; place?: ClockPlace },
) {
  await requireEmployee(db, input.employeeId);
  const clockIn = input.clockIn ? new Date(input.clockIn) : null;
  const clockOut = input.clockOut ? new Date(input.clockOut) : null;
  const breakMinutes = input.breakMinutes ?? 0;
  const derived = await derive(
    db,
    input.employeeId,
    { date: input.date, clockIn, clockOut, breakMinutes, status: input.status, shiftId: opts.shiftId ?? null },
    Boolean(input.status),
  );
  const [row] = await db
    .insert(att)
    .values({
      id: generateId('hratt'),
      employeeId: input.employeeId,
      companyId: input.companyId ?? derived.companyId,
      shiftId: derived.shiftId,
      date: input.date,
      clockIn,
      clockOut,
      breakMinutes,
      workedMinutes: derived.workedMinutes,
      lateMinutes: derived.lateMinutes,
      status: derived.status,
      source: opts.source ?? 'manual',
      notes: input.notes ?? null,
      clockInLocationId: opts.place?.locationId ?? null,
      clockInLatitude: opts.place?.latitude ?? null,
      clockInLongitude: opts.place?.longitude ?? null,
      createdBy: opts.createdBy,
    })
    .returning();
  return row!;
}

function nextClockTime(value: string | null | undefined, current: Date | null): Date | null {
  if (value === undefined) return current;
  return value ? new Date(value) : null;
}

export async function updateAttendance(
  db: Database,
  id: string,
  input: AttendanceWrite,
  /** Where a self-service clock-out happened. */
  opts: { clockOutPlace?: ClockPlace } = {},
) {
  const existing = await requireAttendance(db, id);
  const date = input.date ?? existing.date;
  const clockIn = nextClockTime(input.clockIn, existing.clockIn);
  const clockOut = nextClockTime(input.clockOut, existing.clockOut);
  const breakMinutes = input.breakMinutes ?? existing.breakMinutes;
  const timesChanged = input.clockIn !== undefined || input.clockOut !== undefined || input.date !== undefined;
  const derived = await derive(
    db,
    existing.employeeId,
    { date, clockIn, clockOut, breakMinutes, status: input.status ?? existing.status, shiftId: existing.shiftId },
    // Keep a manually chosen status unless the times moved and nobody chose a new one.
    Boolean(input.status) || !timesChanged,
  );
  const [row] = await db
    .update(att)
    .set({
      companyId: input.companyId !== undefined ? input.companyId : existing.companyId,
      date,
      clockIn,
      clockOut,
      breakMinutes,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      shiftId: derived.shiftId,
      workedMinutes: derived.workedMinutes,
      lateMinutes: derived.lateMinutes,
      status: derived.status,
      ...(opts.clockOutPlace
        ? {
            clockOutLocationId: opts.clockOutPlace.locationId,
            clockOutLatitude: opts.clockOutPlace.latitude,
            clockOutLongitude: opts.clockOutPlace.longitude,
          }
        : {}),
      // An edited record needs approving again.
      approvedAt: null,
      approvedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(att.id, id))
    .returning();
  return row!;
}

export async function deleteAttendance(db: Database, id: string) {
  await requireAttendance(db, id);
  await db.delete(att).where(eq(att.id, id));
}

export function approveAttendance(
  db: Database,
  ids: string[],
  approvedBy: string,
): Promise<{ id: string; employeeId: string }[]> {
  if (ids.length === 0) return Promise.resolve([]);
  const now = new Date();
  return db
    .update(att)
    .set({ approvedAt: now, approvedBy, updatedAt: now })
    .where(and(inArray(att.id, ids), isNull(att.approvedAt)))
    .returning({ id: att.id, employeeId: att.employeeId })
    .execute();
}

/** Resolve import/portal employee references: email (case-insensitive) or employee number. */
export async function resolveEmployeeRefs(db: Database, refs: string[]) {
  const unique = [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const lowered = unique.map((r) => r.toLowerCase());
  const rows = await db
    .select({ id: emp.id, email: emp.email, employeeNumber: emp.employeeNumber })
    .from(emp)
    .where(
      and(
        isNull(emp.deletedAt),
        or(inArray(sql<string>`lower(${emp.email})`, lowered), inArray(emp.employeeNumber, unique)),
      ),
    );
  for (const row of rows) {
    out.set(row.email.toLowerCase(), row.id);
    if (row.employeeNumber) out.set(row.employeeNumber, row.id);
  }
  return out;
}

interface AttendanceImportRow {
  employee: string;
  date: string;
  clockIn?: string | null;
  clockOut?: string | null;
  breakMinutes?: number;
  status?: string;
  notes?: string | null;
}

/**
 * Import one row for a resolved employee: upsert the imported record of that
 * day (re-importing updates instead of duplicating). With `dryRun` it only
 * checks the times and says what it would do. Throws what the row cannot be.
 */
async function importAttendanceRow(
  db: Database,
  employeeId: string,
  row: AttendanceImportRow,
  createdBy: string,
  dryRun: boolean,
): Promise<'created' | 'updated'> {
  const [existing] = await db
    .select({ id: att.id })
    .from(att)
    .where(and(eq(att.employeeId, employeeId), eq(att.date, row.date), eq(att.source, 'import')))
    .limit(1);
  if (dryRun) {
    assertAttendanceTimes(row.clockIn ? new Date(row.clockIn) : null, row.clockOut ? new Date(row.clockOut) : null, row.breakMinutes ?? 0);
    return existing ? 'updated' : 'created';
  }
  const write = {
    clockIn: row.clockIn ?? null,
    clockOut: row.clockOut ?? null,
    breakMinutes: row.breakMinutes,
    status: row.status,
    notes: row.notes ?? null,
  };
  if (existing) {
    await updateAttendance(db, existing.id, write);
    return 'updated';
  }
  await createAttendance(db, { employeeId, date: row.date, ...write }, { createdBy, source: 'import' });
  return 'created';
}

export async function importAttendance(
  db: Database,
  rows: AttendanceImportRow[],
  createdBy: string,
  /** Validate every row (and count what would be created / updated) without writing. */
  opts: { dryRun?: boolean } = {},
) {
  const refs = await resolveEmployeeRefs(db, rows.map((r) => r.employee));
  const result = { created: 0, updated: 0, errors: [] as Array<{ row: number; reason: string }> };

  for (const [index, row] of rows.entries()) {
    const employeeId = refs.get(row.employee.trim().toLowerCase()) ?? refs.get(row.employee.trim());
    if (!employeeId) {
      result.errors.push({ row: index + 1, reason: `No employee matches "${row.employee}"` });
      continue;
    }
    try {
      result[await importAttendanceRow(db, employeeId, row, createdBy, Boolean(opts.dryRun))] += 1;
    } catch (err) {
      result.errors.push({ row: index + 1, reason: err instanceof Error ? err.message : 'Could not import row' });
    }
  }
  return result;
}

/** One of the employee's own shifts that has not ended and starts by the end of today. */
async function clockableShift(db: Database, employeeId: string, shiftId: string, now: Date) {
  const [shift] = await db
    .select()
    .from(sh)
    .where(and(eq(sh.id, shiftId), eq(sh.employeeId, employeeId)))
    .limit(1);
  if (!shift) throw new HrNotFoundError('Shift', shiftId);
  if (shift.endsAt <= now) throw new HrValidationError('That shift has already ended');
  if (todayIso(shift.startsAt) > todayIso(now)) throw new HrValidationError('That shift is not today');
  return shift;
}

/** The shift to clock in on now: the first of today's shifts that has not ended. */
async function currentShift(db: Database, employeeId: string, now: Date) {
  const [row] = await db
    .select()
    .from(sh)
    .where(
      and(
        eq(sh.employeeId, employeeId),
        gt(sh.endsAt, now),
        lte(sh.startsAt, new Date(`${todayIso(now)}T23:59:59Z`)),
      ),
    )
    .orderBy(asc(sh.startsAt))
    .limit(1);
  return row ?? null;
}

/**
 * Self-service clock in/out (workforce portal and My HR). One open record per
 * day; clocking in twice is a conflict. Clocking in links `shiftId`, or else
 * the first of today's shifts that has not ended. `createdBy` defaults to the
 * portal principal; My HR passes the member's user id. `place` is where it
 * happened, already checked against the work locations (see work-locations.ts).
 */
export async function clock(
  db: Database,
  employeeId: string,
  action: 'in' | 'out',
  now: Date = new Date(),
  createdBy: string = `portal:${employeeId}`,
  shiftId?: string,
  place: ClockPlace = NO_CLOCK_PLACE,
) {
  const today = todayIso(now);
  const open = await openClockRecord(db, employeeId);

  if (action === 'in') {
    if (open) throw new HrConflictError('You are already clocked in');
    const shift = shiftId ? await clockableShift(db, employeeId, shiftId, now) : await currentShift(db, employeeId, now);
    return createAttendance(
      db,
      { employeeId, date: today, clockIn: now.toISOString() },
      { createdBy, source: 'portal', shiftId: shift?.id ?? null, place },
    );
  }
  if (!open) throw new HrConflictError('You are not clocked in');
  return updateAttendance(db, open.id, { clockOut: now.toISOString() }, { clockOutPlace: place });
}

/**
 * Switch shift while clocked in: clock out of the open record and straight in
 * on another of today's shifts, so each shift keeps its own hours.
 */
export async function switchShift(
  db: Database,
  employeeId: string,
  shiftId: string | undefined,
  now: Date = new Date(),
  createdBy: string = `portal:${employeeId}`,
  place: ClockPlace = NO_CLOCK_PLACE,
) {
  if (!shiftId) throw new HrValidationError('Pick the shift to switch to');
  const open = await openClockRecord(db, employeeId);
  if (!open) throw new HrConflictError('You are not clocked in');
  const shift = await clockableShift(db, employeeId, shiftId, now);
  if (open.shiftId === shift.id) throw new HrConflictError('You are already on this shift');
  const closed = await updateAttendance(db, open.id, { clockOut: now.toISOString() }, { clockOutPlace: place });
  const opened = await createAttendance(
    db,
    { employeeId, date: todayIso(now), clockIn: now.toISOString() },
    { createdBy, source: 'portal', shiftId: shift.id, place },
  );
  return { closed, opened };
}

export async function openClockRecord(db: Database, employeeId: string) {
  const [open] = await db
    .select()
    .from(att)
    .where(and(eq(att.employeeId, employeeId), isNull(att.clockOut), sql`${att.clockIn} is not null`))
    .orderBy(desc(att.clockIn))
    .limit(1);
  return open ?? null;
}

/** Status counts and totals over a date range, optionally narrowed to employees or a client. */
export async function attendanceSummary(
  db: Database,
  filters: { from: string; to: string; employeeIds?: string[]; companyId?: string },
) {
  const conditions: SQL[] = [gte(att.date, filters.from), lte(att.date, filters.to)];
  if (filters.employeeIds) {
    if (filters.employeeIds.length === 0) return emptySummary();
    conditions.push(inArray(att.employeeId, filters.employeeIds));
  }
  if (filters.companyId) conditions.push(eq(att.companyId, filters.companyId));
  const rows = await db
    .select({
      status: att.status,
      count: sql<number>`count(*)`,
      worked: sql<number>`coalesce(sum(${att.workedMinutes}), 0)`,
      late: sql<number>`coalesce(sum(${att.lateMinutes}), 0)`,
    })
    .from(att)
    .where(and(...conditions))
    .groupBy(att.status);
  const summary = emptySummary();
  for (const row of rows) {
    const count = Number(row.count);
    summary.byStatus[row.status] = count;
    summary.records += count;
    summary.workedMinutes += Number(row.worked);
    summary.lateMinutes += Number(row.late);
  }
  const attended = summary.records - (summary.byStatus.absent ?? 0);
  summary.attendanceRate = summary.records ? Math.round((attended / summary.records) * 1000) / 10 : null;
  return summary;
}

function emptySummary() {
  return {
    records: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    byStatus: {} as Record<string, number>,
    attendanceRate: null as number | null,
  };
}

// ---------------------------------------------------------------------------
// Leave types & allowances
// ---------------------------------------------------------------------------

export async function listLeaveTypes(db: Database, includeInactive = false) {
  const rows = await db
    .select()
    .from(lt)
    .where(includeInactive ? undefined : eq(lt.isActive, true))
    .orderBy(asc(lt.name));
  return rows;
}

async function requireLeaveType(db: Database, id: string) {
  const [row] = await db.select().from(lt).where(eq(lt.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Leave type', id);
  return row;
}

type LeaveTypeInput = {
  name?: string;
  color?: string | null;
  isPaid?: boolean;
  requiresApproval?: boolean;
  defaultAllowanceDays?: number | null;
  overAllowance?: 'allow' | 'block';
  isActive?: boolean;
};

export async function createLeaveType(db: Database, input: LeaveTypeInput & { name: string }) {
  const [row] = await db.insert(lt).values({ id: generateId('hrlvt'), ...input }).returning();
  return row!;
}

export async function updateLeaveType(db: Database, id: string, input: LeaveTypeInput) {
  await requireLeaveType(db, id);
  const [row] = await db.update(lt).set({ ...input, updatedAt: new Date() }).where(eq(lt.id, id)).returning();
  return row!;
}

/** Leave types with history are archived (inactive), not deleted. */
export async function deleteLeaveType(db: Database, id: string) {
  await requireLeaveType(db, id);
  const [used] = await db.select({ id: lr.id }).from(lr).where(eq(lr.leaveTypeId, id)).limit(1);
  if (used) {
    await db.update(lt).set({ isActive: false, updatedAt: new Date() }).where(eq(lt.id, id));
    return { archived: true };
  }
  await db.delete(la).where(eq(la.leaveTypeId, id));
  await db.delete(lt).where(eq(lt.id, id));
  return { archived: false };
}

/**
 * Seed annual, sick and unpaid leave for a new workspace.
 * The rows have fixed ids and the insert skips ids that exist, so requests
 * racing on a fresh workspace (both probes see nothing) still seed one set.
 */
export async function ensureDefaultLeaveTypes(db: Database) {
  const [existing] = await db.select({ id: lt.id }).from(lt).limit(1);
  if (existing) return;
  await db.insert(lt).values([
    { id: 'hrlvt_default_annual', name: 'Annual leave', color: '#3b82f6', isPaid: true, requiresApproval: true, defaultAllowanceDays: 20 },
    { id: 'hrlvt_default_sick', name: 'Sick leave', color: '#ef4444', isPaid: true, requiresApproval: false, defaultAllowanceDays: null },
    { id: 'hrlvt_default_unpaid', name: 'Unpaid leave', color: '#6b7280', isPaid: false, requiresApproval: true, defaultAllowanceDays: null },
  ]).onConflictDoNothing();
}

export async function setAllowance(
  db: Database,
  input: { employeeId: string; leaveTypeId: string; year: number; days: number },
) {
  await requireEmployee(db, input.employeeId);
  await requireLeaveType(db, input.leaveTypeId);
  const [existing] = await db
    .select({ id: la.id })
    .from(la)
    .where(and(eq(la.employeeId, input.employeeId), eq(la.leaveTypeId, input.leaveTypeId), eq(la.year, input.year)))
    .limit(1);
  if (existing) {
    const [row] = await db.update(la).set({ days: input.days, updatedAt: new Date() }).where(eq(la.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db.insert(la).values({ id: generateId('hrlva'), ...input }).returning();
  return row!;
}

/**
 * Per leave type: allowance, approved + pending days this year, remaining.
 * The allowance is the employee's override for the year, else the type's
 * default pro-rated to the part of the year they are employed (someone
 * starting in October gets a quarter of it), rounded to half days.
 */
export async function leaveBalances(db: Database, employeeId: string, year: number) {
  const employee = await requireEmployee(db, employeeId);
  const share = employedShareOfYear(year, employee.startDate, employee.endDate);
  const [types, allowances, usage] = await Promise.all([
    listLeaveTypes(db),
    db.select().from(la).where(and(eq(la.employeeId, employeeId), eq(la.year, year))),
    db
      .select({
        leaveTypeId: lr.leaveTypeId,
        status: lr.status,
        days: sql<number>`coalesce(sum(${lr.days}), 0)`,
      })
      .from(lr)
      .where(
        and(
          eq(lr.employeeId, employeeId),
          inArray(lr.status, ['approved', 'pending']),
          sql`extract(year from ${lr.startDate}) = ${year}`,
        ),
      )
      .groupBy(lr.leaveTypeId, lr.status),
  ]);
  const override = new Map(allowances.map((a) => [a.leaveTypeId, a.days]));
  return types.map((type) => {
    const explicit = override.get(type.id);
    const fullAllowance = explicit ?? type.defaultAllowanceDays ?? null;
    const prorated = explicit === undefined && fullAllowance !== null && share < 1;
    const allowance = prorated ? Math.round(fullAllowance * share * 2) / 2 : fullAllowance;
    const used = Number(usage.find((u) => u.leaveTypeId === type.id && u.status === 'approved')?.days ?? 0);
    const pending = Number(usage.find((u) => u.leaveTypeId === type.id && u.status === 'pending')?.days ?? 0);
    return {
      leaveTypeId: type.id,
      name: type.name,
      color: type.color,
      isPaid: type.isPaid,
      overAllowance: type.overAllowance,
      allowance,
      fullAllowance,
      prorated,
      used,
      pending,
      remaining: allowance === null ? null : Math.round((allowance - used) * 10) / 10,
    };
  });
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

/**
 * For a leave type set to `block`: refuse `days` that do not fit in what is
 * left of the employee's allowance for the year the leave starts in.
 * `pendingCounts` is true when filing a request (other pending requests are
 * already promised) and false when approving one (the request being approved
 * is itself pending). Types set to `allow`, and unlimited ones, pass.
 */
async function assertWithinAllowance(
  db: Database,
  request: { employeeId: string; leaveTypeId: string; startDate: string; days: number },
  pendingCounts: boolean,
) {
  const balance = (await leaveBalances(db, request.employeeId, yearOf(request.startDate))).find(
    (b) => b.leaveTypeId === request.leaveTypeId,
  );
  if (!balance || balance.overAllowance !== 'block' || balance.remaining === null) return;
  const available = Math.round((balance.remaining - (pendingCounts ? balance.pending : 0)) * 10) / 10;
  if (request.days > available) {
    throw new HrConflictError(
      `This request is ${request.days} days, but only ${Math.max(available, 0)} days of ${balance.name} are left, and ${balance.name} cannot go over the allowance`,
    );
  }
}

export async function requireLeaveRequest(db: Database, id: string) {
  const [row] = await db.select().from(lr).where(eq(lr.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Leave request', id);
  return row;
}

export async function listLeaveRequests(
  db: Database,
  filters: { employeeId?: string; status?: string; from?: string; to?: string; employeeIds?: string[] },
) {
  const conditions: SQL[] = [isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(lr.employeeId, filters.employeeId));
  if (filters.employeeIds) {
    if (filters.employeeIds.length === 0) return [];
    conditions.push(inArray(lr.employeeId, filters.employeeIds));
  }
  if (filters.status) conditions.push(inArray(lr.status, filters.status.split(',')));
  if (filters.from) conditions.push(gte(lr.endDate, filters.from));
  if (filters.to) conditions.push(lte(lr.startDate, filters.to));
  const rows = await db
    .select({
      request: lr,
      ...employeeNameColumns,
      leaveTypeName: lt.name,
      leaveTypeColor: lt.color,
    })
    .from(lr)
    .innerJoin(emp, eq(emp.id, lr.employeeId))
    .leftJoin(lt, eq(lt.id, lr.leaveTypeId))
    .where(and(...conditions))
    .orderBy(desc(lr.startDate))
    .limit(1000);
  const reviewers = await memberNames(db, rows.map((r) => r.request.reviewedBy));
  return rows.map((r) => ({
    ...r.request,
    employeeName: employeeName(r),
    leaveTypeName: r.leaveTypeName,
    leaveTypeColor: r.leaveTypeColor,
    reviewedByName: r.request.reviewedBy ? reviewers.get(r.request.reviewedBy) ?? null : null,
  }));
}

export async function createLeaveRequest(
  db: Database,
  input: { employeeId: string; leaveTypeId: string; startDate: string; endDate: string; days?: number; reason?: string | null },
  requestedBy: string,
) {
  assertDateOrder(input.startDate, input.endDate, 'Leave');
  if (yearOf(input.endDate) - yearOf(input.startDate) > 1) {
    throw new HrValidationError('Split leave that spans more than one year into separate requests');
  }
  await requireEmployee(db, input.employeeId);
  const type = await requireLeaveType(db, input.leaveTypeId);
  if (!type.isActive) throw new HrValidationError('This leave type is no longer available');

  const [overlap] = await db
    .select({ id: lr.id })
    .from(lr)
    .where(
      and(
        eq(lr.employeeId, input.employeeId),
        inArray(lr.status, ['pending', 'approved']),
        lte(lr.startDate, input.endDate),
        gte(lr.endDate, input.startDate),
      ),
    )
    .limit(1);
  if (overlap) throw new HrConflictError('This overlaps another leave request');

  const days = input.days ?? workingDaysBetween(input.startDate, input.endDate);
  if (days <= 0) throw new HrValidationError('The selected dates contain no working days');
  await assertWithinAllowance(db, { ...input, days }, true);

  const autoApprove = !type.requiresApproval;
  const now = new Date();
  const [row] = await db
    .insert(lr)
    .values({
      id: generateId('hrlvr'),
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      days,
      reason: input.reason ?? null,
      status: autoApprove ? 'approved' : 'pending',
      requestedBy,
      reviewedAt: autoApprove ? now : null,
    })
    .returning();
  return row!;
}

export async function reviewLeaveRequest(
  db: Database,
  id: string,
  input: { decision: 'approved' | 'rejected'; note?: string | null },
  reviewedBy: string,
) {
  const existing = await requireLeaveRequest(db, id);
  if (existing.status !== 'pending') {
    throw new HrConflictError(`This request is already ${existing.status}`);
  }
  if (input.decision === 'approved') await assertWithinAllowance(db, existing, false);
  const [row] = await db
    .update(lr)
    .set({ status: input.decision, reviewNote: input.note ?? null, reviewedBy, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(lr.id, id))
    .returning();
  return row!;
}

export async function cancelLeaveRequest(db: Database, id: string, onlyEmployeeId?: string) {
  const existing = await requireLeaveRequest(db, id);
  if (onlyEmployeeId && existing.employeeId !== onlyEmployeeId) throw new HrNotFoundError('Leave request', id);
  if (existing.status === 'cancelled' || existing.status === 'rejected') {
    throw new HrConflictError(`This request is already ${existing.status}`);
  }
  if (onlyEmployeeId && existing.status === 'approved' && existing.startDate <= todayIso()) {
    throw new HrConflictError('Leave that has started can only be cancelled by HR');
  }
  const [row] = await db
    .update(lr)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(lr.id, id))
    .returning();
  return row!;
}

export async function deleteLeaveRequest(db: Database, id: string) {
  await requireLeaveRequest(db, id);
  await db.delete(lr).where(eq(lr.id, id));
}

/** Who is off on a given day (approved leave covering it). */
export async function onLeaveOn(db: Database, date: string) {
  const rows = await db
    .select({ employeeId: lr.employeeId, ...employeeNameColumns, leaveTypeName: lt.name, endDate: lr.endDate })
    .from(lr)
    .innerJoin(emp, eq(emp.id, lr.employeeId))
    .leftJoin(lt, eq(lt.id, lr.leaveTypeId))
    .where(and(eq(lr.status, 'approved'), lte(lr.startDate, date), gte(lr.endDate, date), isNull(emp.deletedAt), ne(emp.status, 'terminated')));
  return rows.map((r) => ({ employeeId: r.employeeId, employeeName: employeeName(r), leaveTypeName: r.leaveTypeName, endDate: r.endDate }));
}

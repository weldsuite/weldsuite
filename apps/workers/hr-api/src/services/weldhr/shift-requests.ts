/**
 * Shift requests: an employee asking to work a shift, from the WeldHR app.
 *
 * A manager approves or rejects it. Approving puts the shift on the rooster
 * through `createShift` (so its overlap and length checks apply) and links the
 * new shift to the request. Only a request that is still waiting can be
 * reviewed or withdrawn; an approved one is a shift, changed on the rooster.
 */

import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { displayNameOf, requireEmployee } from './employees';
import { HrConflictError, HrNotFoundError, HrValidationError, memberNames } from './shared';
import { assertNoOverlappingShift, assertShiftWindow, createShift, deleteShift } from './time';

const sr = schema.hrShiftRequests;
const emp = schema.hrEmployees;

type ShiftRequestRow = typeof sr.$inferSelect;

export async function requireShiftRequest(db: Database, id: string) {
  const [row] = await db.select().from(sr).where(eq(sr.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Shift request', id);
  return row;
}

/** Requests with who asked and who reviewed them, latest shift first. `from`/`to` are the days the shifts start on. */
export async function listShiftRequests(
  db: Database,
  filters: { id?: string; employeeId?: string; status?: string; from?: string; to?: string },
) {
  const conditions: SQL[] = [isNull(emp.deletedAt)];
  if (filters.id) conditions.push(eq(sr.id, filters.id));
  if (filters.employeeId) conditions.push(eq(sr.employeeId, filters.employeeId));
  if (filters.status) conditions.push(inArray(sr.status, filters.status.split(',')));
  if (filters.from) conditions.push(gte(sr.startsAt, new Date(`${filters.from}T00:00:00Z`)));
  if (filters.to) conditions.push(lte(sr.startsAt, new Date(`${filters.to}T23:59:59Z`)));
  const rows = await db
    .select({
      request: sr,
      employeeFirstName: emp.firstName,
      employeeLastName: emp.lastName,
      employeePreferredName: emp.preferredName,
    })
    .from(sr)
    .innerJoin(emp, eq(emp.id, sr.employeeId))
    .where(and(...conditions))
    .orderBy(desc(sr.startsAt))
    .limit(1000);
  const reviewers = await memberNames(db, rows.map((r) => r.request.reviewedBy));
  return rows.map((r) => ({
    ...r.request,
    employeeName: displayNameOf({
      firstName: r.employeeFirstName,
      lastName: r.employeeLastName,
      preferredName: r.employeePreferredName,
    }),
    reviewedByName: r.request.reviewedBy ? reviewers.get(r.request.reviewedBy) ?? null : null,
  }));
}

/** One request with names, as the list returns it. */
export async function shiftRequestWithNames(db: Database, id: string) {
  const [row] = await listShiftRequests(db, { id });
  if (!row) throw new HrNotFoundError('Shift request', id);
  return row;
}

/** What the employee sees of their own request. */
export function toSelfShiftRequest(row: ShiftRequestRow & { reviewedByName?: string | null }) {
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    workType: row.workType,
    note: row.note,
    status: row.status,
    reviewedAt: row.reviewedAt,
    reviewedByName: row.reviewedByName ?? null,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt,
  };
}

/**
 * An employee asks to work from `startsAt` to `endsAt`. It has to be ahead,
 * fit the same window as a shift, and not overlap one of their shifts or a
 * request still waiting.
 */
export async function requestShift(
  db: Database,
  employeeId: string,
  input: { startsAt: string; endsAt: string; workType?: string | null; note?: string | null },
  requestedBy: string,
  now = new Date(),
) {
  await requireEmployee(db, employeeId);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  assertShiftWindow(startsAt, endsAt);
  if (startsAt <= now) throw new HrValidationError('Ask for a shift that has not started yet');
  await assertNoOverlappingShift(db, employeeId, startsAt, endsAt, { message: 'You already have a shift at this time' });
  const [waiting] = await db
    .select({ id: sr.id })
    .from(sr)
    .where(and(eq(sr.employeeId, employeeId), eq(sr.status, 'pending'), lt(sr.startsAt, endsAt), gt(sr.endsAt, startsAt)))
    .limit(1);
  if (waiting) throw new HrConflictError('You already asked for a shift at this time');

  const [row] = await db
    .insert(sr)
    .values({
      id: generateId('hrsrq'),
      employeeId,
      startsAt,
      endsAt,
      workType: input.workType?.trim() || null,
      note: input.note?.trim() || null,
      status: 'pending',
      requestedBy,
    })
    .returning();
  return row!;
}

/** A manager's answer. Approving creates the shift; a clash with a shift already on the rooster is a 409. */
export async function reviewShiftRequest(
  db: Database,
  id: string,
  input: { decision: 'approved' | 'rejected'; note?: string | null },
  reviewedBy: string,
) {
  const existing = await requireShiftRequest(db, id);
  if (existing.status !== 'pending') throw new HrConflictError(`This request is already ${existing.status}`);

  const shift =
    input.decision === 'approved'
      ? await createShift(
          db,
          {
            employeeId: existing.employeeId,
            startsAt: existing.startsAt.toISOString(),
            endsAt: existing.endsAt.toISOString(),
            workType: existing.workType,
          },
          reviewedBy,
        )
      : null;

  // Only while it is still waiting: two managers answering at once get one shift, not two.
  const [row] = await db
    .update(sr)
    .set({
      status: input.decision,
      shiftId: shift?.id ?? null,
      reviewNote: input.note?.trim() || null,
      reviewedBy,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(sr.id, id), eq(sr.status, 'pending')))
    .returning();
  if (!row) {
    if (shift) await deleteShift(db, shift.id);
    throw new HrConflictError('This request was answered in the meantime');
  }
  return row;
}

/** The employee withdraws a request that is still waiting. */
export async function cancelShiftRequest(db: Database, id: string, employeeId: string) {
  const existing = await requireShiftRequest(db, id);
  if (existing.employeeId !== employeeId) throw new HrNotFoundError('Shift request', id);
  if (existing.status !== 'pending') throw new HrConflictError(`This request is already ${existing.status}`);
  const [row] = await db
    .update(sr)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(sr.id, id), eq(sr.status, 'pending')))
    .returning();
  if (!row) throw new HrConflictError('This request was answered in the meantime');
  return row;
}

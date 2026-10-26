/**
 * Shift requests: an employee asking to work a shift, from the WeldHR app.
 *
 * A manager approves or rejects it. Approving puts the shift on the rooster
 * through `createShift` (so its overlap and length checks apply) and links the
 * new shift to the request. Only a request that is still waiting can be
 * reviewed or withdrawn; an approved one is a shift, changed on the rooster.
 */

import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { displayNameOf, requireEmployee } from './employees';
import { HrConflictError, HrNotFoundError, HrValidationError, memberNames } from './shared';
import { assertCanSignUp, assertOpenShiftHasSpot } from './open-shifts';
import { assertNoOverlappingShift, assertShiftBreak, assertShiftWindow, createShift, deleteShift } from './time';

const sr = schema.hrShiftRequests;
const emp = schema.hrEmployees;
const sh = schema.hrShifts;
const os = schema.hrOpenShifts;

type ShiftRequestRow = typeof sr.$inferSelect;
type OpenShiftRow = typeof os.$inferSelect;

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
    openShiftId: row.openShiftId,
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
  input: { startsAt: string; endsAt: string; workType?: string | null; note?: string | null; openShiftId?: string },
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
      openShiftId: input.openShiftId ?? null,
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

/** An employee signs up for an open shift: a shift request with the open shift's times. */
export async function signUpForOpenShift(
  db: Database,
  employeeId: string,
  openShiftId: string,
  input: { note?: string | null },
  requestedBy: string,
  now = new Date(),
) {
  const open = await assertCanSignUp(db, employeeId, openShiftId, now);
  return requestShift(
    db,
    employeeId,
    {
      startsAt: open.startsAt.toISOString(),
      endsAt: open.endsAt.toISOString(),
      workType: open.workType,
      note: input.note,
      openShiftId,
    },
    requestedBy,
    now,
  );
}

/**
 * Take a spot on an open shift for a sign-up: put its shift on the rooster
 * (client, break and notes copied from the open shift) and approve it, in one
 * transaction that only approves while a spot is left. The first statement
 * locks the open shift's row, so a second manager approving at the same time
 * waits for this one to commit, and then counts the spots again and finds the
 * one taken. The earlier approval keeps the spot; the later one gets the 409.
 * `open` is the open shift as read before; the count inside the transaction is
 * what decides.
 */
export async function claimOpenShiftSpot(
  db: Database,
  request: ShiftRequestRow,
  open: OpenShiftRow,
  note: string | null,
  reviewedBy: string,
) {
  const breakStartsAt = open.breakStartsAt ?? null;
  const breakEndsAt = open.breakEndsAt ?? null;
  assertShiftWindow(request.startsAt, request.endsAt);
  assertShiftBreak(request.startsAt, request.endsAt, breakStartsAt, breakEndsAt);
  await assertNoOverlappingShift(db, request.employeeId, request.startsAt, request.endsAt);

  const shiftId = generateId('hrshf');
  const now = new Date();
  const spotLeft = sql`(
    select count(*) from hr_shift_requests r join hr_shifts s on s.id = r.shift_id
    where r.open_shift_id = ${open.id} and r.status = 'approved'
  ) < (select o.spots from hr_open_shifts o where o.id = ${open.id} and o.status = 'open')`;
  await atomically(db, (h) => [
    // The lock: touching the row holds it until commit.
    h.update(os).set({ updatedAt: now }).where(eq(os.id, open.id)),
    h.insert(sh).values({
      id: shiftId,
      employeeId: request.employeeId,
      companyId: open.companyId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      workType: request.workType,
      breakStartsAt,
      breakEndsAt,
      notes: open.notes,
      createdBy: reviewedBy,
    }),
    h
      .update(sr)
      .set({ status: 'approved', shiftId, reviewNote: note, reviewedBy, reviewedAt: now, updatedAt: now })
      .where(and(eq(sr.id, request.id), eq(sr.status, 'pending'), spotLeft)),
    // No spot (or answered by someone else): the shift goes again.
    h
      .delete(sh)
      .where(and(eq(sh.id, shiftId), sql`not exists (select 1 from hr_shift_requests where id = ${request.id} and shift_id = ${shiftId})`)),
  ]);

  const after = await requireShiftRequest(db, request.id);
  if (after.shiftId === shiftId) return after;
  if (after.status !== 'pending') throw new HrConflictError('This request was answered in the meantime');
  throw new HrConflictError('All spots on this shift are filled');
}

/**
 * A manager's answer. Approving creates the shift; a clash with a shift already
 * on the rooster is a 409, and so is a sign-up for an open shift that is full.
 */
export async function reviewShiftRequest(
  db: Database,
  id: string,
  input: { decision: 'approved' | 'rejected'; note?: string | null },
  reviewedBy: string,
) {
  const existing = await requireShiftRequest(db, id);
  if (existing.status !== 'pending') throw new HrConflictError(`This request is already ${existing.status}`);

  if (input.decision === 'approved' && existing.openShiftId) {
    // A quick refusal when it is already full or withdrawn; the claim itself decides.
    const open = await assertOpenShiftHasSpot(db, existing.openShiftId);
    return claimOpenShiftSpot(db, existing, open, input.note?.trim() || null, reviewedBy);
  }

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

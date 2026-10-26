/**
 * Open shifts: shifts nobody is on yet, posted for employees who want to work.
 *
 * An employee signs up with a shift request that points at the open shift
 * (`hr_shift_requests.open_shift_id`, times copied). A manager answers it like
 * any shift request; approving puts a shift on that employee's rooster (see
 * shift-requests.ts). A spot is taken by an approved request whose shift still
 * exists, so deleting that shift from the rooster frees the spot again. When
 * the last spot is taken, the requests still waiting are turned down.
 */

import { and, asc, eq, gt, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { departmentLineage, requireEmployee } from './employees';
import { HrConflictError, HrNotFoundError, HrValidationError, companyNames } from './shared';
import { assertShiftBreak, assertShiftWindow } from './time';

const os = schema.hrOpenShifts;
const sr = schema.hrShiftRequests;
const sh = schema.hrShifts;
const dep = schema.hrDepartments;

type OpenShiftRow = typeof os.$inferSelect;

export const OPEN_SHIFT_FULL_NOTE = 'All spots on this shift were filled';
export const OPEN_SHIFT_WITHDRAWN_NOTE = 'This open shift was withdrawn';

export async function requireOpenShift(db: Database, id: string) {
  const [row] = await db.select().from(os).where(eq(os.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Open shift', id);
  return row;
}

/** Per open shift: spots taken (approved, shift still on the rooster) and sign-ups waiting. */
export async function openShiftCounts(db: Database, ids: string[]) {
  const out = new Map<string, { filled: number; pending: number }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      openShiftId: sr.openShiftId,
      filled: sql<number>`count(*) filter (where ${sr.status} = 'approved' and ${sh.id} is not null)`,
      pending: sql<number>`count(*) filter (where ${sr.status} = 'pending')`,
    })
    .from(sr)
    .leftJoin(sh, eq(sh.id, sr.shiftId))
    .where(inArray(sr.openShiftId, ids))
    .groupBy(sr.openShiftId);
  for (const row of rows) {
    if (row.openShiftId) out.set(row.openShiftId, { filled: Number(row.filled), pending: Number(row.pending) });
  }
  return out;
}

async function departmentNames(db: Database, ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await db.select({ id: dep.id, name: dep.name }).from(dep).where(inArray(dep.id, unique));
  for (const row of rows) out.set(row.id, row.name);
  return out;
}

/** Open shifts with their names and counts, as the back office lists them. */
async function withDetails(db: Database, rows: OpenShiftRow[]) {
  const ids = rows.map((r) => r.id);
  const [counts, companies, departments] = await Promise.all([
    openShiftCounts(db, ids),
    companyNames(db, rows.map((r) => r.companyId)),
    departmentNames(db, rows.map((r) => r.departmentId)),
  ]);
  return rows.map((row) => {
    const count = counts.get(row.id) ?? { filled: 0, pending: 0 };
    return {
      ...row,
      companyName: row.companyId ? companies.get(row.companyId) ?? null : null,
      departmentName: row.departmentId ? departments.get(row.departmentId) ?? null : null,
      filled: count.filled,
      pending: count.pending,
      spotsLeft: Math.max(row.spots - count.filled, 0),
    };
  });
}

/** `from`/`to` are the days the shifts start on; `status` is `open`, `cancelled` or both (comma separated). */
export async function listOpenShifts(
  db: Database,
  filters: { id?: string; from?: string; to?: string; status?: string } = {},
) {
  const conditions: SQL[] = [];
  if (filters.id) conditions.push(eq(os.id, filters.id));
  if (filters.from) conditions.push(gte(os.startsAt, new Date(`${filters.from}T00:00:00Z`)));
  if (filters.to) conditions.push(lte(os.startsAt, new Date(`${filters.to}T23:59:59Z`)));
  if (filters.status) conditions.push(inArray(os.status, filters.status.split(',')));
  const rows = await db
    .select()
    .from(os)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(os.startsAt))
    .limit(1000);
  return withDetails(db, rows);
}

export async function openShiftWithDetails(db: Database, id: string) {
  const [row] = await listOpenShifts(db, { id });
  if (!row) throw new HrNotFoundError('Open shift', id);
  return row;
}

interface OpenShiftInput {
  companyId?: string | null;
  departmentId?: string | null;
  startsAt?: string;
  endsAt?: string;
  workType?: string | null;
  breakStartsAt?: string | null;
  breakEndsAt?: string | null;
  notes?: string | null;
  spots?: number;
}

async function assertDepartment(db: Database, departmentId: string | null | undefined) {
  if (!departmentId) return;
  const [row] = await db.select({ id: dep.id }).from(dep).where(eq(dep.id, departmentId)).limit(1);
  if (!row) throw new HrNotFoundError('Department', departmentId);
}

function instant(value: string | null | undefined, existing: Date | null): Date | null {
  if (value === undefined) return existing;
  return value ? new Date(value) : null;
}

export async function createOpenShift(
  db: Database,
  input: OpenShiftInput & { startsAt: string; endsAt: string },
  createdBy: string,
  now = new Date(),
) {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  assertShiftWindow(startsAt, endsAt);
  if (endsAt <= now) throw new HrValidationError('An open shift has to end in the future');
  const breakStartsAt = instant(input.breakStartsAt, null);
  const breakEndsAt = instant(input.breakEndsAt, null);
  assertShiftBreak(startsAt, endsAt, breakStartsAt, breakEndsAt);
  await assertDepartment(db, input.departmentId);
  const [row] = await db
    .insert(os)
    .values({
      id: generateId('hrosh'),
      companyId: input.companyId ?? null,
      departmentId: input.departmentId ?? null,
      startsAt,
      endsAt,
      workType: input.workType?.trim() || null,
      breakStartsAt,
      breakEndsAt,
      notes: input.notes?.trim() || null,
      spots: input.spots ?? 1,
      status: 'open',
      createdBy,
    })
    .returning();
  return row!;
}

/**
 * Change an open shift. Its times are fixed once someone is on it (move their
 * shift on the rooster instead), and the spots cannot drop below those taken.
 * Sign-ups still waiting move along with new times.
 */
export async function updateOpenShift(db: Database, id: string, input: OpenShiftInput) {
  const existing = await requireOpenShift(db, id);
  if (existing.status === 'cancelled') throw new HrConflictError('This open shift was withdrawn');
  const startsAt = input.startsAt ? new Date(input.startsAt) : existing.startsAt;
  const endsAt = input.endsAt ? new Date(input.endsAt) : existing.endsAt;
  assertShiftWindow(startsAt, endsAt);
  const breakStartsAt = instant(input.breakStartsAt, existing.breakStartsAt);
  const breakEndsAt = instant(input.breakEndsAt, existing.breakEndsAt);
  assertShiftBreak(startsAt, endsAt, breakStartsAt, breakEndsAt);
  if (input.departmentId !== undefined) await assertDepartment(db, input.departmentId);

  const { filled } = (await openShiftCounts(db, [id])).get(id) ?? { filled: 0 };
  const timesMoved = startsAt.getTime() !== existing.startsAt.getTime() || endsAt.getTime() !== existing.endsAt.getTime();
  if (timesMoved && filled > 0) {
    throw new HrConflictError('Someone is already on this shift. Change their shift on the rooster instead.');
  }
  if (input.spots !== undefined && input.spots < filled) {
    throw new HrValidationError(`${filled} people are already on this shift, so it needs at least ${filled} spots`);
  }

  const [row] = await db
    .update(os)
    .set({
      companyId: input.companyId,
      departmentId: input.departmentId,
      workType: input.workType === undefined ? undefined : input.workType?.trim() || null,
      notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
      spots: input.spots,
      startsAt,
      endsAt,
      breakStartsAt,
      breakEndsAt,
      updatedAt: new Date(),
    })
    .where(eq(os.id, id))
    .returning();
  if (timesMoved) {
    await db
      .update(sr)
      .set({ startsAt, endsAt, updatedAt: new Date() })
      .where(and(eq(sr.openShiftId, id), eq(sr.status, 'pending')));
  }
  return row!;
}

/** Turn down the sign-ups still waiting on an open shift; returns them so the caller can tell their employees. */
async function closePendingRequests(db: Database, openShiftId: string, status: 'rejected' | 'cancelled', note: string, by: string) {
  const now = new Date();
  return db
    .update(sr)
    .set({ status, reviewNote: note, reviewedBy: by, reviewedAt: now, updatedAt: now })
    .where(and(eq(sr.openShiftId, openShiftId), eq(sr.status, 'pending')))
    .returning({ id: sr.id, employeeId: sr.employeeId, status: sr.status });
}

/**
 * Withdraw an open shift. Sign-ups still waiting are cancelled; people already
 * approved keep their shift (remove it from the rooster to undo that).
 */
export async function cancelOpenShift(db: Database, id: string, by: string) {
  const existing = await requireOpenShift(db, id);
  if (existing.status === 'cancelled') throw new HrConflictError('This open shift was already withdrawn');
  const [row] = await db
    .update(os)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(os.id, id))
    .returning();
  const closed = await closePendingRequests(db, id, 'cancelled', OPEN_SHIFT_WITHDRAWN_NOTE, by);
  return { row: row!, closed };
}

/** After an approval: once every spot is taken, turn down the sign-ups still waiting. */
export async function settleOpenShift(db: Database, openShiftId: string, by: string) {
  const shift = await requireOpenShift(db, openShiftId);
  const { filled } = (await openShiftCounts(db, [openShiftId])).get(openShiftId) ?? { filled: 0 };
  if (filled < shift.spots) return [];
  return closePendingRequests(db, openShiftId, 'rejected', OPEN_SHIFT_FULL_NOTE, by);
}

/**
 * Before approving a sign-up: the open shift is still open and has a spot.
 * Returns what the new shift copies from it.
 */
export async function assertOpenShiftHasSpot(db: Database, openShiftId: string) {
  const shift = await requireOpenShift(db, openShiftId);
  if (shift.status === 'cancelled') throw new HrConflictError('This open shift was withdrawn');
  const { filled } = (await openShiftCounts(db, [openShiftId])).get(openShiftId) ?? { filled: 0 };
  if (filled >= shift.spots) throw new HrConflictError('All spots on this shift are filled');
  return shift;
}

/** Whether approving one more would take the open shift past its spots (two managers approving at once). */
export async function openShiftOverfilled(db: Database, openShiftId: string) {
  const shift = await requireOpenShift(db, openShiftId);
  const { filled } = (await openShiftCounts(db, [openShiftId])).get(openShiftId) ?? { filled: 0 };
  return filled > shift.spots;
}

// ---------------------------------------------------------------------------
// Employee side
// ---------------------------------------------------------------------------

/** Whether this open shift is meant for the employee: for everyone, or for their department or one above it. */
function visibleTo(shift: Pick<OpenShiftRow, 'departmentId'>, lineage: Set<string>) {
  return !shift.departmentId || lineage.has(shift.departmentId);
}

/**
 * Open shifts the employee can sign up for, and those they already did:
 * upcoming, not withdrawn, meant for them, with a spot left (or their own
 * sign-up on it). `myRequest` is their latest sign-up for it.
 */
export async function openShiftsForEmployee(db: Database, employeeId: string, now = new Date()) {
  const employee = await requireEmployee(db, employeeId);
  const lineage = await departmentLineage(db, employee.departmentId);
  const rows = (
    await db
      .select()
      .from(os)
      .where(and(eq(os.status, 'open'), gt(os.startsAt, now)))
      .orderBy(asc(os.startsAt))
      .limit(500)
  ).filter((row) => visibleTo(row, lineage));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [detailed, mine] = await Promise.all([
    withDetails(db, rows),
    db
      .select({ id: sr.id, openShiftId: sr.openShiftId, status: sr.status, reviewNote: sr.reviewNote, createdAt: sr.createdAt })
      .from(sr)
      .where(and(eq(sr.employeeId, employeeId), inArray(sr.openShiftId, ids)))
      .orderBy(asc(sr.createdAt)),
  ]);
  // Ordered oldest first, so the map keeps the latest sign-up per open shift.
  const myRequest = new Map(mine.map((r) => [r.openShiftId!, { id: r.id, status: r.status, reviewNote: r.reviewNote }]));
  return detailed
    .map((row) => ({
      id: row.id,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      workType: row.workType,
      breakStartsAt: row.breakStartsAt,
      breakEndsAt: row.breakEndsAt,
      notes: row.notes,
      companyName: row.companyName,
      departmentName: row.departmentName,
      spots: row.spots,
      spotsLeft: row.spotsLeft,
      myRequest: myRequest.get(row.id) ?? null,
    }))
    .filter((row) => row.spotsLeft > 0 || row.myRequest);
}

/** Checks before an employee signs up; returns the open shift to copy the times from. */
export async function assertCanSignUp(db: Database, employeeId: string, openShiftId: string, now = new Date()) {
  const employee = await requireEmployee(db, employeeId);
  const shift = await requireOpenShift(db, openShiftId);
  const lineage = await departmentLineage(db, employee.departmentId);
  // A shift meant for another department is not one this employee can know about.
  if (!visibleTo(shift, lineage)) throw new HrNotFoundError('Open shift', openShiftId);
  if (shift.status === 'cancelled') throw new HrConflictError('This open shift was withdrawn');
  if (shift.startsAt <= now) throw new HrValidationError('This shift has already started');
  const [already] = await db
    .select({ status: sr.status })
    .from(sr)
    .where(and(eq(sr.employeeId, employeeId), eq(sr.openShiftId, openShiftId), inArray(sr.status, ['pending', 'approved'])))
    .limit(1);
  if (already) throw new HrConflictError(already.status === 'approved' ? 'You are already on this shift' : 'You already signed up for this shift');
  const { filled } = (await openShiftCounts(db, [openShiftId])).get(openShiftId) ?? { filled: 0 };
  if (filled >= shift.spots) throw new HrConflictError('All spots on this shift are filled');
  return shift;
}

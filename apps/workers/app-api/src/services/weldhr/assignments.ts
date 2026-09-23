/**
 * Employee ↔ client account assignments. A client account is a CRM company.
 *
 * Assignments are ended, not deleted, when someone rolls off an account — the
 * workforce portal's "team over time" and every historical KPI are read
 * through them. Delete exists only to fix a mistake.
 */

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { displayNameOf, requireEmployee } from './employees';
import { HrNotFoundError, assertDateOrder, companyNames, todayIso } from './shared';

const a = schema.hrClientAssignments;

export async function requireCompany(db: Database, companyId: string) {
  const [row] = await db
    .select({ id: schema.companies.id, name: schema.companies.displayName })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), isNull(schema.companies.deletedAt)))
    .limit(1);
  if (!row) throw new HrNotFoundError('Company', companyId);
  return row;
}

export async function requireAssignment(db: Database, id: string) {
  const [row] = await db.select().from(a).where(eq(a.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Assignment', id);
  return row;
}

function isActive(row: { startDate: string; endDate: string | null }, on: string) {
  return row.startDate <= on && (!row.endDate || row.endDate >= on);
}

export async function listAssignments(db: Database, filters: { employeeId?: string; companyId?: string; activeOnly?: boolean }) {
  const today = todayIso();
  const conditions = [];
  if (filters.employeeId) conditions.push(eq(a.employeeId, filters.employeeId));
  if (filters.companyId) conditions.push(eq(a.companyId, filters.companyId));
  if (filters.activeOnly) {
    conditions.push(sql`${a.startDate} <= ${today}`);
    const open = or(isNull(a.endDate), sql`${a.endDate} >= ${today}`);
    if (open) conditions.push(open);
  }
  const rows = await db
    .select({
      assignment: a,
      firstName: schema.hrEmployees.firstName,
      lastName: schema.hrEmployees.lastName,
      preferredName: schema.hrEmployees.preferredName,
      jobTitle: schema.hrEmployees.jobTitle,
      avatarUrl: schema.hrEmployees.avatarUrl,
      employeeStatus: schema.hrEmployees.status,
    })
    .from(a)
    .innerJoin(schema.hrEmployees, eq(schema.hrEmployees.id, a.employeeId))
    .where(and(isNull(schema.hrEmployees.deletedAt), ...conditions))
    .orderBy(desc(a.startDate), asc(schema.hrEmployees.lastName));

  const names = await companyNames(db, rows.map((r) => r.assignment.companyId));
  return rows.map((r) => ({
    ...r.assignment,
    companyName: names.get(r.assignment.companyId) ?? null,
    employeeName: displayNameOf(r),
    employeeJobTitle: r.jobTitle,
    employeeAvatarUrl: r.avatarUrl,
    employeeStatus: r.employeeStatus,
    isActive: isActive(r.assignment, today),
  }));
}

export async function createAssignment(
  db: Database,
  input: {
    employeeId: string;
    companyId: string;
    role?: string | null;
    allocationPercent?: number;
    isPrimary?: boolean;
    startDate: string;
    endDate?: string | null;
    notes?: string | null;
  },
  createdBy: string,
) {
  assertDateOrder(input.startDate, input.endDate, 'Assignment');
  await requireEmployee(db, input.employeeId);
  await requireCompany(db, input.companyId);
  if (input.isPrimary) await clearPrimary(db, input.employeeId);
  const [row] = await db
    .insert(a)
    .values({
      id: generateId('hrasg'),
      ...input,
      allocationPercent: input.allocationPercent ?? 100,
      isPrimary: input.isPrimary ?? false,
      createdBy,
    })
    .returning();
  return row!;
}

export async function updateAssignment(
  db: Database,
  id: string,
  input: {
    role?: string | null;
    allocationPercent?: number;
    isPrimary?: boolean;
    startDate?: string;
    endDate?: string | null;
    notes?: string | null;
  },
) {
  const existing = await requireAssignment(db, id);
  assertDateOrder(
    input.startDate ?? existing.startDate,
    input.endDate !== undefined ? input.endDate : existing.endDate,
    'Assignment',
  );
  if (input.isPrimary) await clearPrimary(db, existing.employeeId, id);
  const [row] = await db.update(a).set({ ...input, updatedAt: new Date() }).where(eq(a.id, id)).returning();
  return row!;
}

export async function deleteAssignment(db: Database, id: string) {
  await requireAssignment(db, id);
  await db.delete(a).where(eq(a.id, id));
}

/** End every open assignment of an employee (offboarding). */
export async function endAssignmentsFor(db: Database, employeeId: string, endDate: string) {
  await db
    .update(a)
    .set({ endDate, updatedAt: new Date() })
    .where(and(eq(a.employeeId, employeeId), or(isNull(a.endDate), sql`${a.endDate} > ${endDate}`)));
}

async function clearPrimary(db: Database, employeeId: string, exceptId?: string) {
  const conditions = [eq(a.employeeId, employeeId), eq(a.isPrimary, true)];
  if (exceptId) conditions.push(sql`${a.id} <> ${exceptId}`);
  await db.update(a).set({ isPrimary: false, updatedAt: new Date() }).where(and(...conditions));
}

/** Client accounts that have (or had) anyone assigned, with live headcount. */
export async function listClientAccounts(db: Database) {
  const today = todayIso();
  const rows = await db
    .select({
      companyId: a.companyId,
      activeCount: sql<number>`count(*) filter (where ${a.startDate} <= ${today} and (${a.endDate} is null or ${a.endDate} >= ${today}))`,
      totalCount: sql<number>`count(distinct ${a.employeeId})`,
      fte: sql<number>`coalesce(sum(${a.allocationPercent}) filter (where ${a.startDate} <= ${today} and (${a.endDate} is null or ${a.endDate} >= ${today})), 0) / 100.0`,
    })
    .from(a)
    .innerJoin(schema.hrEmployees, eq(schema.hrEmployees.id, a.employeeId))
    .where(isNull(schema.hrEmployees.deletedAt))
    .groupBy(a.companyId);
  const names = await companyNames(db, rows.map((r) => r.companyId));
  return rows
    .map((r) => ({
      companyId: r.companyId,
      companyName: names.get(r.companyId) ?? null,
      activeCount: Number(r.activeCount),
      totalCount: Number(r.totalCount),
      fte: Math.round(Number(r.fte) * 100) / 100,
    }))
    .sort((x, y) => (x.companyName ?? '').localeCompare(y.companyName ?? ''));
}

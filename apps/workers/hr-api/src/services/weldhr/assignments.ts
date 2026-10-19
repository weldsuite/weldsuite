/**
 * Employee ↔ client account assignments. A client account is a CRM company.
 *
 * Assignments are ended, not deleted, when someone rolls off an account — the
 * workforce portal's "team over time" and every historical KPI are read
 * through them. Delete exists only to fix a mistake.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { displayNameOf, requireEmployee } from './employees';
import { HrConflictError, HrNotFoundError, assertDateOrder, companyNames, todayIso } from './shared';

const a = schema.hrClientAssignments;

/** A live CRM company. One deleted in WeldCRM gets a readable 404 instead of "Company with ID … not found". */
export async function requireCompany(db: Database, companyId: string) {
  const [row] = await db
    .select({ id: schema.companies.id, name: schema.companies.displayName, deletedAt: schema.companies.deletedAt })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  if (!row) throw new HrNotFoundError('Company', companyId);
  if (row.deletedAt) throw new HrNotFoundError('Company', companyId, `${row.name || 'This company'} was deleted in WeldCRM`);
  return { id: row.id, name: row.name };
}

/** Of these company ids, the ones deleted in WeldCRM. Their assignments are history, never active. */
async function deletedCompanyIds(db: Database, companyIds: string[]) {
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(inArray(schema.companies.id, ids), isNotNull(schema.companies.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

export async function requireAssignment(db: Database, id: string) {
  const [row] = await db.select().from(a).where(eq(a.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Assignment', id);
  return row;
}

function isActive(row: { startDate: string; endDate: string | null }, on: string) {
  return row.startDate <= on && (!row.endDate || row.endDate >= on);
}

/**
 * One assignment per employee per client at a time: change the allocation of
 * the running one, or end it before starting another.
 */
async function assertNoOverlappingAssignment(
  db: Database,
  employeeId: string,
  companyId: string,
  startDate: string,
  endDate: string | null,
  exceptId?: string,
) {
  const conditions: SQL[] = [
    eq(a.employeeId, employeeId),
    eq(a.companyId, companyId),
    or(isNull(a.endDate), sql`${a.endDate} >= ${startDate}`)!,
  ];
  if (endDate) conditions.push(sql`${a.startDate} <= ${endDate}`);
  if (exceptId) conditions.push(sql`${a.id} <> ${exceptId}`);
  const [clash] = await db.select({ id: a.id }).from(a).where(and(...conditions)).limit(1);
  if (clash) throw new HrConflictError('This employee is already assigned to this client for (part of) these dates');
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

  const companyIds = rows.map((r) => r.assignment.companyId);
  const [names, deleted] = await Promise.all([companyNames(db, companyIds), deletedCompanyIds(db, companyIds)]);
  return rows
    .map((r) => {
      const companyDeleted = deleted.has(r.assignment.companyId);
      return {
        ...r.assignment,
        companyName: names.get(r.assignment.companyId) ?? null,
        companyDeleted,
        employeeName: displayNameOf(r),
        employeeJobTitle: r.jobTitle,
        employeeAvatarUrl: r.avatarUrl,
        employeeStatus: r.employeeStatus,
        isActive: !companyDeleted && isActive(r.assignment, today),
      };
    })
    .filter((row) => !filters.activeOnly || row.isActive);
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
  await assertNoOverlappingAssignment(db, input.employeeId, input.companyId, input.startDate, input.endDate ?? null);
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
  const startDate = input.startDate ?? existing.startDate;
  const endDate = input.endDate !== undefined ? input.endDate : existing.endDate;
  assertDateOrder(startDate, endDate, 'Assignment');
  if (input.startDate !== undefined || input.endDate !== undefined) {
    await assertNoOverlappingAssignment(db, existing.employeeId, existing.companyId, startDate, endDate, id);
  }
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
    // A company deleted in WeldCRM is no longer a client account; its assignments stay as history.
    .innerJoin(schema.companies, eq(schema.companies.id, a.companyId))
    .where(and(isNull(schema.hrEmployees.deletedAt), isNull(schema.companies.deletedAt)))
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

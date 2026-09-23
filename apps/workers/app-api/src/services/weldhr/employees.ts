/**
 * WeldHR employees — the directory, the org chart, and the encrypted
 * sensitive block.
 *
 * `sensitive_encrypted` never leaves this file in ciphertext form and never
 * leaves it in plaintext except through `readSensitive`, which the route only
 * calls for `employees:sensitive` holders and which the route audits.
 */

import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type {
  HrEmployee,
  HrEmployeeSensitive,
} from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { HrConflictError, HrNotFoundError, HrValidationError, assertDateOrder, companyNames, todayIso } from './shared';

const t = schema.hrEmployees;

export type PublicEmployee = Omit<HrEmployee, 'sensitiveEncrypted'> & {
  hasSensitive: boolean;
  displayName: string;
};

export type EmployeeListItem = PublicEmployee & {
  departmentName: string | null;
  managerName: string | null;
  clients: Array<{ companyId: string; companyName: string | null; isPrimary: boolean }>;
};

export function displayNameOf(e: Pick<HrEmployee, 'firstName' | 'lastName' | 'preferredName'>): string {
  const first = e.preferredName?.trim() || e.firstName;
  return `${first} ${e.lastName}`.trim();
}

export function toPublicEmployee(row: HrEmployee): PublicEmployee {
  const { sensitiveEncrypted, ...rest } = row;
  return { ...rest, hasSensitive: Boolean(sensitiveEncrypted), displayName: displayNameOf(row) };
}

export async function requireEmployee(db: Database, id: string): Promise<HrEmployee> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  if (!row) throw new HrNotFoundError('Employee', id);
  return row;
}

/** Existing, non-deleted employee ids out of `ids` — used to validate foreign keys cheaply. */
export async function existingEmployeeIds(db: Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(inArray(t.id, ids), isNull(t.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Active assignments (started, not ended) for a set of employees, with company names. */
export async function activeClientsFor(db: Database, employeeIds: string[], on: string = todayIso()) {
  const out = new Map<string, EmployeeListItem['clients']>();
  if (employeeIds.length === 0) return out;
  const a = schema.hrClientAssignments;
  const rows = await db
    .select({ employeeId: a.employeeId, companyId: a.companyId, isPrimary: a.isPrimary })
    .from(a)
    .where(
      and(
        inArray(a.employeeId, employeeIds),
        sql`${a.startDate} <= ${on}`,
        or(isNull(a.endDate), sql`${a.endDate} >= ${on}`),
      ),
    );
  const names = await companyNames(db, rows.map((r) => r.companyId));
  for (const row of rows) {
    const list = out.get(row.employeeId) ?? [];
    list.push({ companyId: row.companyId, companyName: names.get(row.companyId) ?? null, isPrimary: row.isPrimary });
    out.set(row.employeeId, list);
  }
  for (const list of out.values()) list.sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary));
  return out;
}

async function decorate(db: Database, rows: HrEmployee[]): Promise<EmployeeListItem[]> {
  const departmentIds = [...new Set(rows.map((r) => r.departmentId).filter((v): v is string => Boolean(v)))];
  const managerIds = [...new Set(rows.map((r) => r.managerId).filter((v): v is string => Boolean(v)))];

  const [departments, managers, clients] = await Promise.all([
    departmentIds.length
      ? db
          .select({ id: schema.hrDepartments.id, name: schema.hrDepartments.name })
          .from(schema.hrDepartments)
          .where(inArray(schema.hrDepartments.id, departmentIds))
      : Promise.resolve([]),
    managerIds.length
      ? db
          .select({ id: t.id, firstName: t.firstName, lastName: t.lastName, preferredName: t.preferredName })
          .from(t)
          .where(inArray(t.id, managerIds))
      : Promise.resolve([]),
    activeClientsFor(db, rows.map((r) => r.id)),
  ]);
  const departmentName = new Map(departments.map((d) => [d.id, d.name]));
  const managerName = new Map(managers.map((m) => [m.id, displayNameOf(m)]));

  return rows.map((row) => ({
    ...toPublicEmployee(row),
    departmentName: row.departmentId ? departmentName.get(row.departmentId) ?? null : null,
    managerName: row.managerId ? managerName.get(row.managerId) ?? null : null,
    clients: clients.get(row.id) ?? [],
  }));
}

export interface ListEmployeesFilters {
  search?: string;
  status?: string;
  departmentId?: string;
  managerId?: string;
  companyId?: string;
  limit?: number;
  cursor?: string;
}

/** Directory ordered by last name, first name, id; the cursor is the last row's id. */
export async function listEmployees(db: Database, filters: ListEmployeesFilters) {
  const limit = Math.min(filters.limit ?? 50, 200);
  const conditions: SQL[] = [isNull(t.deletedAt)];

  if (filters.search?.trim()) {
    const q = `%${filters.search.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const match = or(
      ilike(t.firstName, q),
      ilike(t.lastName, q),
      ilike(t.preferredName, q),
      ilike(t.email, q),
      ilike(t.employeeNumber, q),
      ilike(t.jobTitle, q),
    );
    if (match) conditions.push(match);
  }
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length) conditions.push(inArray(t.status, statuses));
  }
  if (filters.departmentId) conditions.push(eq(t.departmentId, filters.departmentId));
  if (filters.managerId) conditions.push(eq(t.managerId, filters.managerId));
  if (filters.companyId) {
    const a = schema.hrClientAssignments;
    const today = todayIso();
    conditions.push(
      sql`${t.id} in (select ${a.employeeId} from ${a} where ${a.companyId} = ${filters.companyId}
        and ${a.startDate} <= ${today} and (${a.endDate} is null or ${a.endDate} >= ${today}))`,
    );
  }

  const countWhere = and(...conditions);
  const pageConditions = [...conditions];
  if (filters.cursor) {
    const [cur] = await db
      .select({ lastName: t.lastName, firstName: t.firstName, id: t.id })
      .from(t)
      .where(eq(t.id, filters.cursor))
      .limit(1);
    if (cur) {
      pageConditions.push(
        sql`(${t.lastName}, ${t.firstName}, ${t.id}) > (${cur.lastName}, ${cur.firstName}, ${cur.id})`,
      );
    }
  }

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...pageConditions))
      .orderBy(asc(t.lastName), asc(t.firstName), asc(t.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: await decorate(db, page),
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor: hasMore && page.length ? page[page.length - 1]!.id : null,
  };
}

export async function getEmployeeDetail(db: Database, id: string) {
  const row = await requireEmployee(db, id);
  const [decorated] = await decorate(db, [row]);
  const reports = await db
    .select({ id: t.id, firstName: t.firstName, lastName: t.lastName, preferredName: t.preferredName, jobTitle: t.jobTitle, avatarUrl: t.avatarUrl, status: t.status })
    .from(t)
    .where(and(eq(t.managerId, id), isNull(t.deletedAt)))
    .orderBy(asc(t.lastName), asc(t.firstName));
  return {
    ...decorated!,
    directReports: reports.map((r) => ({ ...r, displayName: displayNameOf(r) })),
  };
}

/** Everyone, flattened, for the org chart. Small by design (ids + names + manager). */
export async function orgChart(db: Database) {
  const rows = await db
    .select({
      id: t.id,
      firstName: t.firstName,
      lastName: t.lastName,
      preferredName: t.preferredName,
      jobTitle: t.jobTitle,
      avatarUrl: t.avatarUrl,
      managerId: t.managerId,
      departmentId: t.departmentId,
      status: t.status,
    })
    .from(t)
    .where(and(isNull(t.deletedAt), sql`${t.status} <> 'terminated'`))
    .orderBy(asc(t.lastName), asc(t.firstName));
  return rows.map((r) => ({ ...r, displayName: displayNameOf(r) }));
}

async function assertEmailFree(db: Database, email: string, exceptId?: string) {
  const [dupe] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(sql`lower(${t.email}) = ${email.toLowerCase()}`, isNull(t.deletedAt)))
    .limit(1);
  if (dupe && dupe.id !== exceptId) {
    throw new HrConflictError('Another employee already uses this email address');
  }
}

async function assertManager(db: Database, managerId: string | null | undefined, selfId?: string) {
  if (!managerId) return;
  if (managerId === selfId) throw new HrValidationError('An employee cannot be their own manager');
  await requireEmployee(db, managerId);
  if (!selfId) return;
  // Walk up from the proposed manager; reaching `selfId` would create a loop.
  let cursor: string | null = managerId;
  for (let depth = 0; cursor && depth < 50; depth += 1) {
    if (cursor === selfId) throw new HrValidationError('That manager reports to this employee');
    const [next] = await db.select({ managerId: t.managerId }).from(t).where(eq(t.id, cursor)).limit(1);
    cursor = next?.managerId ?? null;
  }
}

export type EmployeeWriteInput = {
  employeeNumber?: string | null;
  firstName?: string;
  lastName?: string;
  preferredName?: string | null;
  email?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  pronouns?: string | null;
  jobTitle?: string | null;
  departmentId?: string | null;
  managerId?: string | null;
  userId?: string | null;
  employmentType?: string;
  status?: string;
  startDate?: string | null;
  endDate?: string | null;
  probationEndDate?: string | null;
  location?: string | null;
  timezone?: string | null;
  weeklyHours?: number | null;
  customFields?: Record<string, unknown>;
};

export async function createEmployee(
  db: Database,
  input: EmployeeWriteInput & { firstName: string; lastName: string; email: string },
  opts: { createdBy: string; sensitive?: HrEmployeeSensitive; keyring?: EncryptionKeyring },
): Promise<HrEmployee> {
  assertDateOrder(input.startDate, input.endDate, 'Employment');
  await assertEmailFree(db, input.email);
  await assertManager(db, input.managerId);

  const id = generateId('hremp');
  const sensitiveEncrypted =
    opts.sensitive && opts.keyring ? await encryptSensitive(opts.sensitive, opts.keyring) : null;

  const [row] = await db
    .insert(t)
    .values({
      id,
      ...input,
      email: input.email.trim(),
      employmentType: input.employmentType ?? 'full_time',
      status: input.status ?? 'onboarding',
      sensitiveEncrypted,
      createdBy: opts.createdBy,
    })
    .returning();
  return row!;
}

export async function updateEmployee(db: Database, id: string, input: EmployeeWriteInput): Promise<HrEmployee> {
  const existing = await requireEmployee(db, id);
  assertDateOrder(
    input.startDate !== undefined ? input.startDate : existing.startDate,
    input.endDate !== undefined ? input.endDate : existing.endDate,
    'Employment',
  );
  if (input.email && input.email.toLowerCase() !== existing.email.toLowerCase()) {
    await assertEmailFree(db, input.email, id);
  }
  if (input.managerId !== undefined) await assertManager(db, input.managerId, id);

  const [row] = await db
    .update(t)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(t.id, id))
    .returning();
  return row!;
}

/** Soft delete. Portal access is revoked in the same call so a deleted employee cannot sign in. */
export async function deleteEmployee(db: Database, id: string): Promise<void> {
  await requireEmployee(db, id);
  const now = new Date();
  await db.update(t).set({ deletedAt: now, updatedAt: now }).where(eq(t.id, id));
  await db
    .update(schema.hrPortalAccess)
    .set({ status: 'revoked', updatedAt: now })
    .where(eq(schema.hrPortalAccess.employeeId, id));
}

// ---------------------------------------------------------------------------
// Sensitive block
// ---------------------------------------------------------------------------

async function encryptSensitive(value: HrEmployeeSensitive, keyring: EncryptionKeyring): Promise<string> {
  if (!keyring.v1 && !keyring.v2) {
    throw new HrValidationError('Sensitive employee data cannot be stored: the worker has no encryption key');
  }
  return encryptField(JSON.stringify(value), keyring);
}

export async function readSensitive(
  db: Database,
  id: string,
  keyring: EncryptionKeyring,
): Promise<HrEmployeeSensitive> {
  const row = await requireEmployee(db, id);
  if (!row.sensitiveEncrypted) return {};
  const plaintext = await decryptField(row.sensitiveEncrypted, keyring);
  return JSON.parse(plaintext) as HrEmployeeSensitive;
}

/** Merge `patch` into the stored block. `null` clears a field; `undefined` keeps it. */
export async function writeSensitive(
  db: Database,
  id: string,
  patch: HrEmployeeSensitive,
  keyring: EncryptionKeyring,
): Promise<{ changedFields: string[] }> {
  const current = await readSensitive(db, id, keyring);
  const next: HrEmployeeSensitive = { ...current };
  const changedFields: string[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof HrEmployeeSensitive, unknown]>) {
    if (value === undefined) continue;
    if (JSON.stringify(current[key] ?? null) !== JSON.stringify(value)) changedFields.push(key);
    (next as Record<string, unknown>)[key] = value;
  }
  if (changedFields.length === 0) return { changedFields };

  await db
    .update(t)
    .set({ sensitiveEncrypted: await encryptSensitive(next, keyring), updatedAt: new Date() })
    .where(eq(t.id, id));
  return { changedFields };
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

const d = schema.hrDepartments;

export async function listDepartments(db: Database) {
  const rows = await db.select().from(d).where(isNull(d.deletedAt)).orderBy(asc(d.name));
  const counts = await db
    .select({ departmentId: t.departmentId, count: sql<number>`count(*)` })
    .from(t)
    .where(and(isNull(t.deletedAt), sql`${t.status} <> 'terminated'`))
    .groupBy(t.departmentId);
  const byDepartment = new Map(counts.map((c) => [c.departmentId, Number(c.count)]));
  return rows.map((row) => ({ ...row, employeeCount: byDepartment.get(row.id) ?? 0 }));
}

export async function requireDepartment(db: Database, id: string) {
  const [row] = await db.select().from(d).where(and(eq(d.id, id), isNull(d.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Department', id);
  return row;
}

export async function createDepartment(
  db: Database,
  input: { name: string; description?: string | null; parentId?: string | null; headEmployeeId?: string | null; color?: string | null },
) {
  if (input.parentId) await requireDepartment(db, input.parentId);
  if (input.headEmployeeId) await requireEmployee(db, input.headEmployeeId);
  const [row] = await db.insert(d).values({ id: generateId('hrdep'), ...input }).returning();
  return row!;
}

export async function updateDepartment(
  db: Database,
  id: string,
  input: { name?: string; description?: string | null; parentId?: string | null; headEmployeeId?: string | null; color?: string | null },
) {
  await requireDepartment(db, id);
  if (input.parentId === id) throw new HrValidationError('A department cannot be its own parent');
  if (input.parentId) await requireDepartment(db, input.parentId);
  if (input.headEmployeeId) await requireEmployee(db, input.headEmployeeId);
  const [row] = await db.update(d).set({ ...input, updatedAt: new Date() }).where(eq(d.id, id)).returning();
  return row!;
}

/** Soft delete; employees in it become department-less rather than pointing at a ghost. */
export async function deleteDepartment(db: Database, id: string) {
  await requireDepartment(db, id);
  const now = new Date();
  await db.update(d).set({ deletedAt: now, updatedAt: now }).where(eq(d.id, id));
  await db.update(t).set({ departmentId: null, updatedAt: now }).where(eq(t.departmentId, id));
  await db.update(d).set({ parentId: null, updatedAt: now }).where(eq(d.parentId, id));
}

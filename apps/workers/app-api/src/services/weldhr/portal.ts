/**
 * Workforce portal configuration (back office side): branding, toggles and
 * who may sign in. The public sign-in and data plane live in
 * `routes/public-hr-portal`.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { HrPortalSettings } from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { personAtCompany } from './client-view';
import { displayNameOf, requireEmployee } from './employees';
import { HrNotFoundError, HrValidationError, companyNames } from './shared';

const ps = schema.hrPortalSettings;
const pa = schema.hrPortalAccess;

/** The singleton settings row, created with safe defaults (portal off) on first read. */
export async function loadPortalSettings(db: Database): Promise<HrPortalSettings> {
  const [row] = await db.select().from(ps).limit(1);
  if (row) return row;
  const [created] = await db.insert(ps).values({ id: generateId('hrpst') }).returning();
  return created!;
}

export async function updatePortalSettings(db: Database, input: Partial<Omit<HrPortalSettings, 'id' | 'createdAt' | 'updatedAt'>>) {
  const current = await loadPortalSettings(db);
  const [row] = await db.update(ps).set({ ...input, updatedAt: new Date() }).where(eq(ps.id, current.id)).returning();
  return row!;
}

export async function listPortalAccess(db: Database, filters: { kind?: string; companyId?: string; employeeId?: string } = {}) {
  const conditions = [];
  if (filters.kind) conditions.push(eq(pa.kind, filters.kind));
  if (filters.companyId) conditions.push(eq(pa.companyId, filters.companyId));
  if (filters.employeeId) conditions.push(eq(pa.employeeId, filters.employeeId));
  const rows = await db
    .select()
    .from(pa)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(pa.createdAt));
  const names = await companyNames(db, rows.map((r) => r.companyId));
  return rows.map((r) => ({ ...r, companyName: r.companyId ? names.get(r.companyId) ?? null : null }));
}

export async function requirePortalAccess(db: Database, id: string) {
  const [row] = await db.select().from(pa).where(eq(pa.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Portal access', id);
  return row;
}

/**
 * Grant portal access. Re-inviting someone whose access was revoked flips the
 * existing row back to `invited` instead of adding a second one.
 */
export async function invitePortalAccess(
  db: Database,
  input: { kind: 'employee'; employeeId: string } | { kind: 'client'; personId: string; companyId: string },
  invitedBy: string,
) {
  let email: string;
  let displayName: string;
  let lookup;

  if (input.kind === 'employee') {
    const employee = await requireEmployee(db, input.employeeId);
    if (employee.status === 'terminated') {
      throw new HrValidationError('Terminated employees cannot be given portal access');
    }
    email = employee.email;
    displayName = displayNameOf(employee);
    lookup = and(eq(pa.kind, 'employee'), eq(pa.employeeId, employee.id));
  } else {
    const person = await personAtCompany(db, input.personId, input.companyId);
    if (!person) throw new HrNotFoundError('Person', input.personId);
    if (!person.linked) throw new HrValidationError('This person is not linked to that company in the CRM');
    if (!person.email) throw new HrValidationError('This person has no email address in the CRM');
    email = person.email;
    displayName = person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email;
    lookup = and(eq(pa.kind, 'client'), eq(pa.personId, person.id), eq(pa.companyId, input.companyId));
  }

  const now = new Date();
  const [existing] = await db.select().from(pa).where(lookup).limit(1);
  if (existing) {
    const [row] = await db
      .update(pa)
      .set({
        email,
        displayName,
        status: existing.status === 'active' ? 'active' : 'invited',
        invitedBy,
        invitedAt: now,
        updatedAt: now,
      })
      .where(eq(pa.id, existing.id))
      .returning();
    return { access: row!, created: false };
  }

  const [row] = await db
    .insert(pa)
    .values({
      id: generateId('hrpac'),
      kind: input.kind,
      employeeId: input.kind === 'employee' ? input.employeeId : null,
      personId: input.kind === 'client' ? input.personId : null,
      companyId: input.kind === 'client' ? input.companyId : null,
      email,
      displayName,
      status: 'invited',
      invitedBy,
      invitedAt: now,
    })
    .returning();
  return { access: row!, created: true };
}

export async function setPortalAccessStatus(db: Database, id: string, status: 'revoked' | 'invited') {
  const existing = await requirePortalAccess(db, id);
  if (status === 'invited' && existing.kind === 'employee' && existing.employeeId) {
    const employee = await requireEmployee(db, existing.employeeId);
    if (employee.status === 'terminated') throw new HrValidationError('Terminated employees cannot be given portal access');
  }
  const [row] = await db
    .update(pa)
    .set({ status: status === 'invited' && existing.lastLoginAt ? 'active' : status, updatedAt: new Date() })
    .where(eq(pa.id, id))
    .returning();
  return row!;
}

export async function deletePortalAccess(db: Database, id: string) {
  await requirePortalAccess(db, id);
  await db.delete(pa).where(eq(pa.id, id));
}

/** Non-revoked grants for an email — the portal's sign-in lookup. */
export async function grantsForEmail(db: Database, email: string) {
  const rows = await db
    .select()
    .from(pa)
    .where(and(sql`lower(${pa.email}) = ${email.trim().toLowerCase()}`, sql`${pa.status} <> 'revoked'`));
  if (rows.length === 0) return [];

  // Drop employee grants whose employee is gone or terminated.
  const valid = [];
  for (const row of rows) {
    if (row.kind === 'employee') {
      if (!row.employeeId) continue;
      const [employee] = await db
        .select({ status: schema.hrEmployees.status })
        .from(schema.hrEmployees)
        .where(and(eq(schema.hrEmployees.id, row.employeeId), isNull(schema.hrEmployees.deletedAt)))
        .limit(1);
      if (!employee || employee.status === 'terminated') continue;
    }
    valid.push(row);
  }
  const names = await companyNames(db, valid.map((r) => r.companyId));
  return valid.map((r) => ({ ...r, companyName: r.companyId ? names.get(r.companyId) ?? null : null }));
}

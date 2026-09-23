/**
 * WeldHR shared plumbing: typed errors the router's `onError` turns into the
 * standard envelope, date helpers (all HR dates are `YYYY-MM-DD` strings), and
 * the audit writer.
 */

import { inArray } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

export class HrNotFoundError extends Error {
  constructor(readonly resource: string, readonly id: string) {
    super(`${resource} ${id} not found`);
    this.name = 'HrNotFoundError';
  }
}

/** Input that parses but makes no sense (end before start, unknown employee in an import…). */
export class HrValidationError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HrValidationError';
  }
}

export class HrConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HrConflictError';
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Today as `YYYY-MM-DD` in UTC. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function assertDateOrder(start: string | null | undefined, end: string | null | undefined, what: string) {
  if (start && end && end < start) {
    throw new HrValidationError(`${what}: end date is before start date`);
  }
}

/** Mon–Fri days in [start, end], inclusive. Used as the default length of a leave request. */
export function workingDaysBetween(start: string, end: string): number {
  if (end < start) return 0;
  let count = 0;
  let cursor = start;
  // Leave requests are capped at a year by validation, so this loop is bounded.
  while (cursor <= end) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

export function yearOf(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}

// ---------------------------------------------------------------------------
// People lookups
// ---------------------------------------------------------------------------

/** Workspace member display names for a set of Clerk user ids. */
export async function memberNames(db: Database, userIds: Array<string | null | undefined>) {
  const ids = [
    ...new Set(
      userIds.filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith('portal:')),
    ),
  ];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ userId: schema.workspaceMembers.userId, name: schema.workspaceMembers.name, email: schema.workspaceMembers.email })
    .from(schema.workspaceMembers)
    .where(inArray(schema.workspaceMembers.userId, ids));
  for (const row of rows) out.set(row.userId, row.name || row.email || row.userId);
  return out;
}

/** Company display names for a set of CRM company ids. */
export async function companyNames(db: Database, companyIds: Array<string | null | undefined>) {
  const ids = [...new Set(companyIds.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: schema.companies.id, name: schema.companies.displayName })
    .from(schema.companies)
    .where(inArray(schema.companies.id, ids));
  for (const row of rows) out.set(row.id, row.name);
  return out;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type HrAuditAction =
  | 'employee.sensitive_viewed'
  | 'employee.sensitive_updated'
  | 'employee.deleted'
  | 'portal.access_invited'
  | 'portal.access_revoked'
  | 'portal.access_restored'
  | 'portal.settings_updated'
  | 'portal.signed_in';

export async function recordHrAudit(
  db: Database,
  entry: {
    actorId: string;
    action: HrAuditAction;
    employeeId?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await db.insert(schema.hrAuditEvents).values({
    id: generateId('hraud'),
    actorId: entry.actorId,
    action: entry.action,
    employeeId: entry.employeeId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
  });
}

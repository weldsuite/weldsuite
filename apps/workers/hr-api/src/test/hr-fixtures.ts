/**
 * Shared set-up for the WeldHR route tests (`routes/weldhr/*.routes.test.ts`).
 *
 * Every request goes through `createTestApp(...).request()` with the whole
 * `/api/weldhr` router mounted, so the defaults middleware and the error
 * boundary run as in production, and in conformance mode each request also
 * runs on the Rust backend (rust/modules/hr) and is compared.
 *
 * Conformance rules these helpers keep:
 *   - one pglite database per test file (`createPgliteDb` is cached per
 *     process), emptied between tests with `resetHr`. The starter templates,
 *     leave types, scorecard and KPIs the first request seeds stay; only rows
 *     the tests add go. Each table is seeded only while it is empty, so a file
 *     that inserts its own templates, leave types, forms or KPIs sends one
 *     request first (in `beforeAll`) to let the defaults in.
 *   - a GET that writes (it links an accepted invite) is sent with
 *     `CONFORMANCE_WRITE_HEADER` (`get(path, { write: true })`).
 *   - fixed ids and dates for everything seeded here.
 */

import { sql } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { addDays, todayIso } from '../services/weldhr/shared';
import { weldhrRoutes } from '../routes/weldhr';
import type { Env } from '../types';

export const HR = '/api/weldhr';

/** The workspace's Clerk org id; receipt keys and notifications are scoped by it. */
export const HR_ORG = 'org_hr_test';
export const HR_WORKSPACE = 'ws_hr_test';

/** Any 64 hex characters: the keyring that seals the sensitive block. */
export const HR_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);

/** The HR administrator who drives the back office. */
export const HR_ADMIN = 'user_hr_admin';

/** Every WeldHR back-office grant (index.ts), and My HR. Never `*`, so a wrong key in a port shows. */
export const ALL_HR_GRANTS = [
  'employees:read',
  'employees:create',
  'employees:update',
  'employees:delete',
  'employees:sensitive',
  'employees:manage',
  'employees:self',
  'attendance:read',
  'attendance:create',
  'attendance:update',
  'attendance:delete',
  'attendance:approve',
  'leave:read',
  'leave:create',
  'leave:update',
  'leave:delete',
  'leave:approve',
  'declarations:read',
  'declarations:create',
  'declarations:update',
  'declarations:delete',
  'declarations:approve',
  'absences:read',
  'absences:create',
  'absences:update',
  'absences:delete',
  'coaching:read',
  'coaching:create',
  'coaching:update',
  'coaching:delete',
  'evaluations:read',
  'evaluations:create',
  'evaluations:update',
  'evaluations:delete',
  'announcements:read',
  'announcements:create',
  'announcements:update',
  'announcements:delete',
];

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function hrDb(): Promise<Database> {
  return (await createPgliteDb()).db;
}

export interface HrCallerOptions {
  userId?: string;
  /** Permission keys; defaults to every WeldHR grant. */
  grants?: string[];
  /** Extra env bindings (STORAGE, REALTIME, …); the encryption key is always set. */
  env?: Partial<Env>;
}

/** A caller of the WeldHR API. Paths are relative to `/api/weldhr`. */
export function hrCaller(db: Database, opts: HrCallerOptions = {}) {
  const { request } = createTestApp(HR, weldhrRoutes, {
    context: {
      tenantDb: db,
      userId: opts.userId ?? HR_ADMIN,
      permissions: permissions(...(opts.grants ?? ALL_HR_GRANTS)),
      orgId: HR_ORG,
      clerkOrgId: HR_ORG,
      workspaceId: HR_WORKSPACE,
    },
    env: { DATABASE_ENCRYPTION_KEY_V2: HR_ENCRYPTION_KEY, ...opts.env },
  });
  return {
    request,
    /** `write: true` for a GET that links an accepted invite (it is compared as a write). */
    get: (path: string, init: { write?: boolean } = {}) =>
      request(`${HR}${path}`, init.write ? { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } } : undefined),
    send: (method: string, path: string, body?: unknown) =>
      request(`${HR}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
      }),
    /** A multipart upload of `file` as the `file` field (a string sends a plain text field). */
    upload: (path: string, file: File | string) => {
      const form = new FormData();
      // Two calls: `append` has one overload for text and one for a Blob.
      if (typeof file === 'string') form.set('file', file);
      else form.append('file', file);
      return request(`${HR}${path}`, { method: 'POST', body: form });
    },
  };
}

export type HrCaller = ReturnType<typeof hrCaller>;

/** The `data` of a JSON answer. */
export async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

/** The error envelope of a JSON answer. */
export async function errorOf(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const today = () => todayIso();
export const daysFromToday = (days: number) => addDays(todayIso(), days);

/** An instant `minutes` from now, rounded down to the minute (shifts and requests ahead of now). */
export function minutesFromNow(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000);
  at.setUTCSeconds(0, 0);
  return at.toISOString();
}

// ---------------------------------------------------------------------------
// Seed rows
// ---------------------------------------------------------------------------

const SEEDED_AT = new Date('2026-01-05T09:00:00.000Z');

export async function seedMember(
  db: Database,
  userId: string,
  fields: Partial<typeof schema.workspaceMembers.$inferInsert> = {},
) {
  const name = fields.name ?? userId.replace(/^user_/, '').replace(/_/g, ' ');
  await db.insert(schema.workspaceMembers).values({
    id: `wm_${userId}`.slice(0, 30),
    userId,
    name,
    email: `${userId}@example.com`,
    status: 'ACTIVE',
    memberType: 'INTERNAL',
    ...fields,
  });
}

export async function seedEmployee(db: Database, fields: Partial<typeof schema.hrEmployees.$inferInsert> & { id: string }) {
  const first = fields.firstName ?? fields.id.replace(/^hremp_/, '');
  const [row] = await db
    .insert(schema.hrEmployees)
    .values({
      firstName: first.charAt(0).toUpperCase() + first.slice(1),
      lastName: 'Example',
      email: `${first}@example.com`,
      status: 'active',
      employmentType: 'full_time',
      startDate: '2025-01-06',
      createdBy: HR_ADMIN,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      ...fields,
    })
    .returning();
  return row!;
}

export async function seedDepartment(db: Database, id: string, name: string, parentId: string | null = null) {
  await db.insert(schema.hrDepartments).values({ id, name, parentId, createdAt: SEEDED_AT, updatedAt: SEEDED_AT });
}

export async function seedCompany(db: Database, id: string, name: string, deletedAt: Date | null = null) {
  await db.insert(schema.companies).values({ id, name, displayName: name, deletedAt });
}

// ---------------------------------------------------------------------------
// Between tests
// ---------------------------------------------------------------------------

/** Tables the tests fill; emptied before each test. */
const DATA_TABLES = [
  'hr_audit_events',
  'hr_announcement_reads',
  'hr_announcements',
  'hr_absences',
  'hr_declarations',
  'hr_leave_requests',
  'hr_leave_allowances',
  'hr_attendance_records',
  'hr_shift_requests',
  'hr_open_shifts',
  'hr_shifts',
  'hr_work_locations',
  'hr_checklist_tasks',
  'hr_checklists',
  'hr_client_assignments',
  'hr_coaching_logs',
  'hr_evaluations',
  'hr_kpi_values',
  'hr_milestones',
  'hr_compensations',
  'hr_employees',
  'hr_departments',
  'hr_settings',
  'custom_field_values',
  'custom_field_definitions',
  'notifications',
  'device_tokens',
  'workspace_members',
  'companies',
];

/**
 * Configuration the first request seeds (fixed `*_default_*` ids). The seeds
 * stay, as both backends seed once per database; rows the tests add go.
 */
const SEEDED_TABLES = ['hr_checklist_templates', 'hr_leave_types', 'hr_evaluation_forms', 'hr_kpi_definitions'];

export async function resetHr(db: Database): Promise<void> {
  for (const table of DATA_TABLES) await db.execute(sql.raw(`delete from ${table}`));
  for (const table of SEEDED_TABLES) await db.execute(sql.raw(`delete from ${table} where id not like '%\\_default\\_%'`));
}

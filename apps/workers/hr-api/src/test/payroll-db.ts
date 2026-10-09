/**
 * Test database for the payroll services: the pglite tenant schema plus the
 * payroll tables.
 *
 * The payroll tables are in the Drizzle schema (packages/core/db/src/schema/
 * weldhr-payroll.ts) but their migration is generated and approved separately
 * (CLAUDE.md: no migration files without the owner's approval), so the pglite
 * harness, which applies journaled migrations only, does not have them yet.
 * This helper creates what is missing straight from the schema, in memory, via
 * drizzle-kit's programmatic API. Once the migration is journaled the tables
 * already exist and this does nothing.
 */

import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import { getTableName, type Table } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import * as payrollSchema from '@weldsuite/db/schema';

const PAYROLL_TABLES = [
  payrollSchema.hrPayrollEmployers,
  payrollSchema.hrPaySchedules,
  payrollSchema.hrPayrollProfiles,
  payrollSchema.hrCompensations,
  payrollSchema.hrPayComponents,
  payrollSchema.hrTaxElections,
  payrollSchema.hrPayRuns,
  payrollSchema.hrPayRunInputs,
  payrollSchema.hrPayslips,
  payrollSchema.hrPayrollFilings,
] as const;

let ensured: Promise<void> | null = null;

async function tableExists(db: Database, name: string): Promise<boolean> {
  const result = (await db.execute(sql`select to_regclass(${name}) as t`)) as unknown as { rows?: Array<{ t: string | null }> };
  const rows = result.rows ?? (result as unknown as Array<{ t: string | null }>);
  return Boolean(rows[0]?.t);
}

async function ensurePayrollTables(db: Database): Promise<void> {
  if (await tableExists(db, 'hr_pay_runs')) return;
  // Loaded through Node's own require: vite would inline drizzle-kit's ESM build, which needs a real `require`.
  const nodeRequire = createRequire(import.meta.url);
  const { generateDrizzleJson, generateMigration } = nodeRequire('drizzle-kit/api') as typeof import('drizzle-kit/api');
  const imports: Record<string, unknown> = {};
  for (const table of PAYROLL_TABLES) imports[getTableName(table as Table)] = table;
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(imports));
  for (const statement of statements) await db.execute(sql.raw(statement));
}

/** A pglite tenant DB with the payroll tables. Shared per test process (as createPgliteDb is). */
export async function createPayrollDb(): Promise<Database> {
  const { db } = await createPgliteDb();
  ensured ??= ensurePayrollTables(db);
  await ensured;
  return db;
}

/** HR and accounting rows the payroll tests create, emptied between tests too. */
const OTHER_TABLES = [
  'hr_audit_events',
  'hr_declarations',
  'hr_absences',
  'hr_leave_requests',
  'hr_leave_allowances',
  'hr_leave_types',
  'hr_attendance_records',
  'hr_portal_access',
  'hr_employees',
  'workspace_members',
  'payroll_imports',
  'journal_lines',
  'journal_entries',
  'accounts',
  'entities',
];

/** Empty every payroll table (and the HR rows tests create) between tests. */
export async function resetPayrollTables(db: Database): Promise<void> {
  for (const table of PAYROLL_TABLES) await db.execute(sql.raw(`delete from ${getTableName(table as Table)}`));
  for (const name of OTHER_TABLES) await db.execute(sql.raw(`delete from ${name}`)).catch(() => undefined);
}

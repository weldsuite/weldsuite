/**
 * Test database for the payroll services: the pglite tenant schema, which has
 * the payroll tables from migration 0206_weldhr_payroll, plus a reset that
 * empties them (and the HR and accounting rows the tests create) between tests.
 */

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

/** A pglite tenant DB with the payroll tables. Shared per test process (as createPgliteDb is). */
export async function createPayrollDb(): Promise<Database> {
  const { db } = await createPgliteDb();
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

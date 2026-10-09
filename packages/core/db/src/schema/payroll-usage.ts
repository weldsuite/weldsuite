import { pgTable, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Billable payroll usage, master DB. One row per final payslip, written by
 * hr-api when a WeldHR pay run is approved. Payroll is meant to be paid per
 * payslip; until a Stripe price exists this ledger is what a monthly charge
 * will be computed from (count per workspace per `month`).
 *
 * `(workspace_id, payslip_id)` is unique, so approving the same run twice, or
 * a retry after a timeout, never counts a payslip twice. A payslip voided by a
 * correction keeps its row: the work was done.
 */
export const payrollUsageEvents = pgTable('payroll_usage_events', {
  id: varchar('id', { length: 30 }).primaryKey(),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  /** `YYYY-MM` of the pay date. */
  month: varchar('month', { length: 7 }).notNull(),
  /** `NL` or `US`. */
  country: varchar('country', { length: 2 }).notNull(),
  /** Tenant ids, for reconciling with the workspace's own records. */
  employerId: varchar('employer_id', { length: 30 }).notNull(),
  runId: varchar('run_id', { length: 30 }).notNull(),
  payslipId: varchar('payslip_id', { length: 30 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('payroll_usage_events_payslip_uidx').on(table.workspaceId, table.payslipId),
  index('payroll_usage_events_month_idx').on(table.workspaceId, table.month),
]);

export type PayrollUsageEvent = typeof payrollUsageEvents.$inferSelect;
export type NewPayrollUsageEvent = typeof payrollUsageEvents.$inferInsert;

/**
 * Payroll plumbing shared by the services: serialisers for dates and money,
 * issue helpers, and the tables.
 *
 * Money: stored amounts are `numeric` columns (decimal strings in and out);
 * everything that is added up or compared goes through integer cents
 * (`toCents` / `fromCents` from @weldsuite/payroll-domain/money).
 */

import type { HrPayrollIssue } from '@weldsuite/db/schema';
import { schema } from '@weldsuite/worker-kit/db';
import { addDays } from './dates';

export { addDays };

export const FLAG_PAYROLL = 'weldhr-payroll' as const;
export const FLAG_DIGIPOORT = 'weldhr-payroll-digipoort' as const;

export const tables = {
  employers: schema.hrPayrollEmployers,
  schedules: schema.hrPaySchedules,
  profiles: schema.hrPayrollProfiles,
  compensations: schema.hrCompensations,
  components: schema.hrPayComponents,
  elections: schema.hrTaxElections,
  runs: schema.hrPayRuns,
  inputs: schema.hrPayRunInputs,
  payslips: schema.hrPayslips,
  filings: schema.hrPayrollFilings,
  employees: schema.hrEmployees,
};

export type EmployerRow = typeof schema.hrPayrollEmployers.$inferSelect;
export type ScheduleRow = typeof schema.hrPaySchedules.$inferSelect;
export type ProfileRow = typeof schema.hrPayrollProfiles.$inferSelect;
export type CompensationRow = typeof schema.hrCompensations.$inferSelect;
export type ComponentRow = typeof schema.hrPayComponents.$inferSelect;
export type ElectionRow = typeof schema.hrTaxElections.$inferSelect;
export type RunRow = typeof schema.hrPayRuns.$inferSelect;
export type RunInputRow = typeof schema.hrPayRunInputs.$inferSelect;
export type PayslipRow = typeof schema.hrPayslips.$inferSelect;
export type FilingRow = typeof schema.hrPayrollFilings.$inferSelect;
export type EmployeeRow = typeof schema.hrEmployees.$inferSelect;

/** Timestamp column → ISO string (or null). */
export function ts(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Timestamp column that is never null. */
export function tsRequired(value: Date): string {
  return value.toISOString();
}

export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Decimal string with two places, from a JS number in currency units. */
export function decimal2(value: number): string {
  return (Math.round(value * 100 + (value >= 0 ? 1e-9 : -1e-9)) / 100).toFixed(2);
}

/** Decimal string with four places (rates, quantities). */
export function decimal4(value: number): string {
  return value.toFixed(4);
}

export function hasError(issues: HrPayrollIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function countIssues(issues: HrPayrollIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** Sort blocking issues first, keep the order otherwise. */
export function sortIssues(issues: HrPayrollIssue[]): HrPayrollIssue[] {
  return [...issues].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
}

/** Add an issue unless one with the same code, employee and params is already there. */
export function pushIssue(issues: HrPayrollIssue[], issue: HrPayrollIssue): void {
  const key = issueKey(issue);
  if (!issues.some((i) => issueKey(i) === key)) issues.push(issue);
}

function issueKey(issue: HrPayrollIssue): string {
  return `${issue.severity}|${issue.code}|${issue.employeeId ?? ''}|${JSON.stringify(issue.params ?? {})}`;
}

/** `"2026-07-31"` → 2026. */
export function yearOfDate(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}

/** First and last day of a calendar month. */
export function monthBounds(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** First and last day of a calendar quarter (1–4). */
export function quarterBounds(year: number, quarter: number): { start: string; end: string } {
  const first = (quarter - 1) * 3 + 1;
  return { start: monthBounds(year, first).start, end: monthBounds(year, first + 2).end };
}

/** The last day of the month after `isoDate`'s month. */
export function endOfNextMonth(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return monthBounds(next.y, next.m).end;
}

/** `YYYY-MM-DD` of a Date, UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** CSV field with quoting for commas, quotes and newlines. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvField).join(',');
}

/** Safe file-name fragment. */
export function fileSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'file';
}

/**
 * Year-to-date chains. The accumulators of an employee's payslips at one
 * employer in one tax year form a chain: each payslip starts from the
 * accumulators of the one approved before it. Approval order is the payslip
 * number (`<year>-<seq>`, assigned in approval order per employer), so the
 * "latest" payslip is the one with the highest number.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { US_OT_CARRY_PREFIX } from '@weldsuite/payroll-domain/us';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { PayslipRow } from './common';

/** `2026-0007` → [2026, 7]; null for a draft. */
export function numberKey(number: string | null): [number, number] | null {
  const m = /^(\d{4})-(\d+)$/.exec(number ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function compareNumbers(a: string | null, b: string | null): number {
  const ka = numberKey(a);
  const kb = numberKey(b);
  if (!ka || !kb) return ka ? 1 : kb ? -1 : 0;
  return ka[0] - kb[0] || ka[1] - kb[1];
}

/** Sort comparator: payslips in approval order (drafts last). */
export function compareNumberOrder(a: { number: string | null }, b: { number: string | null }): number {
  return compareNumbers(a.number, b.number);
}

/** The payslip approved last. */
export function latestByApproval<T extends { number: string | null }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) if (!best || compareNumbers(row.number, best.number) > 0) best = row;
  return best;
}

/** The payslips approved before `row` (by number), oldest first. */
export function approvedBefore<T extends { number: string | null }>(rows: T[], number: string | null): T[] {
  return rows.filter((r) => compareNumbers(r.number, number) < 0).sort((a, b) => compareNumbers(a.number, b.number));
}

/**
 * The accumulators a new tax year starts from. Everything resets except the
 * US engine's open FLSA workweeks (`us.ot_carry.*`), which belong to a
 * workweek that straddles New Year: they are copied from the last final
 * payslip of the previous year.
 */
export function carriedOverYtd(previousYearTip: { ytd: Record<string, number> } | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!previousYearTip) return out;
  for (const [key, value] of Object.entries(previousYearTip.ytd)) {
    if (key.startsWith(US_OT_CARRY_PREFIX)) out[key] = value;
  }
  return out;
}

/** Final payslips of employees at an employer for a tax year, by employee. */
export async function finalPayslipsByEmployee(
  db: Database,
  employeeIds: string[],
  employerId: string,
  taxYear: number,
): Promise<Map<string, PayslipRow[]>> {
  const out = new Map<string, PayslipRow[]>();
  if (employeeIds.length === 0) return out;
  const s = schema.hrPayslips;
  const rows = await db
    .select()
    .from(s)
    .where(and(inArray(s.employeeId, employeeIds), eq(s.employerId, employerId), eq(s.taxYear, taxYear), eq(s.status, 'final')));
  for (const row of rows) {
    const list = out.get(row.employeeId) ?? [];
    list.push(row);
    out.set(row.employeeId, list);
  }
  return out;
}

/** Whether the employee has any final payslip at the employer (any year). */
export async function employeesWithFinalPayslips(db: Database, employeeIds: string[], employerId: string): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const s = schema.hrPayslips;
  const rows = await db
    .selectDistinct({ employeeId: s.employeeId })
    .from(s)
    .where(and(inArray(s.employeeId, employeeIds), eq(s.employerId, employerId), eq(s.status, 'final')));
  return new Set(rows.map((r) => r.employeeId));
}

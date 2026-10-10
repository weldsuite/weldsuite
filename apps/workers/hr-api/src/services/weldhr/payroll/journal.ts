/**
 * The WeldBooks journal of an approved pay run.
 *
 * Run totals become the categories books-api's payroll import posts:
 *
 *   Dr gross wages, employer taxes, employer benefits, reimbursements
 *     Cr employee taxes, employee deductions, employer taxes + benefits owed
 *     Cr net pay + reimbursements (bank or payroll clearing)
 *
 * Net pay is derived as gross - employee taxes - employee deductions, so the
 * entry balances by construction whatever the engine rounded. (The engine's
 * own net pay is what the payment file pays; a difference is logged.)
 * A correction run has signed totals: books-api posts a negative amount as
 * the opposite side.
 */

import { eq } from 'drizzle-orm';
import type { HrPayRunTotals } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { HrNotFoundError, HrPayrollError } from '../shared';
import type { EmployerRow, RunRow } from './common';
import type { JournalTotals, PayrollDeps } from './deps';
import { requireRun } from './runs';

const cents = (value: number) => value / 100;

export function journalTotalsFor(totals: HrPayRunTotals): JournalTotals {
  const gross = totals.grossCents;
  const netExcludingReimbursements = gross - totals.employeeTaxesCents - totals.employeeDeductionsCents;
  const benefits = totals.employerCostCents - gross - totals.employerTaxesCents - totals.reimbursementsCents;
  const engineNet = totals.netCents - totals.reimbursementsCents;
  if (engineNet !== netExcludingReimbursements) {
    console.warn(`[payroll] run net pay differs from gross minus taxes and deductions by ${engineNet - netExcludingReimbursements} cents; the journal uses the derived figure`);
  }
  return {
    grossWages: cents(gross),
    employerTaxes: cents(totals.employerTaxesCents),
    employerBenefits: cents(benefits),
    reimbursements: cents(totals.reimbursementsCents),
    employeeTaxes: cents(totals.employeeTaxesCents),
    employeeDeductions: cents(totals.employeeDeductionsCents),
    netPay: cents(netExcludingReimbursements),
  };
}

export interface JournalOutcome {
  status: 'posted' | 'failed' | 'skipped';
  error: string | null;
  journalEntryId: string | null;
}

/** Post (or re-post: books-api is idempotent per run) the journal and record the outcome on the run. */
export async function postRunJournal(db: Database, runId: string, deps: PayrollDeps, ctx: { userId: string | null }): Promise<JournalOutcome> {
  const run = await requireRun(db, runId);
  // Only an approved (or paid) run has figures worth posting: a draft or cancelled run must never reach the ledger.
  if (run.status !== 'approved' && run.status !== 'paid') {
    throw new HrPayrollError('RUN_NOT_APPROVED', `This pay run is ${run.status}; the journal is posted once the run is approved`, 409);
  }
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, run.employerId)).limit(1);
  if (!employer) throw new HrNotFoundError('Payroll employer', run.employerId);
  const outcome = await attemptJournal(run, employer, deps, ctx);
  await db
    .update(schema.hrPayRuns)
    .set({
      journalStatus: outcome.status,
      journalEntryId: outcome.journalEntryId ?? run.journalEntryId,
      journalError: outcome.error,
      updatedAt: new Date(),
    })
    .where(eq(schema.hrPayRuns.id, runId));
  return outcome;
}

async function attemptJournal(run: RunRow, employer: EmployerRow, deps: PayrollDeps, ctx: { userId: string | null }): Promise<JournalOutcome> {
  if (!employer.accountingEntityId) return { status: 'skipped', error: null, journalEntryId: null };
  if (!deps.books) return { status: 'skipped', error: 'The WeldBooks link (BOOKS_INTERNAL) is not configured on this worker', journalEntryId: null };
  if (!run.totals) return { status: 'failed', error: 'The run has no totals to post', journalEntryId: null };

  const label = run.kind === 'correction' ? 'Payroll correction' : 'Payroll';
  const result = await deps.books.postPayroll(deps.workspaceKey, {
    entityId: employer.accountingEntityId,
    externalId: run.id,
    payDate: run.payDate,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    description: `${label} ${employer.name} ${run.periodStart} - ${run.periodEnd}`,
    country: run.country as 'NL' | 'US',
    totals: journalTotalsFor(run.totals),
    postedBy: ctx.userId,
  });
  if (result.status === 'failed') return { status: 'failed', error: result.error.slice(0, 500), journalEntryId: null };
  return { status: 'posted', error: null, journalEntryId: result.journalEntryId };
}

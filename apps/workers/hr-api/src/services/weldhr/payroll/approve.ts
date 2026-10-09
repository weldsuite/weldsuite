/**
 * Approving and paying a pay run.
 *
 * Approval is one go, in this order: claim the run (calculated → approved, so
 * two approvers cannot both win), number and finalise the payslips, render
 * each PDF into R2, meter each payslip for billing, post the journal to
 * WeldBooks, create or refresh the affected filings. Everything after the
 * claim is retryable on its own and none of it undoes the approval when it
 * fails: a PDF that could not be stored is rendered again on first download,
 * a metering failure is logged (the ledger is idempotent per payslip), a
 * failed journal is `journalStatus: 'failed'` with its message and a retry
 * endpoint, and filings can be regenerated.
 */

import { and, eq, inArray, like } from 'drizzle-orm';
import type { HrPayrollIssue } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { displayNameOf } from '../employees';
import { HrConflictError, HrNotFoundError, HrPayrollError } from '../shared';
import { hasError, type EmployerRow, type PayslipRow, type RunRow } from './common';
import { dataVersion } from './calculate';
import type { PayrollDeps, UsageEventInput } from './deps';
import { ensureFilingsForRun, type TouchedFiling } from './filings';
import { postRunJournal, type JournalOutcome } from './journal';
import { employeesToNotify, languageOf, renderAndStorePayslip } from './payslips';
import { includedEmployeeIds, requireRun } from './runs';
import { numberKey } from './ytd';

const r = schema.hrPayRuns;
const s = schema.hrPayslips;

export interface ApproveResult {
  run: RunRow;
  payslips: Array<{ id: string; employeeId: string; number: string }>;
  filings: TouchedFiling[];
  journal: JournalOutcome;
  /** Payslips written to the billing ledger (corrections are not billed). */
  metered: number;
  pdfFailures: number;
}

export function fourEyesBlocks(employer: Pick<EmployerRow, 'requireSeparateApprover'>, run: Pick<RunRow, 'calculatedBy'>, userId: string): boolean {
  return Boolean(employer.requireSeparateApprover && run.calculatedBy && run.calculatedBy === userId);
}

/** Next free `<year>-<seq>` numbers per tax year at the employer, in the order of `slips`. */
async function assignNumbers(db: Database, employerId: string, slips: PayslipRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const next = new Map<number, number>();
  for (const year of new Set(slips.map((x) => x.taxYear))) {
    const rows = await db
      .select({ number: s.number })
      .from(s)
      .where(and(eq(s.employerId, employerId), like(s.number, `${year}-%`)));
    next.set(year, rows.reduce((max, row) => Math.max(max, numberKey(row.number)?.[1] ?? 0), 0) + 1);
  }
  for (const slip of slips) {
    const seq = next.get(slip.taxYear)!;
    next.set(slip.taxYear, seq + 1);
    out.set(slip.id, `${slip.taxYear}-${String(seq).padStart(4, '0')}`);
  }
  return out;
}

export async function approveRun(db: Database, runId: string, deps: PayrollDeps, ctx: { userId: string }): Promise<ApproveResult> {
  const run = await requireRun(db, runId);
  if (run.status !== 'calculated') {
    throw new HrPayrollError('RUN_NOT_CALCULATED', `This pay run is ${run.status}; only a calculated run can be approved`, 409);
  }
  const errors: HrPayrollIssue[] = run.issues.filter((i) => i.severity === 'error');
  if (hasError(run.issues)) {
    throw new HrPayrollError('RUN_HAS_ERRORS', `Resolve the ${errors.length} error${errors.length === 1 ? '' : 's'} in this run before approving it`, 409, { issues: errors });
  }
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, run.employerId)).limit(1);
  if (!employer) throw new HrNotFoundError('Payroll employer', run.employerId);
  if (fourEyesBlocks(employer, run, ctx.userId)) {
    throw new HrPayrollError('FOUR_EYES', 'This employer requires a second person to approve: the member who calculated the run cannot approve it', 409);
  }
  const included = await includedEmployeeIds(db, run);
  const drafts = await db.select().from(s).where(and(eq(s.runId, runId), eq(s.status, 'draft')));
  if (drafts.length === 0) throw new HrPayrollError('RUN_EMPTY', 'This run has no payslips to approve', 409);
  // The calculation is a snapshot; refuse to approve it when what it read has changed since.
  const calculatedAgainst = drafts.map((d) => (d.snapshot as { dataVersion?: string }).dataVersion ?? '').sort()[0] ?? '';
  if ((await dataVersion(db, employer.id, included)) > calculatedAgainst) {
    throw new HrPayrollError('RECALCULATE_REQUIRED', 'Employee or employer data changed after this run was calculated. Calculate it again before approving.', 409);
  }

  // Claim: only one caller moves the run out of `calculated`.
  const now = deps.now();
  const claimed = await db
    .update(r)
    .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: now, updatedAt: now })
    .where(and(eq(r.id, runId), eq(r.status, 'calculated')))
    .returning({ id: r.id });
  if (claimed.length === 0) throw new HrConflictError('This pay run was approved or changed by someone else');

  // Number and finalise, alphabetical by employee so a run reads in a stable order.
  const people = await db
    .select({ id: schema.hrEmployees.id, firstName: schema.hrEmployees.firstName, lastName: schema.hrEmployees.lastName, preferredName: schema.hrEmployees.preferredName })
    .from(schema.hrEmployees)
    .where(inArray(schema.hrEmployees.id, drafts.map((d) => d.employeeId)));
  const nameOf = new Map(people.map((p) => [p.id, displayNameOf(p)]));
  const ordered = [...drafts].sort((a, b) => (nameOf.get(a.employeeId) ?? '').localeCompare(nameOf.get(b.employeeId) ?? ''));
  const numbers = await assignNumbers(db, employer.id, ordered);
  await atomically(db, (h) =>
    ordered.map((slip) =>
      h
        .update(s)
        .set({ status: 'final', number: numbers.get(slip.id)!, updatedAt: now })
        .where(and(eq(s.id, slip.id), eq(s.status, 'draft'))),
    ),
  );
  const finals = await db.select().from(s).where(and(eq(s.runId, runId), eq(s.status, 'final')));

  // PDFs
  let pdfFailures = 0;
  for (let i = 0; i < finals.length; i += 8) {
    const results = await Promise.allSettled(finals.slice(i, i + 8).map((slip) => renderAndStorePayslip(db, slip, deps)));
    for (const result of results) {
      if (result.status === 'rejected') {
        pdfFailures += 1;
        console.error('[payroll] could not render a payslip PDF:', result.reason instanceof Error ? result.reason.message : result.reason);
      }
    }
  }

  // Billing: every final payslip of a regular or off-cycle run; corrections are not charged again.
  let metered = 0;
  if (deps.meter && run.kind !== 'correction') {
    try {
      const workspaceId = await deps.usageWorkspaceId();
      const events: UsageEventInput[] = finals.map((slip) => ({
        workspaceId,
        month: run.payDate.slice(0, 7),
        country: run.country as 'NL' | 'US',
        employerId: employer.id,
        runId,
        payslipId: slip.id,
      }));
      await deps.meter(events);
      metered = events.length;
    } catch (err) {
      console.error('[payroll] could not meter payslips:', err instanceof Error ? err.message : err);
    }
  }

  const journal = await postRunJournal(db, runId, deps, { userId: ctx.userId });
  const filings = await ensureFilingsForRun(db, employer, finals, deps, { userId: ctx.userId });

  // Best-effort "your payslip is ready".
  if (deps.notifier?.payslipReady) {
    try {
      const recipients = await employeesToNotify(db, finals.map((x) => x.employeeId));
      const lang = languageOf(employer);
      await Promise.allSettled(
        recipients.map((p) =>
          deps.notifier!.payslipReady!({ employeeId: p.id, email: p.email, name: p.name, payDate: run.payDate, employerName: employer.name, lang }),
        ),
      );
    } catch (err) {
      console.error('[payroll] payslip notifications failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    run: await requireRun(db, runId),
    payslips: finals.map((x) => ({ id: x.id, employeeId: x.employeeId, number: x.number ?? '' })),
    filings,
    journal,
    metered,
    pdfFailures,
  };
}

/** Mark an approved run paid, and the expense declarations it reimbursed. */
export async function markRunPaid(
  db: Database,
  runId: string,
  input: { paidOn?: string },
  ctx: { userId: string; now: Date },
): Promise<{ run: RunRow; declarationIds: string[] }> {
  const run = await requireRun(db, runId);
  if (run.status !== 'approved') throw new HrConflictError(`This pay run is ${run.status}; only an approved run can be marked as paid`);
  const paidAt = input.paidOn ? new Date(`${input.paidOn}T12:00:00Z`) : ctx.now;
  const i = schema.hrPayRunInputs;
  const refs = await db
    .select({ ref: i.sourceRef })
    .from(i)
    .where(and(eq(i.runId, runId), eq(i.source, 'declaration')));
  const declarationIds = refs.map((x) => x.ref).filter((v): v is string => Boolean(v));
  let paid: string[] = [];
  await atomically(db, (h) => [
    h.update(r).set({ status: 'paid', paidBy: ctx.userId, paidAt, updatedAt: ctx.now }).where(and(eq(r.id, runId), eq(r.status, 'approved'))),
  ]);
  if (declarationIds.length) {
    const d = schema.hrDeclarations;
    const updated = await db
      .update(d)
      .set({ status: 'paid', paidBy: ctx.userId, paidAt, updatedAt: ctx.now })
      .where(and(inArray(d.id, declarationIds), eq(d.status, 'approved')))
      .returning({ id: d.id });
    paid = updated.map((x) => x.id);
  }
  return { run: await requireRun(db, runId), declarationIds: paid };
}

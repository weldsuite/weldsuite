/**
 * Approving and paying a pay run.
 *
 * Approval is one go, in this order: check the calculation is still current,
 * then claim the run (calculated → approved, so two approvers cannot both win)
 * together with numbering and finalising its payslips in ONE atomic write, render
 * each PDF into R2, meter each payslip for billing, post the journal to
 * WeldBooks, create or refresh the affected filings. Everything after the
 * claim is retryable on its own and none of it undoes the approval when it
 * fails: a PDF that could not be stored is rendered again on first download,
 * a metering failure is logged (the ledger is idempotent per payslip), a
 * failed journal is `journalStatus: 'failed'` with its message and a retry
 * endpoint, and filings can be regenerated.
 *
 * Because the claim and the finalisation are one write, a run is never
 * approved with draft payslips; and because the numbers are unique per
 * employer (unique index), two approvals racing for the same numbers cannot
 * both succeed: the loser starts over, checks the calculation again (the
 * winner may have moved the year-to-date chain it started from) and is
 * refused if so.
 */

import { and, eq, exists, inArray, like, sql } from 'drizzle-orm';
import type { HrPayrollIssue } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { displayNameOf } from '../employees';
import { HrConflictError, HrNotFoundError, HrPayrollError } from '../shared';
import { hasError, type EmployerRow, type PayslipRow, type RunRow } from './common';
import { dataVersion, runInputsStamp } from './calculate';
import type { PayrollDeps, UsageEventInput } from './deps';
import { bankOf, decryptSensitive, sealBank } from './employees';
import { ensureFilingsForRun, type TouchedFiling } from './filings';
import { postRunJournal, type JournalOutcome } from './journal';
import { employeesToNotify, languageOf, renderAndStorePayslip } from './payslips';
import { assertCorrectionInYear, includedEmployeeIds, requireRun } from './runs';
import { finalPayslipsByEmployee, latestByApproval, numberKey } from './ytd';

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

// ---------------------------------------------------------------------------
// Is the calculation still what the run would pay?
// ---------------------------------------------------------------------------

function stale(message: string, details: Record<string, unknown>): HrPayrollError {
  return new HrPayrollError('RECALCULATE_REQUIRED', message, 409, details);
}

interface SnapshotMarkers {
  dataVersion?: string;
  inputsStamp?: string;
  kind?: string;
  chain?: { tipId?: string | null; previousYearTipId?: string | null };
}

/**
 * A calculation is a snapshot. Refuse to approve it when what it read has
 * changed: the people in the run, the run's own period and pay date, employee
 * or employer data, the run's inputs, or the year-to-date chain (another
 * payslip of the same employee was approved after the one this calculation
 * started from: approving this one too would drop that payslip out of the
 * chain and every cumulative figure after it would be wrong).
 */
async function assertCalculationCurrent(db: Database, run: RunRow, employer: EmployerRow, drafts: PayslipRow[], included: string[]): Promise<void> {
  // The people: the payslips are for exactly the employees the run currently includes.
  const draftIds = new Set(drafts.map((d) => d.employeeId));
  const includedSet = new Set(included);
  const differing = [...included.filter((id) => !draftIds.has(id)), ...[...draftIds].filter((id) => !includedSet.has(id))];
  if (differing.length) {
    throw stale('The people in this run changed after it was calculated (someone joined, left, was paused or moved to another schedule). Calculate it again before approving.', {
      reason: 'employees_changed',
      employeeIds: differing,
    });
  }
  if (drafts.some((d) => d.payDate !== run.payDate || d.periodStart !== run.periodStart || d.periodEnd !== run.periodEnd || d.taxYear !== run.taxYear)) {
    throw stale('The period or pay date of this run changed after it was calculated. Calculate it again before approving.', { reason: 'period_changed' });
  }

  const markers = (d: PayslipRow) => d.snapshot as SnapshotMarkers;
  // Employee and employer data, over everyone who is paid or is in the run.
  const everyone = [...new Set([...draftIds, ...includedSet])];
  const calculatedAgainst = drafts.map((d) => markers(d).dataVersion ?? '').sort()[0] ?? '';
  if ((await dataVersion(db, employer.id, everyone)) > calculatedAgainst) {
    throw stale('Employee or employer data changed after this run was calculated. Calculate it again before approving.', { reason: 'data_changed' });
  }
  // The run's inputs.
  const stamp = await runInputsStamp(db, run.id);
  if (drafts.some((d) => markers(d).inputsStamp !== stamp)) {
    throw stale('The inputs of this run changed after it was calculated. Calculate it again before approving.', { reason: 'inputs_changed' });
  }
  // The year-to-date chain.
  const ids = drafts.map((d) => d.employeeId);
  const years = [...new Set(drafts.map((d) => d.taxYear))];
  const current = new Map<number, Map<string, PayslipRow[]>>();
  for (const year of years) {
    current.set(year, await finalPayslipsByEmployee(db, ids, employer.id, year));
    if (run.kind !== 'correction') current.set(year - 1, await finalPayslipsByEmployee(db, ids, employer.id, year - 1));
  }
  const behind: string[] = [];
  for (const d of drafts) {
    const chain = markers(d).chain;
    const tipNow = latestByApproval(current.get(d.taxYear)?.get(d.employeeId) ?? [])?.id ?? null;
    const previousNow = run.kind === 'correction' ? null : latestByApproval(current.get(d.taxYear - 1)?.get(d.employeeId) ?? [])?.id ?? null;
    if (!chain || (chain.tipId ?? null) !== tipNow || (chain.previousYearTipId ?? null) !== previousNow) behind.push(d.employeeId);
  }
  if (behind.length) {
    throw stale('Another payslip was approved for the same employee after this run was calculated, so its year-to-date figures are out of date. Calculate it again before approving.', {
      reason: 'ytd_changed',
      employeeIds: behind,
    });
  }
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

interface Approved {
  run: RunRow;
  employer: EmployerRow;
  finals: PayslipRow[];
}

/** One attempt: check, number, and claim + finalise in one atomic write. A number taken by a racing approval throws a unique violation. */
async function claimAndFinalise(db: Database, runId: string, deps: PayrollDeps, ctx: { userId: string }): Promise<Approved> {
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
  if (run.kind === 'correction') assertCorrectionInYear(run.taxYear, run.payDate);
  const included = await includedEmployeeIds(db, run);
  const drafts = await db.select().from(s).where(and(eq(s.runId, runId), eq(s.status, 'draft')));
  if (drafts.length === 0) throw new HrPayrollError('RUN_EMPTY', 'This run has no payslips to approve', 409);
  await assertCalculationCurrent(db, run, employer, drafts, included);

  // Number alphabetically by employee so a run reads in a stable order.
  const people = await db.select().from(schema.hrEmployees).where(inArray(schema.hrEmployees.id, drafts.map((d) => d.employeeId)));
  const nameOf = new Map(people.map((p) => [p.id, displayNameOf(p)]));
  const ordered = [...drafts].sort((a, b) => (nameOf.get(a.employeeId) ?? '').localeCompare(nameOf.get(b.employeeId) ?? ''));
  const numbers = await assignNumbers(db, employer.id, ordered);

  // The account each payslip is paid to is frozen now, sealed with the keyring: a later change of bank details cannot
  // redirect a salary that was approved (the payment file reads this, not the current details).
  const sealed = new Map<string, string | null>();
  for (const person of people) {
    const bank = bankOf(await decryptSensitive(person, deps.keyring));
    sealed.set(person.id, bank ? await sealBank(bank, deps.keyring) : null);
  }

  const now = deps.now();
  // The finalising updates only apply when THIS write's claim of the run took effect.
  const claimed = () =>
    exists(
      db
        .select({ one: sql`1` })
        .from(r)
        .where(and(eq(r.id, runId), eq(r.status, 'approved'), eq(r.approvedBy, ctx.userId), eq(r.approvedAt, now))),
    );
  await atomically(db, (h) => [
    h
      .update(r)
      .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: now, updatedAt: now })
      .where(and(eq(r.id, runId), eq(r.status, 'calculated'))),
    ...ordered.map((slip) =>
      h
        .update(s)
        .set({
          status: 'final',
          number: numbers.get(slip.id)!,
          snapshot: { ...(slip.snapshot as Record<string, unknown>), bankEncrypted: sealed.get(slip.employeeId) ?? null },
          updatedAt: now,
        })
        .where(and(eq(s.id, slip.id), eq(s.status, 'draft'), claimed())),
    ),
  ]);

  const after = await requireRun(db, runId);
  if (after.status !== 'approved' || after.approvedBy !== ctx.userId || after.approvedAt?.getTime() !== now.getTime()) {
    throw new HrConflictError('This pay run was approved or changed by someone else');
  }
  const finals = await db.select().from(s).where(and(eq(s.runId, runId), eq(s.status, 'final')));
  return { run: after, employer, finals };
}

export async function approveRun(db: Database, runId: string, deps: PayrollDeps, ctx: { userId: string }): Promise<ApproveResult> {
  let approved: Approved | null = null;
  for (let attempt = 1; !approved; attempt += 1) {
    try {
      approved = await claimAndFinalise(db, runId, deps, ctx);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A racing approval for the same employer took the numbers first. Start over: the checks run again.
      if (attempt >= 3) throw new HrConflictError('Another pay run of this employer is being approved right now. Try again in a moment.');
    }
  }
  const { run, employer, finals } = approved;

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

/**
 * Approving a payment run, and making its payments when the last approval is in.
 *
 * Approvals are distinct users with `banking:manage`. A run needs
 * `requiredApprovals` of them (two for ACH unless a manager lowered it, one
 * for checks). The approver who made the run counts as one of two but never
 * as the only one.
 *
 * Holds are evaluated again at every approval, so a vendor whose bank details
 * changed after the run was made is held, whoever approved before. Only when
 * the last approval is recorded do the payments exist: one per vendor that
 * isn't held, allocated over its bills and posted to the ledger, linked to
 * the run, and numbered for a check run. A vendor that 24% backup withholding
 * applies to is paid the net: the bills settle for the gross, the bank is
 * credited the net and the withheld part is booked to Backup Withholding
 * Payable (worked out here, per vendor, as the payment is made). Creating the
 * payments can fail midway (a closed period, a bill paid elsewhere); the
 * approvals stay recorded, nothing is created twice (each payment has an id
 * derived from the run and the vendor), and approving again finishes the job.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { assertPostingAllowed } from '@weldsuite/books-domain/accounting-guards';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { paymentNetAmount } from '../accounting-payments';
import { PaymentRunError } from './errors';
import { activeHolds, encodeHolds, heldPartyIds, type RunHold } from './holds';
import {
  assertStatus,
  loadBankAccount,
  loadRun,
  refreshHolds,
  resolveItems,
  totalsOf,
  type BankAccountRow,
  type RunItem,
  type RunMethod,
  type RunRow,
} from './runs';
import { createRunPayment, numberUnnumberedChecks, runPaymentId } from './payments';
import { computeRunWithholding } from './withholding';

export interface RunPaymentView {
  paymentId: string;
  partyId: string;
  partyName: string;
  /** What the payment settles with the vendor's bills, before withholding. */
  amount: string;
  /** Backup withholding kept back from the vendor; null when none. */
  backupWithholdingAmount: string | null;
  /** What the bank is credited, the check is written for and the NACHA file pays: `amount` less the withholding. */
  netAmount: string;
  checkNumber: string | null;
  /** Made by this call (not found from an earlier, interrupted one). */
  created: boolean;
}

export interface ApproveResult {
  run: RunRow;
  /** Approvals recorded so far, this one included. */
  approvalCount: number;
  /** The last approval is in and the payments exist. */
  approved: boolean;
  holds: RunHold[];
  payments: RunPaymentView[];
}

/** Two approvals need two different people, and the run's creator can't be the only approver. */
export function hasIndependentApprover(run: Pick<RunRow, 'createdBy' | 'requiredApprovals'>, approvers: string[]): boolean {
  if (run.requiredApprovals < 2) return true;
  return approvers.some((id) => id !== run.createdBy);
}

function payDate(run: Pick<RunRow, 'paymentDate'>): Date {
  return new Date(`${run.paymentDate}T00:00:00.000Z`);
}

/** Payments a run already made (the payment is linked to its run in the posting that makes it), voided ones too when asked. */
async function findRunPayments(db: Database, run: RunRow, opts: { partyIds?: string[]; includeDeleted?: boolean } = {}) {
  return db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.entityId, run.entityId),
        eq(schema.payments.type, 'sent'),
        eq(schema.payments.paymentRunId, run.id),
        ...(opts.includeDeleted ? [] : [isNull(schema.payments.deletedAt)]),
        ...(opts.partyIds ? [inArray(schema.payments.contactId, opts.partyIds)] : []),
      ),
    );
}

interface Preflight {
  bank: BankAccountRow;
  holds: RunHold[];
  payable: RunItem[];
}

/** Everything that can be checked before the first payment is made, so a run fails whole or not at all. */
async function preflight(db: Database, run: RunRow, userId: string): Promise<Preflight & { run: RunRow }> {
  const bank = await loadBankAccount(db, run.entityId, run.bankAccountId);
  const refreshed = await refreshHolds(db, run, bank);
  const holds = refreshed.holds;
  const held = heldPartyIds(holds);
  // Vendors an interrupted attempt already paid stay in the run, held or not, and aren't checked again.
  const alreadyPaid = new Set((await findRunPayments(db, run)).map((p) => p.contactId));
  const payable = (refreshed.run.items ?? []).filter((i) => !held.has(i.partyId) || alreadyPaid.has(i.partyId));
  const unpaid = payable.filter((i) => !alreadyPaid.has(i.partyId));
  const prenotes = run.method === 'ach' ? holds.filter((h) => h.code === 'prenote_required' && !h.released) : [];
  if (payable.length === 0 && prenotes.length === 0) {
    throw new PaymentRunError(
      'NOTHING_TO_PAY',
      'Every vendor in this run is on hold. Release the holds, or fix the vendors, before approving.',
      409,
      { holds: activeHolds(holds).map((h) => ({ partyId: h.partyId, code: h.code })) },
    );
  }

  if (unpaid.length > 0) {
    try {
      await resolveItems(db, run.entityId, unpaid.map((i) => ({ billId: i.billId, amount: i.amount })));
    } catch (err) {
      if (err instanceof PaymentRunError && err.status === 400) {
        throw new PaymentRunError(
          'BILLS_CHANGED',
          `A bill in this run changed since it was planned: ${err.message} Reject the run, adjust it and submit it again.`,
          409,
          { cause: err.code, ...(err.details ?? {}) },
        );
      }
      throw err;
    }
    await assertPostingAllowed(db, {
      entityId: run.entityId,
      date: payDate(run),
      kind: 'general',
      affectsTax: false,
      userId,
    });
  }
  if (run.method === 'check' && unpaid.length > 0 && (bank.nextCheckNumber === null || bank.nextCheckNumber === undefined)) {
    throw new PaymentRunError('CHECK_NUMBER_REQUIRED', 'Set the next check number in the bank account\'s check settings.', 409);
  }
  return { run: refreshed.run, bank, holds, payable };
}

/** Record one approval; the last one makes the payments. */
export async function approveRun(
  db: Database,
  args: { entityId: string; runId: string; userId: string },
): Promise<ApproveResult> {
  const loaded = await loadRun(db, args.entityId, args.runId);
  assertStatus(loaded, ['pending_approval'], 'approved');

  const { run, bank, holds, payable } = await preflight(db, loaded, args.userId);
  const approvals = run.approvals ?? [];
  const alreadyComplete = approvals.length >= run.requiredApprovals;

  let current = approvals;
  if (!alreadyComplete) {
    if (approvals.some((a) => a.userId === args.userId)) {
      throw new PaymentRunError(
        'ALREADY_APPROVED',
        run.requiredApprovals > 1
          ? 'You already approved this run. A second approver has to be someone else.'
          : 'You already approved this run.',
        409,
      );
    }
    current = [...approvals, { userId: args.userId, at: new Date().toISOString() }];
    if (current.length >= run.requiredApprovals && !hasIndependentApprover(run, current.map((a) => a.userId))) {
      // With distinct approvers a second approval is always someone else; the guard states the rule.
      throw new PaymentRunError('NEEDS_SECOND_APPROVER', 'The person who made this run can\'t be its only approver.', 409);
    }
    // Compare-and-set on the approvals so two approvers arriving together can't both finish the run.
    const [recorded] = await db
      .update(schema.paymentRuns)
      .set({ approvals: current, updatedAt: new Date() })
      .where(
        and(
          eq(schema.paymentRuns.id, run.id),
          eq(schema.paymentRuns.status, 'pending_approval'),
          approvals.length === 0
            ? or(isNull(schema.paymentRuns.approvals), sql`${schema.paymentRuns.approvals} = '[]'::jsonb`)
            : sql`${schema.paymentRuns.approvals} = ${JSON.stringify(approvals)}::jsonb`,
        ),
      )
      .returning({ id: schema.paymentRuns.id });
    if (!recorded) {
      throw new PaymentRunError('CONFLICT', 'Someone else just approved this run. Reload it to see where it stands.', 409);
    }
  }

  if (current.length < run.requiredApprovals) {
    const [updated] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, run.id)).limit(1);
    return { run: updated ?? run, approvalCount: current.length, approved: false, holds, payments: [] };
  }

  const payments = await makePayments(db, { ...run, approvals: current }, bank, payable, args.userId);
  const totals = totalsOf(run.items ?? [], holds);
  const [approved] = await db
    .update(schema.paymentRuns)
    .set({
      status: 'approved',
      approvals: current,
      holds: encodeHolds(holds),
      totalAmount: payments.reduce((sum, p) => Math.round((sum + Number(p.amount)) * 100) / 100, 0).toFixed(2),
      paymentCount: payments.length || totals.paymentCount,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.paymentRuns.id, run.id), eq(schema.paymentRuns.status, 'pending_approval')))
    .returning();
  return { run: approved ?? run, approvalCount: current.length, approved: true, holds, payments };
}

/** The payments of an approved run, one per vendor that isn't held. Safe to call again after a failure. */
async function makePayments(
  db: Database,
  run: RunRow,
  bank: BankAccountRow,
  payable: RunItem[],
  userId: string,
): Promise<RunPaymentView[]> {
  const method = run.method as RunMethod;
  const partyIds = [...new Set(payable.map((i) => i.partyId))];
  if (partyIds.length === 0) return [];

  const parties = await db.select().from(schema.parties).where(inArray(schema.parties.id, partyIds));
  const nameOf = new Map(parties.map((p) => [p.id, p.displayName ?? p.id]));
  partyIds.sort((a, b) => (nameOf.get(a) ?? a).localeCompare(nameOf.get(b) ?? b) || a.localeCompare(b));

  // What the run already paid these vendors (an earlier, interrupted attempt), voided payments included.
  const existing = await findRunPayments(db, run, { partyIds, includeDeleted: true });
  const liveByParty = new Map(existing.filter((p) => !p.deletedAt).map((p) => [p.contactId, p]));
  const voidedFor = (partyId: string) => existing.filter((p) => p.contactId === partyId && p.deletedAt).length;

  // Backup withholding of the vendors still to be paid, worked out per vendor as its payment is made.
  const withholding = await computeRunWithholding(db, {
    entityId: run.entityId,
    method,
    paymentDate: payDate(run),
    items: payable.filter((i) => !liveByParty.has(i.partyId)),
    parties,
  });

  const views: RunPaymentView[] = [];
  for (const partyId of partyIds) {
    const found = liveByParty.get(partyId);
    if (found) {
      views.push({
        paymentId: found.id,
        partyId,
        partyName: nameOf.get(partyId) ?? partyId,
        amount: found.amount,
        backupWithholdingAmount: found.backupWithholdingAmount,
        netAmount: paymentNetAmount(found).toFixed(2),
        checkNumber: found.checkNumber,
        created: false,
      });
      continue;
    }
    const own = payable.filter((i) => i.partyId === partyId);
    const created = await createRunPayment(db, {
      // The same vendor in the same run is the same payment: approving again can't pay it twice.
      id: await runPaymentId(run.id, partyId, voidedFor(partyId)),
      entityId: run.entityId,
      runId: run.id,
      method,
      bankAccountId: bank.id,
      partyId,
      date: payDate(run),
      allocations: own.map((i) => ({ billId: i.billId, amount: i.amount })),
      backupWithholdingAmount: withholding.get(partyId)?.amount ?? 0,
      userId,
    });
    views.push({
      paymentId: created.paymentId,
      partyId,
      partyName: nameOf.get(partyId) ?? partyId,
      amount: created.amount.toFixed(2),
      backupWithholdingAmount: created.backupWithholdingAmount > 0 ? created.backupWithholdingAmount.toFixed(2) : null,
      netAmount: created.netAmount.toFixed(2),
      checkNumber: created.checkNumber,
      created: true,
    });
  }

  if (method === 'check') {
    await numberUnnumberedChecks(db, run.id, bank.id);
    const numbered = await db
      .select({ id: schema.payments.id, checkNumber: schema.payments.checkNumber })
      .from(schema.payments)
      .where(inArray(schema.payments.id, views.map((v) => v.paymentId)));
    const numberById = new Map(numbered.map((n) => [n.id, n.checkNumber]));
    for (const view of views) view.checkNumber = numberById.get(view.paymentId) ?? view.checkNumber;
  }
  return views;
}

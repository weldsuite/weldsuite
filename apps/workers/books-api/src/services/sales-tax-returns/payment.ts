/**
 * Recording the payment of a filed return.
 *
 * One journal entry settles the return:
 *   debit  the agency's sales tax payable   what the return pays of collected tax
 *   debit  the agency's use tax payable     use tax due
 *   debit  tax expense                      tax on exempt sales without a certificate (never collected)
 *   adjustments, each on its own account    vendor discount (credit, other income), penalty and interest
 *                                           (debit, expense), rounding, a prepayment (credit: it reverses the
 *                                           debit the earlier prepayment left on the payable), other
 *   credit the bank's ledger account        the amount paid
 * When the amount paid differs from the total due, the difference goes to the
 * rounding account with the user's reason. Posted once per return (posting key
 * `tax_return:<id>:payment`); the return becomes `paid` in the same batch.
 */

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  type EntityAccounts,
  type PostingLine,
} from '../accounting-posting';
import {
  TaxReturnError,
  computeTotalDue,
  num,
  round2,
  sumMoney,
  type AgencyRow,
  type EntityRow,
  type ReturnAdjustment,
  type ReturnRow,
} from './common';
import { summaryOf, type ReturnSummary } from './calculate';

export interface PaymentInput {
  entity: EntityRow;
  agency: AgencyRow;
  ret: ReturnRow;
  bankAccountId: string;
  amount: number;
  /** `YYYY-MM-DD`. */
  date: string;
  reference?: string | null;
  differenceReason?: string | null;
  userId: string | null;
}

export interface PaymentResult {
  ret: ReturnRow;
  journalEntryId: string | null;
  totalDue: number;
  difference: number;
  lines: Array<{ accountId: string; debit: number; credit: number; description: string | null }>;
}

const ADJUSTMENT_LABELS: Record<ReturnAdjustment['type'], string> = {
  vendor_discount: 'Vendor discount',
  prepayment: 'Prepayment credit',
  penalty: 'Penalty',
  interest: 'Interest',
  rounding: 'Rounding',
  other: 'Other adjustment',
};

function required(account: { id: string } | undefined, what: string): { id: string } {
  if (!account) throw new TaxReturnError(`No ${what} account found for this accounting entity`);
  return account;
}

/** The ledger lines of a return's payment (no bank line). */
export function paymentLines(args: {
  accounts: EntityAccounts;
  agency: AgencyRow;
  ret: Pick<ReturnRow, 'summary' | 'adjustments' | 'periodStart' | 'periodEnd'>;
  difference: number;
  differenceReason: string | null;
}): { lines: PostingLine[]; liabilityDebit: number } {
  const { accounts, agency } = args;
  const summary = (summaryOf(args.ret) ?? {}) as Partial<ReturnSummary>;
  const liability = accounts.byId(agency.liabilityAccountId) ?? accountForRole(accounts, 'sales_tax_payable', ['2200']);
  const useTax = accounts.byId(agency.useTaxAccountId) ?? accountForRole(accounts, 'use_tax_payable', ['2210']);
  const period = `${args.ret.periodStart} to ${args.ret.periodEnd}`;
  const lines: PostingLine[] = [];
  let liabilityDebit = 0;

  const sales = num(summary.salesTaxPayable);
  const uncured = num(summary.uncuredTaxPayable);
  const use = num(summary.useTaxPayable);
  if (sales - uncured !== 0) {
    lines.push({ accountId: required(liability, 'sales tax payable').id, debit: round2(sales - uncured), description: `Sales tax ${agency.name} ${period}` });
    liabilityDebit += sales - uncured;
  }
  if (uncured !== 0) {
    const expense = required(accountForRole(accounts, 'tax_penalties_interest', ['7040']), 'tax penalties and interest');
    lines.push({ accountId: expense.id, debit: round2(uncured), description: `Sales tax on exempt sales without a certificate ${agency.name} ${period}` });
  }
  if (use !== 0) {
    lines.push({ accountId: required(useTax, 'use tax payable').id, debit: round2(use), description: `Use tax ${agency.name} ${period}` });
    liabilityDebit += use;
  }

  for (const adj of (args.ret.adjustments ?? []) as ReturnAdjustment[]) {
    if (adj.amount === 0) continue;
    let account: { id: string };
    switch (adj.type) {
      case 'vendor_discount':
        account = required(accountForRole(accounts, 'sales_tax_vendor_discount', ['4110']), 'sales tax vendor discount');
        break;
      case 'penalty':
      case 'interest':
        account = required(accountForRole(accounts, 'tax_penalties_interest', ['7040']), 'tax penalties and interest');
        break;
      case 'rounding':
        account = required(accountForRole(accounts, 'rounding', ['7110']), 'rounding');
        break;
      case 'prepayment':
        account = required(liability, 'sales tax payable');
        break;
      default: {
        const chosen = adj.accountId ? accounts.byId(adj.accountId) : undefined;
        if (adj.accountId && !chosen) throw new TaxReturnError(`Adjustment account ${adj.accountId} does not belong to this accounting entity`);
        account = chosen ?? required(liability, 'sales tax payable');
      }
    }
    lines.push({
      accountId: account.id,
      debit: round2(adj.amount),
      description: `${ADJUSTMENT_LABELS[adj.type]} ${agency.name} ${period}${adj.note ? `: ${adj.note}` : ''}`,
    });
    if (account.id === liability?.id || account.id === useTax?.id) liabilityDebit += adj.amount;
  }

  if (args.difference !== 0) {
    lines.push({
      accountId: required(accountForRole(accounts, 'rounding', ['7110']), 'rounding').id,
      debit: round2(args.difference),
      description: `Payment difference ${agency.name} ${period}: ${args.differenceReason ?? ''}`.trim(),
    });
  }
  return { lines, liabilityDebit: round2(liabilityDebit) };
}

export async function recordReturnPayment(db: Database, input: PaymentInput): Promise<PaymentResult> {
  const { entity, agency, ret } = input;
  if (ret.status === 'paid') throw new TaxReturnError('This return has already been paid', 'conflict');
  if (ret.status !== 'filed') throw new TaxReturnError('File the return before recording its payment');

  const summary = (summaryOf(ret) ?? {}) as Partial<ReturnSummary>;
  const adjustments = (ret.adjustments ?? []) as ReturnAdjustment[];
  const totalDue = computeTotalDue(summary, adjustments);
  const amount = round2(input.amount);
  if (totalDue > 0 && amount < 0) throw new TaxReturnError('The amount paid cannot be negative for a return with tax due');
  if (totalDue < 0 && amount > 0) throw new TaxReturnError('A return with a credit is refunded, not paid: enter the refund as a negative amount');
  const difference = round2(amount - totalDue);
  const reason = input.differenceReason?.trim() || null;
  if (difference !== 0 && !reason) {
    throw new TaxReturnError(
      `The amount paid (${amount.toFixed(2)}) differs from the total due (${totalDue.toFixed(2)}). Give a reason for the difference.`,
      'bad_request',
      { totalDue, amount, difference },
    );
  }

  const [bank] = await db
    .select({ id: schema.bankAccounts.id, ledgerAccountId: schema.bankAccounts.ledgerAccountId, name: schema.bankAccounts.name })
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.id, input.bankAccountId), eq(schema.bankAccounts.entityId, entity.id)))
    .limit(1);
  if (!bank) throw new TaxReturnError(`Bank account ${input.bankAccountId} not found`, 'not_found');
  if (!bank.ledgerAccountId) throw new TaxReturnError(`Bank account ${bank.name} is not linked to a ledger account`);

  const accounts = await loadEntityAccounts(db, entity.id);
  const { lines, liabilityDebit } = paymentLines({ accounts, agency, ret, difference, differenceReason: reason });
  const period = `${ret.periodStart} to ${ret.periodEnd}`;
  if (amount !== 0) {
    lines.push({
      accountId: bank.ledgerAccountId,
      credit: amount,
      description: `Sales tax payment ${agency.name} ${period}${input.reference ? ` (${input.reference})` : ''}`,
    });
  }

  const paidAt = new Date(`${input.date}T00:00:00Z`);
  const now = new Date();
  const payment = {
    date: input.date,
    amount,
    reference: input.reference ?? null,
    difference,
    differenceReason: reason,
    liabilityDebit,
    /** Collected sales tax and use tax settled, apart from prepayments and other adjustments on the payable. */
    taxSettled: round2(num(summary.salesTaxPayable) - num(summary.uncuredTaxPayable) + num(summary.useTaxPayable)),
    bankAccountId: bank.id,
  };
  const markPaid = (h: Database, journalEntryId: string | null) =>
    h
      .update(schema.taxReturns)
      .set({
        status: 'paid',
        paidAt,
        paymentAmount: amount.toFixed(2),
        paymentBankAccountId: bank.id,
        paymentJournalEntryId: journalEntryId,
        summary: { ...(ret.summary ?? {}), payment: { ...payment, journalEntryId } },
        totalDue: totalDue.toFixed(2),
        updatedAt: now,
      })
      .where(and(eq(schema.taxReturns.id, ret.id), eq(schema.taxReturns.status, 'filed')));

  const posted = await postJournalEntry(db, {
    entityId: entity.id,
    date: paidAt,
    description: `Sales tax payment ${agency.name} ${period}`,
    reference: input.reference ?? ret.confirmationNumber,
    sourceType: 'tax_return',
    sourceId: ret.id,
    postingKey: `tax_return:${ret.id}:payment`,
    lockKind: 'general',
    isAutomatic: false,
    createdBy: input.userId,
    lines,
    alsoWrite: (h, entry) => [markPaid(h, entry.journalEntryId)],
  });
  // Nothing to post (a nil return), or the entry exists from an earlier attempt: settle the return itself.
  const [current] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);
  if (current && current.status === 'filed') await markPaid(db, posted.journalEntryId);
  const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ret.id)).limit(1);

  return {
    ret: updated!,
    journalEntryId: posted.journalEntryId,
    totalDue,
    difference,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: round2(l.debit ?? 0),
      credit: round2(l.credit ?? 0),
      description: l.description ?? null,
    })),
  };
}

/** The tax a paid return settled against the agency's payable accounts (collected sales tax and use tax). */
export function settledAgainstPayable(ret: Pick<ReturnRow, 'status' | 'summary'>): number {
  if (ret.status !== 'paid') return 0;
  const payment = (ret.summary as { payment?: { taxSettled?: number; liabilityDebit?: number } } | null)?.payment;
  return round2(num(payment?.taxSettled ?? payment?.liabilityDebit));
}

/** The tax a filed, unpaid return still holds on the agency's payable accounts: collected sales tax and use tax. */
export function owedByFiledReturn(ret: Pick<ReturnRow, 'status' | 'summary'>): number {
  if (ret.status !== 'filed') return 0;
  const summary = summaryOf(ret);
  return sumMoney([num(summary?.salesTaxPayable) - num(summary?.uncuredTaxPayable), num(summary?.useTaxPayable)]);
}

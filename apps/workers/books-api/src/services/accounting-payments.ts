/**
 * Recording and voiding payments.
 *
 * A payment can settle several invoices or bills (allocations). Recording one
 * writes the payment, its allocations, the documents' new paid amounts and
 * statuses, the bank-line reconciliation (when it came from a bank line) and
 * its journal entry as one atomic posting; a realized FX difference posts
 * separately. Voiding reverses all of that.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { calculateFxGainLoss } from './accounting-currency';
import {
  formatRate,
  isForeignCurrency,
  MissingExchangeRateError,
  parseRate,
  resolveRate,
} from './accounting-fx';
import { resolveEntityBaseCurrency } from '../lib/entity-context';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  PostingError,
  reverseJournalEntry,
  roundMoney,
  type EntityAccounts,
} from './accounting-posting';
import { buildPaymentPosting, settlementSet, type PaymentAllocationInput } from './accounting-document-posting';
import { findRecoveryEntries, postBadDebtRecovery, writtenOffBalance, writtenOffSettlementSet } from './accounting-bad-debt';

export const PAYMENT_METHODS = [
  'check',
  'ach',
  'wire',
  'credit_card',
  'debit_card',
  'cash',
  'third_party_network',
  'bank_transfer',
  'direct_debit',
  'ideal',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Values older clients send, mapped onto the method list. */
const LEGACY_METHODS: Record<string, PaymentMethod> = {
  card: 'credit_card',
  manual: 'other',
  bank: 'bank_transfer',
  transfer: 'bank_transfer',
};

export function normalizePaymentMethod(method: string | null | undefined): PaymentMethod | null {
  if (!method) return null;
  const value = method.trim().toLowerCase();
  if ((PAYMENT_METHODS as readonly string[]).includes(value)) return value as PaymentMethod;
  return LEGACY_METHODS[value] ?? 'other';
}

/**
 * What a payment moved through the bank: its amount less any backup
 * withholding kept back (the bank is credited the net, the withheld part goes
 * to Backup Withholding Payable). This is what a bank line, a printed check, a
 * NACHA entry or a Positive Pay record carries, and what bank matching compares.
 */
export function paymentNetAmount(payment: { amount: string | null; backupWithholdingAmount?: string | null }): number {
  return roundMoney(Number.parseFloat(payment.amount ?? '0') - Number.parseFloat(payment.backupWithholdingAmount ?? '0'));
}

export type DepositTarget = 'undeposited_funds' | 'bank';

/**
 * Where a received payment lands. An entity with an Undeposited Funds account
 * (the US chart) parks checks and cash there until a bank deposit groups them
 * into the single line the bank shows; every other payment, and every entity
 * without that account (NL, IN), debits the bank straight away. A payment that
 * names its bank account or comes from a bank line already is in the bank.
 */
export function resolveDepositTarget(
  input: Pick<RecordPaymentInput, 'type' | 'depositTo' | 'bankAccountId' | 'bankTransactionId'>,
  method: PaymentMethod | null,
  hasUndepositedFunds: boolean,
): DepositTarget {
  if (input.type !== 'received' || input.depositTo === 'bank') return 'bank';
  if (!hasUndepositedFunds) {
    if (input.depositTo === 'undeposited_funds') {
      throw new PostingError('This accounting entity has no Undeposited Funds account');
    }
    return 'bank';
  }
  if (input.depositTo === 'undeposited_funds') return 'undeposited_funds';
  if (input.bankTransactionId || input.bankAccountId) return 'bank';
  return method === 'check' || method === 'cash' ? 'undeposited_funds' : 'bank';
}

export interface RecordPaymentInput {
  /** A caller-chosen payment id, for idempotency: recording the same id again returns the payment it made. */
  id?: string;
  entityId: string;
  type: 'received' | 'sent';
  amount: number;
  currency?: string | null;
  exchangeRate?: string | null;
  date: Date;
  paymentMethod?: string | null;
  checkNumber?: string | null;
  /** Checks: to_print | printed | voided | cleared. A check we issue defaults to `printed` (payment runs pass `to_print`). */
  checkStatus?: string | null;
  /** Received payments: park the money in Undeposited Funds or debit the bank. Defaults per `resolveDepositTarget`. */
  depositTo?: DepositTarget | null;
  reference?: string | null;
  notes?: string | null;
  contactId?: string | null;
  bankAccountId?: string | null;
  bankTransactionId?: string | null;
  /** How a bank line came to be matched (when the payment comes from one). */
  reconciliationType?: 'manual' | 'auto' | null;
  /** The check or ACH run that made the payment. */
  paymentRunId?: string | null;
  /**
   * Backup withholding on a payment to a vendor. `amount` is the gross (what the
   * bills settle for), the bank is credited the net and the withheld part is
   * credited to Backup Withholding Payable; the payment stores it for Form 945 and box 4.
   */
  backupWithholdingAmount?: number | null;
  allocations: Array<{ invoiceId?: string | null; billId?: string | null; amount: number }>;
  userId: string | null;
}

export interface RecordPaymentResult {
  paymentId: string;
  journalEntryId: string | null;
  contactId: string;
  currency: string;
  documents: Array<{ type: 'invoice' | 'bill'; id: string }>;
  /** True when the money went to Undeposited Funds and still has to be put into a bank deposit. */
  undeposited: boolean;
}

type DocumentRow = {
  id: string;
  entityId: string;
  /** Invoices: standard | credit_note | ...; bills: standard. */
  type: string | null;
  contactId: string;
  currency: string | null;
  exchangeRate: string | null;
  balanceDue: string | null;
  status: string;
  number: string | null;
  /** Invoices: what a written-off ('uncollectible') one still has written off is total less amount paid. */
  total?: string | null;
  amountPaid?: string | null;
};

async function loadDocuments(db: Database, kind: 'invoice' | 'bill', ids: string[]): Promise<Map<string, DocumentRow>> {
  if (ids.length === 0) return new Map();
  if (kind === 'invoice') {
    const rows = await db
      .select()
      .from(schema.invoices)
      .where(and(inArray(schema.invoices.id, ids), isNull(schema.invoices.deletedAt)));
    return new Map(rows.map((r) => [r.id, { ...r, number: r.invoiceNumber }]));
  }
  const rows = await db
    .select()
    .from(schema.bills)
    .where(and(inArray(schema.bills.id, ids), isNull(schema.bills.deletedAt)));
  return new Map(rows.map((r) => [r.id, { ...r, number: r.billNumber }]));
}

function assertPayable(kind: 'invoice' | 'bill', doc: DocumentRow) {
  if (kind === 'invoice' && doc.status === 'draft') {
    throw new PostingError(`Invoice ${doc.number ?? doc.id} is a draft. Finalize it before recording a payment.`);
  }
  // A written-off ('uncollectible') invoice can still be paid: the write-off is taken back (bad debt recovery).
  if (kind === 'invoice' && doc.status === 'cancelled') {
    throw new PostingError(`Invoice ${doc.number ?? doc.id} is ${doc.status} and can't take payments.`);
  }
  if (kind === 'bill' && (doc.status === 'draft' || doc.status === 'cancelled')) {
    throw new PostingError(`Bill ${doc.number ?? doc.id} must be approved before it can be paid.`);
  }
}

/** The payment a caller-chosen id already made, as `recordPayment` returns it. */
async function existingPayment(db: Database, input: RecordPaymentInput): Promise<RecordPaymentResult | null> {
  if (!input.id) return null;
  const [existing] = await db.select().from(schema.payments).where(eq(schema.payments.id, input.id)).limit(1);
  if (!existing) return null;
  if (existing.entityId !== input.entityId || existing.deletedAt) {
    throw new PostingError(`Payment id ${input.id} is already used`);
  }
  const allocated = await db
    .select({ invoiceId: schema.paymentAllocations.invoiceId, billId: schema.paymentAllocations.billId })
    .from(schema.paymentAllocations)
    .where(and(eq(schema.paymentAllocations.paymentId, existing.id), isNull(schema.paymentAllocations.deletedAt)));
  return {
    paymentId: existing.id,
    journalEntryId: existing.journalEntryId,
    contactId: existing.contactId,
    currency: existing.currency ?? (await resolveEntityBaseCurrency(db, input.entityId)),
    documents: allocated.map((a) =>
      a.invoiceId ? { type: 'invoice' as const, id: a.invoiceId } : { type: 'bill' as const, id: a.billId! },
    ),
    undeposited: false,
  };
}

export async function recordPayment(db: Database, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  const already = await existingPayment(db, input);
  if (already) return already;
  if (!(input.amount > 0)) throw new PostingError('Payment amount must be greater than zero');
  const withheld = roundMoney(input.backupWithholdingAmount ?? 0);
  if (withheld !== 0 && (input.type !== 'sent' || withheld < 0 || withheld > roundMoney(input.amount))) {
    throw new PostingError('Backup withholding applies to payments to vendors and can not be more than the payment');
  }

  // A received payment settles invoices. A sent one settles bills, or refunds
  // a customer credit note (an invoice of type credit_note).
  for (const a of input.allocations) {
    if (!(a.amount > 0)) throw new PostingError('Allocation amounts must be greater than zero');
    const valid = input.type === 'received' ? Boolean(a.invoiceId) && !a.billId : Boolean(a.invoiceId) !== Boolean(a.billId);
    if (!valid) {
      throw new PostingError(
        input.type === 'received'
          ? 'A received payment can only be allocated to invoices'
          : 'A sent payment can only be allocated to bills',
      );
    }
  }

  const docIds = input.allocations.map((a) => (a.invoiceId ?? a.billId)!);
  if (new Set(docIds).size !== docIds.length) throw new PostingError('Each document can only be allocated once per payment');
  const docs = new Map([
    ...(await loadDocuments(db, 'invoice', input.allocations.filter((a) => a.invoiceId).map((a) => a.invoiceId!))),
    ...(await loadDocuments(db, 'bill', input.allocations.filter((a) => a.billId).map((a) => a.billId!))),
  ]);

  const allocations: PaymentAllocationInput[] = [];
  let allocatedTotal = 0;
  for (const allocation of input.allocations) {
    const kind: 'invoice' | 'bill' = allocation.invoiceId ? 'invoice' : 'bill';
    const id = (allocation.invoiceId ?? allocation.billId)!;
    const doc = docs.get(id);
    if (!doc) throw new PostingError(`${kind === 'invoice' ? 'Invoice' : 'Bill'} ${id} not found`);
    if (doc.entityId !== input.entityId) {
      throw new PostingError(`Linked ${kind} belongs to a different accounting entity`);
    }
    const creditNote = kind === 'invoice' && doc.type === 'credit_note';
    if (input.type === 'received' && creditNote) {
      throw new PostingError(
        `${doc.number ?? doc.id} is a credit note: the money goes back to the customer. Record a refund (a payment sent) instead.`,
      );
    }
    if (input.type === 'sent' && kind === 'invoice' && !creditNote) {
      throw new PostingError('A sent payment can only be allocated to bills or refund a credit note');
    }
    assertPayable(kind, doc);
    // A written-off invoice has no open balance; what can still come in is what was written off.
    const open = kind === 'invoice' && doc.status === 'uncollectible' ? writtenOffBalance({ status: doc.status, total: doc.total ?? null, amountPaid: doc.amountPaid ?? null }) : Number.parseFloat(doc.balanceDue ?? '0');
    if (allocation.amount > open + 0.005) {
      throw new PostingError(
        `The amount allocated to ${doc.number ?? doc.id} (${allocation.amount.toFixed(2)}) is more than its open balance (${open.toFixed(2)})`,
      );
    }
    allocatedTotal = roundMoney(allocatedTotal + allocation.amount);
    allocations.push({
      invoiceId: kind === 'invoice' ? id : null,
      billId: kind === 'bill' ? id : null,
      amount: allocation.amount,
      contactId: doc.contactId,
    });
  }
  if (allocatedTotal > roundMoney(input.amount) + 0.005) {
    throw new PostingError('Allocations exceed the payment amount');
  }

  const firstDoc = allocations.length > 0 ? docs.get(docIds[0]) : undefined;
  const contactId = input.contactId ?? firstDoc?.contactId;
  if (!contactId) throw new PostingError('A payment needs a contact or at least one invoice or bill');
  const baseCurrency = await resolveEntityBaseCurrency(db, input.entityId);
  const currency = input.currency ?? firstDoc?.currency ?? baseCurrency;
  // A payment settles documents in their own currency: the amounts allocated are document amounts.
  for (const a of allocations) {
    const doc = docs.get((a.invoiceId ?? a.billId)!)!;
    if (isForeignCurrency(baseCurrency, doc.currency) && doc.currency !== currency) {
      throw new PostingError(
        `${doc.number ?? doc.id} is in ${doc.currency}, so the payment has to be in ${doc.currency} too (it is in ${currency}).`,
      );
    }
  }
  // Foreign currency: the typed rate, else the rate on the payment date, else the one the
  // document was booked at (no difference then). Never 1 for another currency.
  let exchangeRate = '1';
  if (isForeignCurrency(baseCurrency, currency)) {
    const resolved = await resolveRate(db, { baseCurrency, currency, date: input.date, override: input.exchangeRate });
    const booked = parseRate(firstDoc?.exchangeRate);
    const rate = resolved?.rate ?? (booked && booked !== 1 ? formatRate(booked) : null);
    if (!rate) throw new MissingExchangeRateError(currency, baseCurrency, input.date);
    exchangeRate = rate;
  }
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  // The realised FX difference per document, with its accounts looked up before anything is posted.
  const fxPlan = await planFxDifferences(db, {
    entityId: input.entityId,
    type: input.type,
    paymentRate: exchangeRate,
    allocations: allocations.flatMap((a) => {
      const doc = docs.get((a.invoiceId ?? a.billId)!);
      // A refund of a foreign-currency credit note books no FX difference yet; a base-currency document has no rate to differ from.
      return doc && isForeignCurrency(baseCurrency, doc.currency) && !(input.type === 'sent' && a.invoiceId)
        ? [{ doc, amount: a.amount }]
        : [];
    }),
  });

  // Checks and cash on a US entity wait in Undeposited Funds instead of the bank.
  const undepositedFunds = accountForRole(await loadEntityAccounts(db, input.entityId), 'undeposited_funds');
  const toUndeposited = resolveDepositTarget(input, paymentMethod, Boolean(undepositedFunds)) === 'undeposited_funds';
  const lines = await buildPaymentPosting(
    db,
    {
      entityId: input.entityId,
      type: input.type,
      amount: input.amount,
      currency,
      exchangeRate,
      contactId,
      bankAccountId: input.bankAccountId,
      paymentMethod,
      reference: input.reference,
      moneyAccountId: toUndeposited && undepositedFunds ? undepositedFunds.id : null,
      backupWithholdingAmount: withheld > 0 ? withheld : null,
    },
    allocations,
  );
  const checkStatus = input.checkStatus ?? (paymentMethod === 'check' && input.type === 'sent' ? 'printed' : null);

  const paymentId = input.id ?? generateId('pay');
  const now = new Date();
  const single = allocations.length === 1 ? allocations[0] : undefined;
  const fullyAllocated = allocations.length > 0 && Math.abs(allocatedTotal - input.amount) < 0.005;

  // Written-off invoices: reinstate the receivable (and the bad debt VAT relief) so the payment can settle it.
  const recoveries = new Map<string, string>();
  for (const a of allocations) {
    const doc = a.invoiceId ? docs.get(a.invoiceId) : undefined;
    if (!a.invoiceId || !doc || doc.status !== 'uncollectible') continue;
    const [invoiceRow] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, a.invoiceId)).limit(1);
    const recovery = await postBadDebtRecovery(db, invoiceRow, { amount: a.amount, paymentId, date: input.date, userId: input.userId });
    if (recovery.journalEntryId) recoveries.set(a.invoiceId, recovery.journalEntryId);
  }

  let posted: Awaited<ReturnType<typeof postJournalEntry>>;
  try {
    posted = await postJournalEntry(db, {
      entityId: input.entityId,
      date: input.date,
      description: `${input.type === 'received' ? 'Payment received' : 'Payment sent'}${input.reference ? ` ${input.reference}` : ''}`,
      reference: input.reference ?? null,
      sourceType: 'payment',
      sourceId: paymentId,
      postingKey: `payment:${paymentId}`,
      lockKind: 'general',
      lines,
      createdBy: input.userId,
      alsoWrite: (h, entry) => {
        const statements: unknown[] = [
          h.insert(schema.payments).values({
            id: paymentId,
            entityId: input.entityId,
            type: input.type,
            amount: input.amount.toFixed(2),
            currency,
            exchangeRate,
            date: input.date,
            paymentMethod,
            checkNumber: input.checkNumber ?? null,
            checkStatus,
            checkPrintedAt: checkStatus === 'printed' ? now : null,
            reference: input.reference ?? null,
            invoiceId: single?.invoiceId ?? null,
            billId: single?.billId ?? null,
            contactId,
            counterpartyId: contactId,
            bankAccountId: input.bankAccountId ?? null,
            bankTransactionId: input.bankTransactionId ?? null,
            paymentRunId: input.paymentRunId ?? null,
            backupWithholdingAmount: withheld > 0 ? withheld.toFixed(2) : null,
            journalEntryId: entry.journalEntryId,
            notes: input.notes ?? null,
            isPartial: !fullyAllocated,
            createdBy: input.userId,
            createdAt: now,
            updatedAt: now,
          }),
        ];
        if (allocations.length > 0) {
          statements.push(
            h.insert(schema.paymentAllocations).values(
              allocations.map((a) => ({
                id: generateId('pal'),
                entityId: input.entityId,
                paymentId,
                invoiceId: a.invoiceId ?? null,
                billId: a.billId ?? null,
                amount: a.amount.toFixed(2),
                createdAt: now,
                updatedAt: now,
              })),
            ),
          );
        }
        for (const a of allocations) {
          if (a.invoiceId) {
            statements.push(
              h.update(schema.invoices).set(recoveries.has(a.invoiceId) ? writtenOffSettlementSet(a.amount) : settlementSet(schema.invoices, a.amount, 'sent')).where(eq(schema.invoices.id, a.invoiceId)),
            );
          } else if (a.billId) {
            statements.push(
              h.update(schema.bills).set(settlementSet(schema.bills, a.amount, 'approved')).where(eq(schema.bills.id, a.billId)),
            );
          }
        }
        if (input.bankTransactionId) {
          statements.push(
            h
              .update(schema.bankTransactions)
              .set({
                status: 'reconciled',
                reconciliationType: input.reconciliationType ?? 'manual',
                reconciledPaymentId: paymentId,
                reconciledInvoiceId: single?.invoiceId ?? null,
                reconciledBillId: single?.billId ?? null,
                journalEntryId: entry.journalEntryId,
                contactId,
                updatedAt: now,
              })
              .where(eq(schema.bankTransactions.id, input.bankTransactionId)),
          );
        }
        return statements;
      },
    });
  } catch (err) {
    // The payment did not post: take the reinstated receivable back so a retry does not reinstate it twice.
    for (const entryId of recoveries.values()) {
      await reverseJournalEntry(db, { entryId, date: input.date, createdBy: input.userId, description: `Undo write-off recovery of failed payment ${paymentId}` }).catch((undoErr) => {
        console.error('[payments] could not undo write-off recovery:', undoErr);
      });
    }
    throw err;
  }

  await postFxDifferences(db, { entityId: input.entityId, paymentId, plan: fxPlan, date: input.date, userId: input.userId });

  return {
    paymentId,
    journalEntryId: posted.journalEntryId,
    contactId,
    currency,
    documents: allocations.map((a) =>
      a.invoiceId ? { type: 'invoice' as const, id: a.invoiceId } : { type: 'bill' as const, id: a.billId! },
    ),
    undeposited: toUndeposited && Boolean(undepositedFunds),
  };
}

/**
 * Realised FX gain or loss on one document of a payment: the document was
 * booked at its own rate, the payment settles it at the rate of the payment
 * date. `delta` is what the payment is worth in base currency minus what the
 * document carried (positive: more base currency).
 */
export interface FxDifference {
  documentId: string;
  contactId: string;
  delta: number;
  gain: boolean;
  fxAccountId: string;
  settlementAccountId: string;
}

/**
 * The FX gain / loss account: the chart's realized_fx_gain / realized_fx_loss
 * role (NL, IN, US charts), the NL template code for older entities, else the
 * first other-income / other-expense account.
 */
function findFxAccount(accounts: EntityAccounts, gain: boolean) {
  return (
    accountForRole(accounts, gain ? 'realized_fx_gain' : 'realized_fx_loss', gain ? ['8400'] : ['4950']) ??
    accounts.bySubtype(gain ? 'other_income' : 'other_expense')
  );
}

/**
 * The FX differences of a payment, with their accounts, worked out before the
 * payment is posted so a chart without a gain / loss account refuses the
 * payment instead of leaving the receivable or payable off by the difference.
 * Money received that is worth more base currency than the invoice carried is
 * a gain; money paid that costs more than the bill carried is a loss.
 */
export async function planFxDifferences(
  db: Database,
  args: {
    entityId: string;
    type: 'received' | 'sent';
    paymentRate: string;
    allocations: Array<{ doc: Pick<DocumentRow, 'id' | 'contactId' | 'exchangeRate'>; amount: number }>;
  },
): Promise<FxDifference[]> {
  const paymentRate = parseRate(args.paymentRate);
  if (!paymentRate) return [];
  const differences: Array<Omit<FxDifference, 'gain' | 'fxAccountId' | 'settlementAccountId'>> = [];
  for (const { doc, amount } of args.allocations) {
    const documentRate = parseRate(doc.exchangeRate);
    if (!documentRate || documentRate === paymentRate) continue;
    const delta = calculateFxGainLoss(amount, paymentRate, documentRate);
    if (Math.abs(delta) >= 0.01) differences.push({ documentId: doc.id, contactId: doc.contactId, delta });
  }
  if (differences.length === 0) return [];

  const accounts = await loadEntityAccounts(db, args.entityId);
  const settlement =
    args.type === 'received'
      ? accountForRole(accounts, 'accounts_receivable', ['1300'])
      : accountForRole(accounts, 'accounts_payable', ['1600']);
  if (!settlement) {
    throw new PostingError(
      `No accounts ${args.type === 'received' ? 'receivable' : 'payable'} account found for this entity.`,
    );
  }
  return differences.map((d) => {
    const gain = args.type === 'received' ? d.delta > 0 : d.delta < 0;
    const fxAccount = findFxAccount(accounts, gain);
    if (!fxAccount) {
      throw new PostingError(
        `This payment settles a foreign-currency document at another rate than it was booked at, but the chart of accounts has no exchange ${gain ? 'gain' : 'loss'} account. Add an account with the role ${gain ? 'realized_fx_gain' : 'realized_fx_loss'} first.`,
      );
    }
    return { ...d, gain, fxAccountId: fxAccount.id, settlementAccountId: settlement.id };
  });
}

/**
 * Post the realised FX differences of a payment as one entry (so voiding the
 * payment reverses them in one go): a gain debits the receivable / payable
 * that the payment over-settled and credits the gain account, a loss the other
 * way round.
 */
async function postFxDifferences(
  db: Database,
  args: { entityId: string; paymentId: string; plan: FxDifference[]; date: Date; userId: string | null },
): Promise<void> {
  if (args.plan.length === 0) return;
  const lines = args.plan.flatMap((d) => {
    const amount = Math.abs(d.delta);
    const description = `FX ${d.gain ? 'gain' : 'loss'} adjustment`;
    return [
      { accountId: d.gain ? d.settlementAccountId : d.fxAccountId, debit: amount, contactId: d.contactId, description },
      { accountId: d.gain ? d.fxAccountId : d.settlementAccountId, credit: amount, contactId: d.contactId, description },
    ];
  });
  const net = args.plan.reduce((sum, d) => sum + (d.gain ? d.delta : -d.delta), 0);
  await postJournalEntry(db, {
    entityId: args.entityId,
    date: args.date,
    description: `FX ${net >= 0 ? 'gain' : 'loss'} on payment ${args.paymentId}`,
    sourceType: 'payment_fx_adjustment',
    sourceId: args.paymentId,
    postingKey: `payment:${args.paymentId}:fx`,
    lockKind: 'general',
    createdBy: args.userId,
    lines,
    alsoWrite: (h, entry) => [
      h
        .update(schema.payments)
        .set({ exchangeDifferenceEntryId: entry.journalEntryId, updatedAt: new Date() })
        .where(eq(schema.payments.id, args.paymentId)),
    ],
  });
}

/**
 * Void a payment: reverse its journal entry (and FX entry), put the paid
 * amounts back on its invoices/bills, release the bank line, soft-delete the
 * payment and its allocations — one atomic posting.
 */
export async function voidPayment(
  db: Database,
  paymentId: string,
  opts: { userId: string | null; date?: Date },
): Promise<typeof schema.payments.$inferSelect> {
  const [payment] = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.id, paymentId), isNull(schema.payments.deletedAt)))
    .limit(1);
  if (!payment) throw new PostingError('Payment not found');
  if (payment.depositId) {
    throw new PostingError('This payment is part of a bank deposit. Void the deposit first, then void the payment.');
  }

  const allocationRows = await db
    .select()
    .from(schema.paymentAllocations)
    .where(and(eq(schema.paymentAllocations.paymentId, paymentId), isNull(schema.paymentAllocations.deletedAt)));
  // Payments recorded before allocations existed settle a single document with their full amount.
  const allocations =
    allocationRows.length > 0
      ? allocationRows.map((a) => ({ invoiceId: a.invoiceId, billId: a.billId, amount: Number.parseFloat(a.amount) }))
      : payment.invoiceId || payment.billId
        ? [{ invoiceId: payment.invoiceId, billId: payment.billId, amount: Number.parseFloat(payment.amount) }]
        : [];

  const now = opts.date ?? new Date();
  // Invoices this payment took out of a write-off: their recovery is reversed too, and they go back to 'uncollectible'.
  const recoveryEntries = await findRecoveryEntries(
    db,
    paymentId,
    allocations.flatMap((a) => (a.invoiceId ? [a.invoiceId] : [])),
  );
  const undo = (h: Database): unknown[] => {
    const statements: unknown[] = [
      h.update(schema.payments).set({ deletedAt: now, updatedAt: now }).where(eq(schema.payments.id, paymentId)),
      h
        .update(schema.paymentAllocations)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.paymentAllocations.paymentId, paymentId)),
    ];
    for (const a of allocations) {
      if (a.invoiceId) {
        statements.push(
          h.update(schema.invoices).set(recoveryEntries.has(a.invoiceId) ? writtenOffSettlementSet(-a.amount) : settlementSet(schema.invoices, -a.amount, 'sent')).where(eq(schema.invoices.id, a.invoiceId)),
        );
      } else if (a.billId) {
        statements.push(
          h.update(schema.bills).set(settlementSet(schema.bills, -a.amount, 'approved')).where(eq(schema.bills.id, a.billId)),
        );
      }
    }
    statements.push(
      h
        .update(schema.bankTransactions)
        .set({
          status: 'unreconciled',
          reconciliationType: null,
          reconciledPaymentId: null,
          reconciledInvoiceId: null,
          reconciledBillId: null,
          journalEntryId: null,
          updatedAt: now,
        })
        .where(
          payment.bankTransactionId
            ? or(
                eq(schema.bankTransactions.reconciledPaymentId, paymentId),
                eq(schema.bankTransactions.id, payment.bankTransactionId),
              )
            : eq(schema.bankTransactions.reconciledPaymentId, paymentId),
        ),
    );
    return statements;
  };

  for (const entryId of recoveryEntries.values()) {
    await reverseJournalEntry(db, {
      entryId,
      date: now,
      createdBy: opts.userId,
      description: `Void write-off recovery of payment ${paymentId}`,
    });
  }

  if (payment.exchangeDifferenceEntryId) {
    await reverseJournalEntry(db, {
      entryId: payment.exchangeDifferenceEntryId,
      date: now,
      createdBy: opts.userId,
      description: `Void FX difference of payment ${paymentId}`,
    });
  }

  if (payment.journalEntryId) {
    await reverseJournalEntry(db, {
      entryId: payment.journalEntryId,
      date: now,
      createdBy: opts.userId,
      description: `Void payment ${payment.reference ?? paymentId}`,
      alsoWrite: (h) => undo(h),
    });
  } else {
    // A payment recorded before payments were posted: nothing to reverse in the ledger.
    await atomically(db, undo);
  }
  return payment;
}

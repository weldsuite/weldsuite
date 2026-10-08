/**
 * Auto-Reconciliation Engine
 *
 * Matches a bank transaction to what the books already know by:
 * 1. Exact amount + reference/betalingskenmerk (invoice number in the text)
 * 2. Exact amount + counterparty IBAN match to contact (EU)
 * 3. Exact amount + counterparty name similarity, inside the payment window
 *    (US statements carry no IBAN, only the payer's name in the text)
 * 4. Check number (+ amount) against a recorded payment, and a deposit's
 *    total against an incoming line
 *
 * Returns match suggestions with confidence scores.
 *
 * Matching runs over a set of candidates (open invoices and bills, payments
 * not yet tied to a bank line, deposits not yet matched) that is loaded once:
 * for one line only the rows near its amount, for a batch every open one, so
 * a batch costs a handful of queries however many lines it has.
 */

import { eq, and, isNull, or, sql, between, inArray, type SQL } from 'drizzle-orm';
import { schema as tables, type Database } from '@weldsuite/worker-kit/db';
import { reconcileBankTransactionToDocument, reconcileBankTransactionToPayment } from './accounting-bank-match';
import { daysApart, nameConfidence, nameSimilarity } from './accounting-bank-similarity';

type BankTransactionRow = typeof tables.bankTransactions.$inferSelect;
type InvoiceRow = typeof tables.invoices.$inferSelect;
type BillRow = typeof tables.bills.$inferSelect;
type PaymentRow = typeof tables.payments.$inferSelect;
type DepositRow = typeof tables.bankDeposits.$inferSelect;

// ============================================================================
// Types
// ============================================================================

export interface ReconciliationSuggestion {
  type: 'invoice' | 'bill' | 'rule' | 'payment' | 'deposit';
  /** The id of the invoice, bill, payment or deposit. */
  entityId: string;
  /** Invoice or bill number, the payment's check number or reference, the deposit's memo. */
  entityNumber: string | null;
  contactName: string | null;
  amount: string;
  confidence: number; // 0-1
  reason: string;
  reasons: string[];
}

export interface ReconciliationResult {
  transactionId: string;
  suggestions: ReconciliationSuggestion[];
  autoReconciled: boolean;
  reconciledEntityType?: ReconciliationSuggestion['type'];
  reconciledEntityId?: string;
}

/** What matching reads of a bank line; the entity, account, date and check number are optional so older callers keep working. */
export interface MatchableTransaction {
  id: string;
  amount: string;
  counterpartyIban: string | null;
  counterpartyName: string | null;
  reference: string | null;
  description: string | null;
  endToEndId: string | null;
  entityId?: string | null;
  bankAccountId?: string | null;
  date?: Date | string | null;
  checkNumber?: string | null;
}

export interface MatchCandidates {
  invoices: InvoiceRow[];
  bills: BillRow[];
  payments: PaymentRow[];
  deposits: DepositRow[];
  contacts: Map<string, { name: string | null; iban: string | null }>;
}

// ============================================================================
// Candidates
// ============================================================================

/** SQL bounds that keep every row `scoreAmountMatch` could accept: within 2% of the amount. */
function amountBounds(absAmount: number): [number, number] {
  return [Math.max(absAmount * 0.98 - 0.01, 0), absAmount * 1.02 + 0.01];
}

/**
 * The open invoices and bills, unlinked payments and unmatched deposits a
 * bank line could belong to. With `amount` only the rows near it are read
 * (one line); without, every open one is (a batch), up to `limit` per kind.
 */
export async function loadMatchCandidates(
  db: Database,
  args: { entityId?: string | null; bankAccountId?: string | null; amount?: number; checkNumber?: string | null; limit?: number },
): Promise<MatchCandidates> {
  const { invoices, bills, payments, bankDeposits, parties } = tables;
  const limit = args.limit ?? 5000;
  const near = args.amount === undefined ? undefined : amountBounds(args.amount);

  const invoiceWhere: SQL[] = [inArray(invoices.status, ['sent', 'partial', 'overdue']), isNull(invoices.deletedAt)];
  const billWhere: SQL[] = [inArray(bills.status, ['approved', 'partial', 'overdue']), isNull(bills.deletedAt)];
  if (args.entityId) {
    invoiceWhere.push(eq(invoices.entityId, args.entityId));
    billWhere.push(eq(bills.entityId, args.entityId));
  }
  if (near) {
    invoiceWhere.push(between(sql`${invoices.balanceDue}::numeric`, near[0], near[1]));
    billWhere.push(between(sql`${bills.balanceDue}::numeric`, near[0], near[1]));
  }

  const [openInvoices, openBills, unlinkedPayments, openDeposits] = await Promise.all([
    db.select().from(invoices).where(and(...invoiceWhere)).limit(limit),
    db.select().from(bills).where(and(...billWhere)).limit(limit),
    args.entityId ? loadUnlinkedPayments(db, args.entityId, near, args.checkNumber, limit) : Promise.resolve([] as PaymentRow[]),
    args.entityId && args.bankAccountId
      ? db
          .select()
          .from(bankDeposits)
          .where(
            and(
              eq(bankDeposits.entityId, args.entityId),
              eq(bankDeposits.bankAccountId, args.bankAccountId),
              eq(bankDeposits.status, 'posted'),
              isNull(bankDeposits.deletedAt),
              isNull(bankDeposits.bankTransactionId),
              ...(near ? [between(sql`${bankDeposits.amount}::numeric`, near[0], near[1])] : []),
            ),
          )
          .limit(limit)
      : Promise.resolve([] as DepositRow[]),
  ]);

  const contactIds = [
    ...new Set(
      [...openInvoices, ...openBills, ...unlinkedPayments]
        .map((d) => d.contactId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const contactRows =
    contactIds.length > 0
      ? await db
          .select({ id: parties.id, name: parties.displayName, iban: parties.iban })
          .from(parties)
          .where(inArray(parties.id, contactIds))
      : [];

  return {
    invoices: openInvoices,
    bills: openBills,
    payments: unlinkedPayments,
    deposits: openDeposits,
    contacts: new Map(contactRows.map((r) => [r.id, { name: r.name, iban: r.iban }])),
  };
}

function loadUnlinkedPayments(
  db: Database,
  entityId: string,
  near: [number, number] | undefined,
  checkNumber: string | null | undefined,
  limit: number,
): Promise<PaymentRow[]> {
  const { payments } = tables;
  const where: SQL[] = [
    eq(payments.entityId, entityId),
    isNull(payments.deletedAt),
    isNull(payments.bankTransactionId),
    isNull(payments.depositId),
  ];
  if (near) {
    const byAmount = between(sql`${payments.amount}::numeric`, near[0], near[1]);
    where.push(checkNumber ? or(byAmount, eq(payments.checkNumber, checkNumber))! : byAmount);
  }
  return db.select().from(payments).where(and(...where)).limit(limit);
}

// ============================================================================
// Main reconciliation function
// ============================================================================

/**
 * Find matching invoices/bills/payments/deposits for a bank transaction.
 * `candidates` can be passed to match many lines against one load.
 */
export async function findMatches(
  db: Database,
  _schema: unknown,
  transaction: MatchableTransaction,
  candidates?: MatchCandidates,
): Promise<ReconciliationSuggestion[]> {
  const amount = Number.parseFloat(transaction.amount || '0');
  const absAmount = Math.abs(amount);
  if (!amount) return [];

  const pool =
    candidates ??
    (await loadMatchCandidates(db, {
      entityId: transaction.entityId,
      bankAccountId: transaction.bankAccountId,
      amount: absAmount,
      checkNumber: transaction.checkNumber,
    }));

  const suggestions =
    amount > 0
      ? [
          // Credit (money in) → open invoices (receivables), received payments, deposits
          ...matchInvoices(pool, absAmount, transaction),
          ...matchPayments(pool, transaction, absAmount, 'received'),
          ...matchDeposits(pool, transaction, absAmount),
        ]
      : [
          // Debit (money out) → open bills (payables), payments sent
          ...matchBills(pool, absAmount, transaction),
          ...matchPayments(pool, transaction, absAmount, 'sent'),
        ];

  // Sort by confidence descending
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions;
}

/**
 * Auto-reconcile a batch of unreconciled transactions.
 * Only auto-reconciles invoice / bill / payment matches with confidence >= 0.8;
 * an invoice or bill match records and posts a payment
 * (services/accounting-bank-match), so an automatic match settles the
 * document exactly like a manual one, and a payment match links the line to a
 * payment that was already recorded (a printed check clearing the bank). A
 * match that can't be posted (closed period, lock date, draft document) is
 * left as a suggestion.
 */
export async function autoReconcileBatch(
  db: Database,
  schema: any,
  bankAccountId: string,
  userId: string | null,
): Promise<{ reconciledCount: number; results: ReconciliationResult[] }> {
  const { bankTransactions } = schema;

  // Get unreconciled transactions
  const transactions = await db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, bankAccountId),
        eq(bankTransactions.status, 'unreconciled'),
        isNull(bankTransactions.deletedAt),
      ),
    )
    .limit(200);

  const results: ReconciliationResult[] = [];
  let reconciledCount = 0;
  if (transactions.length === 0) return { reconciledCount, results };

  // Everything open for the entity, read once for the whole batch.
  const pool = await loadMatchCandidates(db, { entityId: transactions[0].entityId, bankAccountId });

  for (const txn of transactions) {
    const suggestions = await findMatches(db, schema, txn as MatchableTransaction, pool);
    const bestMatch = suggestions[0];

    const result: ReconciliationResult = {
      transactionId: txn.id,
      suggestions,
      autoReconciled: false,
    };

    const auto = bestMatch && bestMatch.confidence >= 0.8 ? bestMatch : undefined;
    if (auto && (auto.type === 'invoice' || auto.type === 'bill' || auto.type === 'payment')) {
      try {
        if (auto.type === 'payment') {
          await reconcileBankTransactionToPayment(db, {
            txn: txn as BankTransactionRow,
            paymentId: auto.entityId,
            reconciliationType: 'auto',
            userId,
          });
        } else {
          await reconcileBankTransactionToDocument(db, {
            txn: txn as BankTransactionRow,
            type: auto.type,
            documentId: auto.entityId,
            reconciliationType: 'auto',
            userId,
          });
        }
        result.autoReconciled = true;
        result.reconciledEntityType = auto.type;
        result.reconciledEntityId = auto.entityId;
        reconciledCount++;
        // What was just used can't match the next line.
        pool.invoices = pool.invoices.filter((i) => i.id !== auto.entityId);
        pool.bills = pool.bills.filter((b) => b.id !== auto.entityId);
        pool.payments = pool.payments.filter((p) => p.id !== auto.entityId);
      } catch (err) {
        console.warn(`[auto-reconcile] left ${txn.id} as a suggestion:`, err instanceof Error ? err.message : err);
      }
    }

    results.push(result);
  }

  return { reconciledCount, results };
}

// ============================================================================
// Matching helpers
// ============================================================================

/** Score how closely an open balance matches the transaction amount; null when it does not match. */
function scoreAmountMatch(
  balanceDue: number,
  absAmount: number,
): { confidence: number; reason: string } | null {
  if (Math.abs(balanceDue - absAmount) < 0.01) {
    return { confidence: 0.4, reason: 'exact amount match' };
  }
  if (Math.abs(balanceDue - absAmount) / absAmount < 0.02) {
    return { confidence: 0.2, reason: 'close amount match' };
  }
  return null;
}

/** Name similarity of the bank line to a contact, as confidence and a reason. */
function nameMatch(transaction: MatchableTransaction, contactName: string | null | undefined) {
  return nameConfidence(
    nameSimilarity(
      { counterpartyName: transaction.counterpartyName, description: transaction.description ?? transaction.reference },
      contactName,
    ),
  );
}

/**
 * A payment can't come before the invoice it pays, and rarely comes long
 * after it is due: a small bonus inside the window, a small penalty before.
 */
function paymentWindow(
  txnDate: Date | string | null | undefined,
  issueDate: Date | null | undefined,
  dueDate: Date | null | undefined,
): { confidence: number; reason: string } | null {
  if (!txnDate || !issueDate) return null;
  const when = new Date(txnDate).getTime();
  if (when < issueDate.getTime() - 3 * 86_400_000) return { confidence: -0.1, reason: 'dated before the document' };
  const end = (dueDate ?? issueDate).getTime() + 60 * 86_400_000;
  return when <= end ? { confidence: 0.05, reason: 'inside the payment window' } : null;
}

function suggestion(
  type: ReconciliationSuggestion['type'],
  fields: { entityId: string; entityNumber: string | null; contactName: string | null; amount: string },
  confidence: number,
  reasons: string[],
): ReconciliationSuggestion {
  return {
    type,
    ...fields,
    confidence: Math.min(Math.max(confidence, 0), 1),
    reason: reasons.join(', '),
    reasons,
  };
}

function matchInvoices(
  pool: MatchCandidates,
  absAmount: number,
  transaction: MatchableTransaction,
): ReconciliationSuggestion[] {
  const suggestions: ReconciliationSuggestion[] = [];

  for (const inv of pool.invoices) {
    if (transaction.entityId && inv.entityId !== transaction.entityId) continue;
    const balanceDue = Number.parseFloat(inv.balanceDue || '0');

    // Amount match
    const amountScore = scoreAmountMatch(balanceDue, absAmount);
    if (!amountScore) continue; // Skip if amount doesn't match at all
    let confidence = amountScore.confidence;
    const reasons: string[] = [amountScore.reason];

    // Reference / betalingskenmerk match
    const ref = transaction.reference || transaction.description || '';
    if (inv.invoiceNumber && ref.includes(inv.invoiceNumber)) {
      confidence += 0.4;
      reasons.push('invoice number in reference');
    }
    if (transaction.endToEndId && inv.invoiceNumber && transaction.endToEndId.includes(inv.invoiceNumber)) {
      confidence += 0.3;
      reasons.push('invoice number in end-to-end ID');
    }

    // Counterparty IBAN match
    const contact = pool.contacts.get(inv.contactId);
    if (transaction.counterpartyIban && contact?.iban && contact.iban === transaction.counterpartyIban) {
      confidence += 0.3;
      reasons.push('counterparty IBAN matches contact');
    }

    // Counterparty name match
    const contactName = inv.contactName ?? contact?.name ?? null;
    const name = nameMatch(transaction, contactName);
    if (name) {
      confidence += name.confidence;
      reasons.push(`${name.reason} the customer`);
    }

    const window = paymentWindow(transaction.date, inv.issueDate, inv.dueDate);
    if (window) {
      confidence += window.confidence;
      reasons.push(window.reason);
    }

    if (confidence > 0) {
      suggestions.push(
        suggestion(
          'invoice',
          { entityId: inv.id, entityNumber: inv.invoiceNumber, contactName, amount: inv.balanceDue || '0' },
          confidence,
          reasons,
        ),
      );
    }
  }

  return suggestions;
}

function matchBills(
  pool: MatchCandidates,
  absAmount: number,
  transaction: MatchableTransaction,
): ReconciliationSuggestion[] {
  const suggestions: ReconciliationSuggestion[] = [];

  for (const bill of pool.bills) {
    if (transaction.entityId && bill.entityId !== transaction.entityId) continue;
    const balanceDue = Number.parseFloat(bill.balanceDue || '0');

    // Amount match
    const amountScore = scoreAmountMatch(balanceDue, absAmount);
    if (!amountScore) continue;
    let confidence = amountScore.confidence;
    const reasons: string[] = [amountScore.reason];

    // Reference match
    const ref = transaction.reference || transaction.description || '';
    if (bill.externalReference && ref.includes(bill.externalReference)) {
      confidence += 0.4;
      reasons.push('external reference in description');
    }

    // Counterparty IBAN match
    const contact = pool.contacts.get(bill.contactId);
    if (transaction.counterpartyIban && contact?.iban && contact.iban === transaction.counterpartyIban) {
      confidence += 0.3;
      reasons.push('counterparty IBAN matches vendor');
    }

    // Counterparty name match
    const contactName = bill.contactName ?? contact?.name ?? null;
    const name = nameMatch(transaction, contactName);
    if (name) {
      confidence += name.confidence;
      reasons.push(`${name.reason} the vendor`);
    }

    const window = paymentWindow(transaction.date, bill.issueDate, bill.dueDate);
    if (window) {
      confidence += window.confidence;
      reasons.push(window.reason);
    }

    if (confidence > 0) {
      suggestions.push(
        suggestion(
          'bill',
          { entityId: bill.id, entityNumber: bill.billNumber, contactName, amount: bill.balanceDue || '0' },
          confidence,
          reasons,
        ),
      );
    }
  }

  return suggestions;
}

/** Check numbers compare without leading zeros and spaces ("001042" is "1042"). */
function normalizeCheckNumber(value: string | null | undefined): string {
  return (value ?? '').replaceAll(/\s/g, '').replace(/^0+(?=\d)/, '').toLowerCase();
}

/**
 * Payments already recorded and not yet tied to a bank line: a check that
 * was written (or received) and now shows on the statement, or a payment
 * entered by hand before the bank line arrived. Matching them links the two
 * without posting a second payment.
 */
function matchPayments(
  pool: MatchCandidates,
  transaction: MatchableTransaction,
  absAmount: number,
  direction: 'received' | 'sent',
): ReconciliationSuggestion[] {
  if (!transaction.entityId) return [];
  const check = normalizeCheckNumber(transaction.checkNumber);

  const suggestions: ReconciliationSuggestion[] = [];
  for (const payment of pool.payments) {
    if (payment.type !== direction || payment.entityId !== transaction.entityId) continue;
    const amountMatches = Math.abs(Number.parseFloat(payment.amount) - absAmount) < 0.01;
    const checkMatches = Boolean(check) && normalizeCheckNumber(payment.checkNumber) === check;
    if (!amountMatches && !checkMatches) continue;

    const reasons: string[] = [];
    let confidence = 0;
    if (amountMatches) {
      confidence += 0.4;
      reasons.push('exact amount match');
    }
    if (checkMatches) {
      confidence += amountMatches ? 0.5 : 0.3;
      reasons.push(amountMatches ? 'check number matches' : 'check number matches but the amount differs');
    }
    const contactName = pool.contacts.get(payment.contactId)?.name ?? null;
    const name = nameMatch(transaction, contactName);
    if (name) {
      confidence += name.confidence;
      reasons.push(`${name.reason} the payment's contact`);
    }
    if (transaction.date) {
      const gap = daysApart(transaction.date, payment.date);
      if (gap <= 30) {
        confidence += 0.1;
        reasons.push('dates within 30 days');
      } else if (gap > 90) {
        confidence -= 0.1;
      }
    }

    // A matching amount alone can't tell the payment from another one of the same size: cap it below auto-match.
    if (!checkMatches) confidence = Math.min(confidence, 0.75);
    if (confidence > 0) {
      suggestions.push(
        suggestion(
          'payment',
          { entityId: payment.id, entityNumber: payment.checkNumber ?? payment.reference ?? null, contactName, amount: payment.amount },
          confidence,
          reasons,
        ),
      );
    }
  }
  return suggestions;
}

/** Bank deposits whose total equals an incoming bank line; never auto-matched. */
function matchDeposits(
  pool: MatchCandidates,
  transaction: MatchableTransaction,
  absAmount: number,
): ReconciliationSuggestion[] {
  if (!transaction.entityId || !transaction.bankAccountId) return [];
  return pool.deposits
    .filter(
      (d) =>
        d.entityId === transaction.entityId &&
        d.bankAccountId === transaction.bankAccountId &&
        Math.abs(Number.parseFloat(d.amount) - absAmount) < 0.01,
    )
    .map((deposit) => {
      const reasons = ['deposit total matches'];
      let confidence = 0.6;
      if (transaction.date && daysApart(transaction.date, deposit.date) <= 7) {
        confidence += 0.15;
        reasons.push('deposit dated within a week');
      }
      return suggestion(
        'deposit',
        { entityId: deposit.id, entityNumber: deposit.memo ?? null, contactName: null, amount: deposit.amount },
        confidence,
        reasons,
      );
    });
}

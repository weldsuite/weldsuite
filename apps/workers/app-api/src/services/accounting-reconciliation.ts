/**
 * Auto-Reconciliation Engine
 *
 * Matches bank transactions to open invoices/bills by:
 * 1. Exact amount + reference/betalingskenmerk
 * 2. Exact amount + counterparty IBAN match to contact
 * 3. Apply reconciliation rules (conditions → actions)
 *
 * Returns match suggestions with confidence scores.
 */

import { eq, and, isNull, sql, or } from 'drizzle-orm';
import type { Database } from '../db';

// ============================================================================
// Types
// ============================================================================

export interface ReconciliationSuggestion {
  type: 'invoice' | 'bill' | 'rule';
  entityId: string;
  entityNumber: string | null;
  contactName: string | null;
  amount: string;
  confidence: number; // 0-1
  reason: string;
}

export interface ReconciliationResult {
  transactionId: string;
  suggestions: ReconciliationSuggestion[];
  autoReconciled: boolean;
  reconciledEntityType?: 'invoice' | 'bill' | 'rule';
  reconciledEntityId?: string;
}

// ============================================================================
// Main reconciliation function
// ============================================================================

/**
 * Find matching invoices/bills for a bank transaction.
 */
export async function findMatches(
  db: Database,
  schema: any,
  transaction: {
    id: string;
    amount: string;
    counterpartyIban: string | null;
    counterpartyName: string | null;
    reference: string | null;
    description: string | null;
    endToEndId: string | null;
  },
): Promise<ReconciliationSuggestion[]> {
  const amount = parseFloat(transaction.amount || '0');
  const absAmount = Math.abs(amount);
  const suggestions: ReconciliationSuggestion[] = [];

  if (amount > 0) {
    // Credit (money in) → match to open invoices (receivables)
    const invoiceMatches = await matchInvoices(db, schema, absAmount, transaction);
    suggestions.push(...invoiceMatches);
  } else if (amount < 0) {
    // Debit (money out) → match to open bills (payables)
    const billMatches = await matchBills(db, schema, absAmount, transaction);
    suggestions.push(...billMatches);
  }

  // Sort by confidence descending
  suggestions.sort((a, b) => b.confidence - a.confidence);

  return suggestions;
}

/**
 * Auto-reconcile a batch of unreconciled transactions.
 * Only auto-reconciles when confidence >= 0.8.
 */
export async function autoReconcileBatch(
  db: Database,
  schema: any,
  bankAccountId: string,
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

  for (const txn of transactions) {
    const suggestions = await findMatches(db, schema, txn as any);
    const bestMatch = suggestions[0];

    const result: ReconciliationResult = {
      transactionId: txn.id,
      suggestions,
      autoReconciled: false,
    };

    // Auto-reconcile if high confidence
    if (bestMatch && bestMatch.confidence >= 0.8) {
      const updateData: Record<string, unknown> = {
        status: 'reconciled',
        reconciliationType: bestMatch.type === 'rule' ? 'rule' : 'auto',
        updatedAt: new Date(),
      };

      if (bestMatch.type === 'invoice') {
        updateData.reconciledInvoiceId = bestMatch.entityId;
      } else if (bestMatch.type === 'bill') {
        updateData.reconciledBillId = bestMatch.entityId;
      }

      await db
        .update(bankTransactions)
        .set(updateData)
        .where(eq(bankTransactions.id, txn.id));

      result.autoReconciled = true;
      result.reconciledEntityType = bestMatch.type;
      result.reconciledEntityId = bestMatch.entityId;
      reconciledCount++;
    }

    results.push(result);
  }

  return { reconciledCount, results };
}

// ============================================================================
// Matching helpers
// ============================================================================

async function matchInvoices(
  db: Database,
  schema: any,
  absAmount: number,
  transaction: {
    counterpartyIban: string | null;
    counterpartyName: string | null;
    reference: string | null;
    description: string | null;
    endToEndId: string | null;
  },
): Promise<ReconciliationSuggestion[]> {
  const { invoices, parties } = schema;
  const suggestions: ReconciliationSuggestion[] = [];

  // Find open invoices with matching amount
  const openInvoices = await db
    .select()
    .from(invoices)
    .where(
      and(
        or(
          eq(invoices.status, 'sent'),
          eq(invoices.status, 'partial'),
          eq(invoices.status, 'overdue'),
        ),
        isNull(invoices.deletedAt),
      ),
    )
    .limit(100);

  for (const inv of openInvoices) {
    let confidence = 0;
    const reasons: string[] = [];
    const balanceDue = parseFloat(inv.balanceDue || '0');

    // Amount match
    if (Math.abs(balanceDue - absAmount) < 0.01) {
      confidence += 0.4;
      reasons.push('exact amount match');
    } else if (Math.abs(balanceDue - absAmount) / absAmount < 0.02) {
      confidence += 0.2;
      reasons.push('close amount match');
    } else {
      continue; // Skip if amount doesn't match at all
    }

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
    if (transaction.counterpartyIban && inv.contactId) {
      const [contact] = await db
        .select({ iban: parties.iban })
        .from(parties)
        .where(eq(parties.id, inv.contactId))
        .limit(1);
      if (contact?.iban && contact.iban === transaction.counterpartyIban) {
        confidence += 0.3;
        reasons.push('counterparty IBAN matches contact');
      }
    }

    if (confidence > 0) {
      suggestions.push({
        type: 'invoice',
        entityId: inv.id,
        entityNumber: inv.invoiceNumber,
        contactName: inv.contactName,
        amount: inv.balanceDue || '0',
        confidence: Math.min(confidence, 1),
        reason: reasons.join(', '),
      });
    }
  }

  return suggestions;
}

async function matchBills(
  db: Database,
  schema: any,
  absAmount: number,
  transaction: {
    counterpartyIban: string | null;
    counterpartyName: string | null;
    reference: string | null;
    description: string | null;
    endToEndId: string | null;
  },
): Promise<ReconciliationSuggestion[]> {
  const { bills, parties } = schema;
  const suggestions: ReconciliationSuggestion[] = [];

  // Find open bills with matching amount
  const openBills = await db
    .select()
    .from(bills)
    .where(
      and(
        or(
          eq(bills.status, 'approved'),
          eq(bills.status, 'partial'),
          eq(bills.status, 'overdue'),
        ),
        isNull(bills.deletedAt),
      ),
    )
    .limit(100);

  for (const bill of openBills) {
    let confidence = 0;
    const reasons: string[] = [];
    const balanceDue = parseFloat(bill.balanceDue || '0');

    // Amount match
    if (Math.abs(balanceDue - absAmount) < 0.01) {
      confidence += 0.4;
      reasons.push('exact amount match');
    } else if (Math.abs(balanceDue - absAmount) / absAmount < 0.02) {
      confidence += 0.2;
      reasons.push('close amount match');
    } else {
      continue;
    }

    // Reference match
    const ref = transaction.reference || transaction.description || '';
    if (bill.externalReference && ref.includes(bill.externalReference)) {
      confidence += 0.4;
      reasons.push('external reference in description');
    }

    // Counterparty IBAN match
    if (transaction.counterpartyIban && bill.contactId) {
      const [contact] = await db
        .select({ iban: parties.iban })
        .from(parties)
        .where(eq(parties.id, bill.contactId))
        .limit(1);
      if (contact?.iban && contact.iban === transaction.counterpartyIban) {
        confidence += 0.3;
        reasons.push('counterparty IBAN matches vendor');
      }
    }

    // Counterparty name match
    if (transaction.counterpartyName && bill.contactName) {
      const txnName = (transaction.counterpartyName || '').toLowerCase();
      const billContact = (bill.contactName || '').toLowerCase();
      if (txnName.includes(billContact) || billContact.includes(txnName)) {
        confidence += 0.15;
        reasons.push('counterparty name matches vendor');
      }
    }

    if (confidence > 0) {
      suggestions.push({
        type: 'bill',
        entityId: bill.id,
        entityNumber: bill.billNumber,
        contactName: bill.contactName,
        amount: bill.balanceDue || '0',
        confidence: Math.min(confidence, 1),
        reason: reasons.join(', '),
      });
    }
  }

  return suggestions;
}

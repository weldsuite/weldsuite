/**
 * Post a bank statement line to the general ledger without an invoice or bill.
 *
 * Used for money that is not a customer payment or supplier bill: fee refunds,
 * payment-processor settlements, interest, owner deposits, bank charges.
 *
 * Journal (gross = the bank amount):
 *   money in  →  Dr bank ledger (gross)  /  Cr category (net), Cr tax payable (tax)
 *   money out →  Dr category (net), Dr input tax (tax)  /  Cr bank ledger (gross)
 *
 * The tax split only happens when a tax rate is chosen; the bank amount is
 * treated as tax-inclusive. Under the Dutch KOR, and on a US entity (sales tax
 * a supplier charges is never reclaimed), purchase tax is not deductible and
 * stays in the category amount. A US entity's seeded 0% rate splits nothing and
 * writes no tax-ledger row.
 *
 * The bank account's cashbook balance is already updated on import/create.
 * This only posts the GL so P&L, balance sheet and the tax ledger stay in sync.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isKorActive } from '@weldsuite/books-domain/accounting-guards';
import { getAdapter, hasAdapter } from '@weldsuite/books-domain/jurisdictions/registry';
import { accountForRole, loadEntityAccounts, postJournalEntry, roundMoney, type PostingLine, type PostingTaxLine } from './accounting-posting';
import { loadEntity } from './accounting-document-posting';

export class BankCategorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankCategorizeError';
  }
}

export interface CategorizeBankTransactionInput {
  txn: typeof schema.bankTransactions.$inferSelect;
  categoryAccountId: string;
  contactId?: string | null;
  taxRateId?: string | null;
  userId: string | null;
}

export interface CategorizeBankTransactionResult {
  journalEntryId: string;
  entryNumber: string;
}

function bankEntryDescription(description: string | null, moneyIn: boolean, counterparty: string): string {
  if (description) return `Bank: ${description}${counterparty}`;
  return moneyIn ? `Bank receipt${counterparty}` : `Bank payment${counterparty}`;
}

export async function categorizeBankTransaction(
  db: Database,
  args: CategorizeBankTransactionInput,
): Promise<CategorizeBankTransactionResult> {
  const { txn, categoryAccountId, userId } = args;
  const { bankAccounts, bankTransactions } = schema;

  if (txn.status !== 'unreconciled') {
    throw new BankCategorizeError('Transaction is already reconciled or excluded');
  }
  if (txn.journalEntryId) {
    throw new BankCategorizeError('Transaction already has a journal entry');
  }

  const gross = roundMoney(Math.abs(Number(txn.amount)));
  if (!Number.isFinite(gross) || gross === 0) {
    throw new BankCategorizeError('Transaction amount must be non-zero');
  }
  const moneyIn = Number(txn.amount) > 0;

  const [bankAccount] = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, txn.bankAccountId), eq(bankAccounts.entityId, txn.entityId), isNull(bankAccounts.deletedAt)))
    .limit(1);
  if (!bankAccount) {
    throw new BankCategorizeError('Bank account not found');
  }

  const accounts = await loadEntityAccounts(db, txn.entityId);
  const ledger = accounts.byId(bankAccount.ledgerAccountId);
  if (!bankAccount.ledgerAccountId) {
    throw new BankCategorizeError(
      'This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.',
    );
  }
  if (!ledger) {
    throw new BankCategorizeError('Linked ledger account was not found');
  }
  const category = accounts.byId(categoryAccountId);
  if (!category) {
    throw new BankCategorizeError('Category account not found');
  }
  if (category.id === ledger.id) {
    throw new BankCategorizeError('Pick an income or expense account, not the bank ledger account itself');
  }

  const entity = await loadEntity(db, txn.entityId);
  const contactId = args.contactId || txn.contactId || null;
  const currency = bankAccount.currency || entity.baseCurrency;
  const counterparty = txn.counterpartyName ? ` — ${txn.counterpartyName}` : '';
  const description = bankEntryDescription(txn.description, moneyIn, counterparty);
  const meta = { contactId, currency, description };

  let tax = 0;
  let taxLines: PostingTaxLine[] = [];
  let taxAccountId: string | null = null;
  const taxRateId = args.taxRateId || null;
  if (taxRateId) {
    const [rate] = await db
      .select()
      .from(schema.taxRates)
      .where(and(eq(schema.taxRates.id, taxRateId), eq(schema.taxRates.entityId, txn.entityId), isNull(schema.taxRates.deletedAt)))
      .limit(1);
    if (!rate) throw new BankCategorizeError('Tax rate not found for this accounting entity');
    const percent = Number(rate.rate);
    const salesTaxEntity = hasAdapter(entity.jurisdictionCode) && getAdapter(entity.jurisdictionCode).features.salesTax;
    const purchaseIsCost = hasAdapter(entity.jurisdictionCode) && getAdapter(entity.jurisdictionCode).purchaseTax === 'cost';
    const deductible = moneyIn || (!isKorActive(entity, txn.date) && !purchaseIsCost);
    tax = roundMoney((gross * percent) / (100 + percent));
    if (deductible) {
      const direction = moneyIn ? 'sales' : 'purchase';
      // The US chart has no tax_payable / tax_input roles; its sales tax payable is the fallback.
      const taxAccount =
        accounts.byId(rate.ledgerAccountId) ??
        (direction === 'purchase' ? accountForRole(accounts, 'tax_input', ['1730']) : undefined) ??
        accountForRole(accounts, 'tax_payable', ['1700']) ??
        accountForRole(accounts, 'sales_tax_payable');
      // Nothing to book at 0%, so no account is needed.
      if (!taxAccount && tax > 0) throw new BankCategorizeError('No tax account found. Link the tax rate to a ledger account.');
      taxAccountId = taxAccount?.id ?? null;
      if (!(salesTaxEntity && tax === 0)) {
        taxLines = [
          {
            direction,
            taxRateId: rate.id,
            taxRateName: rate.name,
            taxCategoryCode: rate.taxCategoryCode ?? null,
            rate: percent,
            taxableAmount: roundMoney(gross - tax),
            taxAmount: tax,
            currency,
            baseTaxableAmount: roundMoney(gross - tax),
            baseTaxAmount: tax,
            contactId,
          },
        ];
      }
    } else {
      tax = 0; // KOR, US purchase: the whole amount is the cost
    }
  }
  const net = roundMoney(gross - tax);

  const lines: PostingLine[] = moneyIn
    ? [
        { accountId: ledger.id, debit: gross, ...meta },
        { accountId: category.id, credit: net, ...meta },
        ...(taxAccountId && tax > 0 ? [{ accountId: taxAccountId, credit: tax, taxRateId, taxAmount: tax, ...meta }] : []),
      ]
    : [
        { accountId: category.id, debit: net, ...meta },
        ...(taxAccountId && tax > 0 ? [{ accountId: taxAccountId, debit: tax, taxRateId, taxAmount: tax, ...meta }] : []),
        { accountId: ledger.id, credit: gross, ...meta },
      ];

  const now = new Date();
  const posted = await postJournalEntry(db, {
    entityId: txn.entityId,
    date: txn.date,
    description,
    reference: txn.reference || null,
    sourceType: 'bank_transaction',
    sourceId: txn.id,
    // Versioned by the line's last change: a retry finds the same entry, but a
    // line that was unreconciled and is categorized again posts anew.
    postingKey: `bank_transaction:${txn.id}:categorize:${txn.updatedAt.getTime()}`,
    lockKind: 'general',
    lines,
    taxLines,
    createdBy: userId,
    alsoWrite: (h, entry) => [
      h
        .update(bankTransactions)
        .set({
          status: 'reconciled',
          reconciliationType: 'manual',
          categoryAccountId,
          taxRateId,
          journalEntryId: entry.journalEntryId,
          contactId,
          updatedAt: now,
        })
        .where(eq(bankTransactions.id, txn.id)),
    ],
  });

  if (!posted.journalEntryId || !posted.entryNumber) {
    throw new BankCategorizeError('Nothing to post for this transaction');
  }
  return { journalEntryId: posted.journalEntryId, entryNumber: posted.entryNumber };
}
